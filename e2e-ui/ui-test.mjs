// Prueba E2E de la interfaz contra el clúster real + capturas para el manual de usuario.
//
// La interfaz se organiza en secciones (menú lateral, una tarea por sección, ruta en el hash: #/pedidos,
// #/cluster…). La prueba recorre cada sección como lo haría una persona: navega con los botones del menú.
//
// Uso (con el clúster arriba, idealmente recién creado con `docker compose down -v && docker compose up -d --build`):
//   cd e2e-ui && npm install && node ui-test.mjs [carpeta-de-capturas]
// Variables: BASE (por defecto http://localhost:8080), CHROME_PATH (ruta del ejecutable de Chrome/Edge),
// UI_ADMIN_USER / UI_ADMIN_PASSWORD (credenciales del administrador) y UI_CPU_THROTTLE (simula una máquina lenta).
import puppeteer from "puppeteer-core";
import fs from "node:fs";
import path from "node:path";

const BASE = process.env.BASE || "http://localhost:8080";
const OUT = process.argv[2] || path.resolve("../docs/img");
const CHROME =
  process.env.CHROME_PATH ||
  [
    "C:/Program Files/Google/Chrome/Application/chrome.exe",
    "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/usr/bin/google-chrome",
    "/usr/bin/chromium",
  ].find((candidate) => fs.existsSync(candidate));
if (!CHROME) throw new Error("No se encontró Chrome/Edge: define CHROME_PATH");
fs.mkdirSync(OUT, { recursive: true });
const SEED_CUSTOMERS = ["Distribuidora Andina S.A.S.", "Ferretería El Tornillo", "María Fernanda López"];
const ADMIN_USER = process.env.UI_ADMIN_USER || "admin";
const ADMIN_PASSWORD = process.env.UI_ADMIN_PASSWORD || "Admin12345";
const ADMIN_ROUTES = ["resumen", "pedidos", "nuevo", "cluster", "monitoreo", "usuarios", "correcciones", "auditoria"];
const CLIENT_ROUTES = ["pedidos", "nuevo", "conexion"];

const results = [];
const check = (name, ok, extra = "") => {
  results.push({ name, ok: Boolean(ok) });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${extra ? `  -> ${extra}` : ""}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: true,
  args: ["--no-sandbox", "--disable-dev-shm-usage", "--hide-scrollbars"],
  defaultViewport: { width: 1440, height: 1000 },
});
const page = await browser.newPage();
// UI_CPU_THROTTLE=4 simula una máquina 4 veces más lenta (útil para reproducir problemas de tiempos de CI).
if (process.env.UI_CPU_THROTTLE) await page.emulateCPUThrottling(Number(process.env.UI_CPU_THROTTLE));
const pageErrors = [];
page.on("pageerror", (e) => pageErrors.push(e.message));
// El navegador registra en consola el 401 del login fallido que la prueba provoca a propósito;
// se tolera exactamente ese (expectedUnauthorized) y cualquier otro error cuenta como fallo.
let expectedUnauthorized = 0;
page.on("console", (m) => {
  if (m.type() !== "error") return;
  if (expectedUnauthorized > 0 && /status of 401/.test(m.text())) {
    expectedUnauthorized -= 1;
    return;
  }
  // Aviso del navegador (no de la app): sobre HTTP sin TLS fuera de localhost, Chrome ignora la cabecera
  // Cross-Origin-Opener-Policy. Con HTTPS (Coolify + Traefik) o en localhost sí se aplica.
  if (/Cross-Origin-Opener-Policy header has been ignored/.test(m.text())) return;
  const url = m.location()?.url;
  pageErrors.push(url ? `${m.text()} [${url.replace(BASE, "")}]` : m.text());
});

const shot = async (name, selector, { keepToasts = false } = {}) => {
  const file = path.join(OUT, name);
  // Captura limpia: barra superior y menú no fijos, sin foco en inputs y (opcional) sin toasts.
  // (Vía CSSOM y no con <style>: la Content-Security-Policy del sitio bloquea estilos en línea.)
  await page.evaluate((keepToasts) => {
    const topbar = document.querySelector(".topbar");
    if (topbar) topbar.style.position = "static";
    const sidebar = document.querySelector(".sidebar");
    if (sidebar && getComputedStyle(sidebar).flexDirection === "column") {
      Object.assign(sidebar.style, { position: "static", height: "auto", alignSelf: "stretch" });
    }
    document.activeElement?.blur();
    if (!keepToasts) document.querySelectorAll(".toast .icon-btn").forEach((b) => b.click());
    window.scrollTo(0, 0);
  }, keepToasts);
  await sleep(250);
  if (selector) await (await page.$(selector)).screenshot({ path: file });
  else await page.screenshot({ path: file, fullPage: true });
  console.log(`      📸 ${name}`);
};
const text = (selector) => page.$eval(selector, (el) => el.textContent.trim()).catch(() => "");
const exists = async (selector) => Boolean(await page.$(selector));
const customers = () => page.$$eval("tbody tr .customer", (els) => els.map((e) => e.textContent));
const waitText = (selector, needle, timeout = 10000) =>
  page.waitForFunction(
    (s, n) => [...document.querySelectorAll(s)].some((el) => el.textContent.includes(n)),
    { timeout },
    selector,
    needle,
  );
const clickButton = async (label, scope = "body") => {
  const ok = await page.evaluate(
    (label, scope) => {
      const btn = [...document.querySelector(scope).querySelectorAll("button")].find(
        (b) => b.textContent.trim().includes(label) && !b.disabled,
      );
      btn?.click();
      return Boolean(btn);
    },
    label,
    scope,
  );
  if (!ok) throw new Error(`Botón no encontrado: "${label}" en ${scope}`);
};
const clickInTile = (tileText, label) =>
  page.evaluate(
    (tileText, label) => {
      const tile = [...document.querySelectorAll(".tile")].find((t) => t.textContent.includes(tileText));
      const btn = tile && [...tile.querySelectorAll("button")].find((b) => b.textContent.includes(label));
      btn?.click();
      return Boolean(btn);
    },
    tileText,
    label,
  );
const clickInRow = (customer, label) =>
  page.evaluate(
    (customer, label) => {
      const row = [...document.querySelectorAll("tbody tr")].find(
        (r) => r.querySelector(".customer")?.textContent === customer,
      );
      const btn = row && [...row.querySelectorAll("button")].find((b) => b.textContent.includes(label));
      btn?.click();
      return Boolean(btn);
    },
    customer,
    label,
  );
const rowStatus = (customer) =>
  page.evaluate((customer) => {
    const row = [...document.querySelectorAll("tbody tr")].find((r) => r.querySelector(".customer")?.textContent === customer);
    return row?.querySelector(".status")?.textContent ?? null;
  }, customer);
const waitIdle = (label) =>
  page.waitForFunction(
    (label) => [...document.querySelectorAll("button")].some((b) => b.textContent.includes(label) && !b.disabled),
    { timeout: 20000 },
    label,
  );

// ------------------------------------------------------------------ navegación
const currentRoute = () => page.$eval("main.content", (m) => m.dataset.route).catch(() => null);
const navRoutes = () => page.$$eval(".sidebar .nav-item", (els) => els.map((e) => e.dataset.route));
async function go(route) {
  await page.click(`.nav-item[data-route="${route}"]`);
  await page.waitForSelector(`main.content[data-route="${route}"]`, { timeout: 10000 });
}
// Número de pedidos que muestra el menú junto a "Pedidos" (se actualiza al crear/eliminar).
const ordersBadge = () =>
  page.$eval('.nav-item[data-route="pedidos"] .nav-badge', (b) => Number(b.textContent)).catch(() => 0);

// ------------------------------------------------------------------ pedidos
async function fillOrder(customer, items) {
  await page.click(".order-form .field input", { clickCount: 3 });
  await page.type(".order-form .field input", customer);
  for (let i = 0; i < items.length; i += 1) {
    if (i > 0) await clickButton("+ Agregar ítem", ".order-form");
    const rows = await page.$$(".order-form .item-row");
    const [product, qty, price] = await rows[i].$$("input");
    await product.type(items[i][0]);
    await qty.click({ clickCount: 3 });
    await qty.type(String(items[i][1]));
    await price.click({ clickCount: 3 });
    await price.type(String(items[i][2]));
  }
}
// Envía el formulario (sección "Nuevo pedido") y espera a que el menú cuente un pedido más y a que
// el panel "Última petición" muestre la respuesta (robusto ante nombres repetidos).
async function submitNewOrder() {
  const before = await ordersBadge();
  const lastId = await page.$eval(".last-request", (el) => el.dataset.requestId).catch(() => "");
  await clickButton("Crear pedido", ".order-form");
  await page.waitForFunction(
    (n, id) =>
      Number(document.querySelector('.nav-item[data-route="pedidos"] .nav-badge')?.textContent ?? 0) > n &&
      document.querySelector(".last-request")?.dataset.requestId !== id,
    { timeout: 10000 },
    before,
    lastId,
  );
  await waitIdle("Crear pedido");
}
async function createOrder(customer, items) {
  if ((await currentRoute()) !== "nuevo") await go("nuevo");
  await fillOrder(customer, items);
  await submitNewOrder();
}
// Se espera al estado esperado (con límite) en lugar de pausas fijas: en CI la red es más lenta.
async function advanceTo(customer, button, expected) {
  await page.waitForFunction(
    (c, b) => [...document.querySelectorAll("tbody tr")].some((r) =>
      r.querySelector(".customer")?.textContent === c &&
      [...r.querySelectorAll("button")].some((x) => x.textContent.includes(b) && !x.disabled)),
    { timeout: 10000 }, customer, button,
  );
  await clickInRow(customer, button);
  await page
    .waitForFunction(
      (c, e) => [...document.querySelectorAll("tbody tr")].find((r) => r.querySelector(".customer")?.textContent === c)
        ?.querySelector(".status")?.textContent === e,
      { timeout: 10000 }, customer, expected,
    )
    .catch(() => {});
  return (await rowStatus(customer)) === expected;
}
async function deleteRow(name) {
  await clickInRow(name, "Eliminar");
  await clickInRow(name, "¿Confirmar?");
  await page.waitForFunction((n) => ![...document.querySelectorAll("tbody .customer")].some((e) => e.textContent === n), { timeout: 8000 }, name);
}

async function fillLogin(username, password) {
  const inputs = await page.$$(".login-card input");
  await inputs[0].click({ clickCount: 3 });
  await inputs[0].type(username);
  const passwordInput = await page.$('.login-card input[type="password"]');
  await passwordInput.click({ clickCount: 3 });
  await passwordInput.type(password);
}

try {
  // ------------------------------------------------------------------ inicio de sesión
  await page.goto(BASE, { waitUntil: "networkidle0" });
  await page.evaluate(() => {
    localStorage.clear();
    window.location.hash = "";
  });
  await page.reload({ waitUntil: "networkidle0" });
  await page.waitForSelector(".login-card");
  check("Sin sesión se muestra la pantalla de inicio de sesión", await exists(".login-card"));
  await shot("00_inicio_sesion.png");
  expectedUnauthorized = 1;
  await fillLogin(ADMIN_USER, "contraseña-incorrecta-1");
  await clickButton("Entrar", ".login-card");
  await waitText(".login-card .form-error", "incorrectos");
  check("Login con contraseña incorrecta muestra error genérico", true);
  await fillLogin(ADMIN_USER, ADMIN_PASSWORD);
  await clickButton("Entrar", ".login-card");
  await page.waitForSelector(".role-badge");
  check("Login de administrador abre el panel completo", (await text(".role-badge")) === "Administrador");

  // ------------------------------------------------------------------ menú y sección Resumen
  await page.waitForSelector("main.content");
  check("El administrador entra a la sección Resumen", (await currentRoute()) === "resumen");
  const adminNav = await navRoutes();
  check("Menú del administrador: una sección por tarea", JSON.stringify(adminNav) === JSON.stringify(ADMIN_ROUTES), adminNav.join(", "));
  check(
    "El menú marca la sección actual (aria-current) y la refleja en la URL",
    (await page.$eval('.nav-item[aria-current="page"]', (b) => b.dataset.route)) === "resumen" &&
      (await page.evaluate(() => window.location.hash)) === "#/resumen",
  );
  await page.waitForFunction(
    () => [...document.querySelectorAll(".stat-tile")].some((t) => t.textContent.includes("Nodos operativos") && t.textContent.includes("2 / 2")),
    { timeout: 15000 },
  );
  check("Resumen: indicador de nodos operativos (2 / 2)", true);
  const summaryTiles = await page.$$eval(".stat-tile", (els) => els.map((e) => e.textContent));
  check("Resumen: base primaria operativa", summaryTiles.some((t) => t.includes("Base de datos primaria") && t.includes("Operativa")));
  await page.waitForSelector('.topo-node[data-node="alpha"].topo-up', { timeout: 10000 });
  check(
    "Resumen: la topología dibuja gateway, ambos nodos y ambas bases operativas",
    (await exists('.topo-node[data-node="gateway"]')) &&
      (await exists('.topo-node[data-node="beta"].topo-up')) &&
      (await exists('.topo-node[data-node="primary"].topo-up')) &&
      (await exists('.topo-node[data-node="replica"].topo-up')),
  );
  check("Resumen: no mezcla formularios ni tablas de otras secciones", !(await exists(".order-form")) && !(await exists("table")));
  await sleep(1500);
  await shot("01_dashboard.png");

  // ------------------------------------------------------------------ sección Pedidos
  await go("pedidos");
  await page.waitForSelector("tbody .customer");
  const initial = await customers();
  check("Pedidos: carga los 3 pedidos de ejemplo de init.sql", SEED_CUSTOMERS.every((c) => initial.includes(c)), initial.join(" | "));
  check("Pedidos: la sección sólo muestra la tabla (sin formulario ni controles de caos)", !(await exists(".order-form")) && !(await exists(".cluster")));
  const badgeStart = await ordersBadge();

  // ------------------------------------------------------------------ sección Nuevo pedido
  await clickButton("Nuevo pedido", ".page-header");
  await page.waitForSelector('main.content[data-route="nuevo"]');
  check("El botón 'Nuevo pedido' de la cabecera lleva a su sección", true);
  await fillOrder("Logística Express S.A.S.", [
    ["Caja corrugada 60x40", 20, 4.75],
    ["Film stretch 50 cm", 5, 12.9],
  ]);
  check("Formulario calcula el total estimado (20×4,75 + 5×12,90)", (await text(".form-total strong")) === "$ 159,50", await text(".form-total strong"));
  await shot("02_formulario_nuevo_pedido.png", ".order-form");
  await submitNewOrder();
  const lastNode = await text(".last-request .node-chip");
  check("Nuevo pedido: 'Última petición' muestra el nodo que atendió", /Nodo-(Alpha-01|Beta-02)/.test(lastNode), lastNode);
  check("Nuevo pedido: 'Última petición' muestra BD Primary", (await text(".last-request .db-chip")) === "Primary");
  await createOrder("Supermercado La Economía", [["Arroz 5 kg", 12, 8.4]]);
  await createOrder("Clínica San Rafael", [["Guantes de nitrilo (caja)", 30, 6.2]]);
  check("El menú cuenta los pedidos creados (+3)", (await ordersBadge()) === badgeStart + 3, `${badgeStart} → ${await ordersBadge()}`);

  // ------------------------------------------------------------------ cambio de estado
  await go("pedidos");
  await page.waitForFunction(() => [...document.querySelectorAll("tbody .customer")].some((e) => e.textContent === "Clínica San Rafael"), { timeout: 10000 });
  check("Pedido creado aparece en la tabla como Pendiente", (await rowStatus("Logística Express S.A.S.")) === "Pendiente");
  check("Avanzar estado: pendiente → en proceso", await advanceTo("Supermercado La Economía", "→ En proceso", "En proceso"));
  await advanceTo("Logística Express S.A.S.", "→ En proceso", "En proceso");
  check("Avanzar estado: en proceso → enviado", await advanceTo("Logística Express S.A.S.", "→ Enviado", "Enviado"));
  check("Avanzar estado: enviado → entregado (fin del ciclo)", await advanceTo("María Fernanda López", "→ Entregado", "Entregado"));

  // Regresión: una recarga de la lista que leyó la BD ANTES de un cambio y responde DESPUÉS no debe
  // devolver el pedido a su estado anterior (defecto encontrado en CI). Se retrasa a propósito la
  // respuesta de los GET de la lista con el protocolo de depuración de Chrome: quedan en vuelo la
  // recarga que sigue a "Crear pedido" y la que dispara entrar a la sección Pedidos.
  const cdp = await page.createCDPSession();
  await cdp.send("Fetch.enable", { patterns: [{ urlPattern: "*/api/orders*", requestStage: "Response" }] });
  cdp.on("Fetch.requestPaused", async (event) => {
    if (event.request.method === "GET" && /\/api\/orders(\?|$)/.test(event.request.url)) await sleep(1500);
    await cdp.send("Fetch.continueResponse", { requestId: event.requestId }).catch(() => {});
  });
  await createOrder("Pedido con recarga lenta", [["Cinta", 2, 3]]);
  await go("pedidos");
  await advanceTo("Pedido con recarga lenta", "→ En proceso", "En proceso"); // las recargas lentas siguen en vuelo
  await sleep(2500);
  check(
    "Una recarga lenta de la lista no revierte un cambio de estado",
    (await rowStatus("Pedido con recarga lenta")) === "En proceso",
    await rowStatus("Pedido con recarga lenta"),
  );
  await cdp.send("Fetch.disable");
  await cdp.detach();
  await sleep(300);
  await deleteRow("Pedido con recarga lenta");

  // ------------------------------------------------------------------ editar (ventana de diálogo)
  await clickInRow("Clínica San Rafael", "Editar");
  await page.waitForSelector(".dialog .order-form");
  check("Editar abre una ventana sobre la tabla (sin cambiar de sección)", (await currentRoute()) === "pedidos");
  const qty = (await page.$$(".dialog .order-form .item-row input"))[1];
  await qty.click({ clickCount: 3 });
  await qty.type("40");
  await clickButton("Guardar cambios", ".dialog");
  await page.waitForFunction(() => !document.querySelector(".dialog"), { timeout: 10000 });
  await page
    .waitForFunction(
      () => [...document.querySelectorAll("tbody tr")].find((r) => r.textContent.includes("Clínica San Rafael"))?.querySelector("td.num")?.textContent === "$ 248,00",
      { timeout: 8000 },
    )
    .catch(() => {});
  const editedTotal = await page.evaluate(() => {
    const row = [...document.querySelectorAll("tbody tr")].find((r) => r.textContent.includes("Clínica San Rafael"));
    return row?.querySelector("td.num")?.textContent;
  });
  check("Editar pedido pendiente: total recalculado (40×6,20)", editedTotal === "$ 248,00", editedTotal);

  // ------------------------------------------------------------------ filtros y búsqueda
  await clickButton("En proceso", ".chips");
  await sleep(300);
  const filtered = await customers();
  check("Filtro por estado 'En proceso'", filtered.length > 0 && (await page.$$eval("tbody .status", (els) => els.every((e) => e.textContent === "En proceso"))), filtered.join(" | "));
  await shot("08_filtros.png", ".orders");
  await clickButton("Todos", ".chips");
  await page.type(".search", "clínica");
  await sleep(300);
  const searched = await customers();
  check("Búsqueda por cliente ('clínica')", searched.length >= 1 && searched.every((c) => c === "Clínica San Rafael"), searched.join(" | "));
  await page.click(".search", { clickCount: 3 });
  await page.keyboard.press("Backspace");

  // ------------------------------------------------------------------ sección Clúster y caos: balanceo
  await go("cluster");
  await page.waitForFunction(() => [...document.querySelectorAll(".tile")].filter((t) => t.textContent.includes("Operativo")).length === 2, { timeout: 10000 });
  check("Clúster: sección con topología, controles de caos y registro de peticiones", (await exists(".topology")) && (await exists(".cluster")) && (await exists(".log")));
  await clickButton("Probar balanceo");
  await waitIdle("Probar balanceo");
  const cells = await page.$$eval(".balance-cell", (els) => els.map((e) => e.textContent));
  check("Probar balanceo: 6 respuestas repartidas entre α y β", cells.length === 6 && cells.includes("α") && cells.includes("β"), cells.join(""));
  check("Topología: resalta el camino de la última petición", await exists('.topo-edge.is-path[data-edge="clients-gateway"]'));
  await sleep(3200);
  await shot("03_estado_cluster_normal.png");

  // ------------------------------------------------------------------ caída de nodo
  check("Clic en 'Simular Caída de Nodo' (Alpha)", await clickInTile("Nodo-Alpha-01", "Simular Caída de Nodo"));
  await waitText(".tile", "Caída simulada (503)");
  await page.waitForSelector('.topo-node[data-node="alpha"].topo-crash', { timeout: 10000 });
  check(
    "Topología: Alpha en rojo y su enlace con el gateway cortado",
    await exists('.topo-edge.is-down[data-edge="gateway-alpha"]'),
  );
  check("El menú avisa con '!' que el clúster está degradado", (await text('.nav-item[data-route="cluster"] .nav-badge')) === "!");
  await clickButton("Probar balanceo");
  await waitIdle("Probar balanceo");
  const cellsDown = await page.$$eval(".balance-cell", (els) => els.map((e) => e.textContent));
  check("Con Alpha caído, las 6 peticiones las atiende Beta (sin errores)", cellsDown.length === 6 && cellsDown.every((c) => c === "β"), cellsDown.join(""));
  const retries = await page.$$eval(".log-table .retry", (els) => els.map((e) => e.textContent));
  check("El registro evidencia el reintento de NGINX (503 → 200)", retries.some((r) => r.includes("503") && r.includes("200")), retries.join(" | "));
  await createOrder("Pedido con nodo caído", [["Etiqueta térmica", 100, 0.15]]);
  check("Crear pedido con un nodo caído funciona (lo atiende Beta)", (await text(".last-request .node-chip")) === "Nodo-Beta-02");
  await go("cluster");
  await sleep(3200);
  await shot("04_caida_de_nodo.png");
  await shot("05_registro_peticiones_failover.png", ".log");
  check("Clic en 'Restaurar nodo'", await clickInTile("Nodo-Alpha-01", "Restaurar nodo"));
  await page.waitForFunction(() => [...document.querySelectorAll(".tile")].filter((t) => t.textContent.includes("Operativo")).length === 2, { timeout: 10000 });
  await page.waitForSelector('.topo-node[data-node="alpha"].topo-up', { timeout: 10000 });
  check("Nodo Alpha vuelve a Operativo (también en la topología)", true);

  // ------------------------------------------------------------------ caída de BD primaria
  await clickButton("Simular Caída de BD Primaria");
  await waitText(".tile", "Caída simulada");
  await page.waitForFunction(() => document.querySelectorAll('.topo-edge.is-failover[data-edge$="-replica"]').length === 2, { timeout: 10000 });
  check("Topología: con db-primary caída, los nodos apuntan a la réplica", await exists('.topo-node[data-node="primary"].topo-simulated_down'));
  await createOrder("Pedido con BD primaria caída", [["Pallet de madera", 4, 18]]);
  check("Con db-primary caída, el pedido se guarda en 'Replica Failover'", (await text(".last-request .db-chip")) === "Replica Failover");
  check("Se muestra el aviso de failover de BD", (await text(".last-request .callout-amber")).includes("db-replica"));
  await go("cluster");
  check("Topología: el último recorrido termina en db-replica", await exists('.topo-edge.is-path[data-edge$="-replica"]'));
  await sleep(3200);
  await shot("06_failover_bd_primaria.png");

  await clickButton("Restaurar BD Primaria");
  await waitText(".toast", "reconciliación");
  const toast = await page.$$eval(".toast", (els) => els.map((e) => e.textContent).join(" | "));
  check(
    "Al restaurar, la reconciliación copia el pedido (y su auditoría) réplica → primaria",
    toast.includes("1 pedido(s)") && toast.includes("registro(s) de auditoría"),
    toast,
  );
  await waitText(".sync-line", "Réplica en sincronía", 12000);
  check("Panel indica 'Réplica en sincronía'", true);
  await shot("07_reconciliacion.png", ".cluster");

  // ------------------------------------------------------------------ sección Monitoreo (desde los accesos rápidos)
  await go("resumen");
  await clickButton("Monitoreo", ".shortcuts");
  await page.waitForSelector('main.content[data-route="monitoreo"]');
  check("Los accesos rápidos del Resumen llevan a su sección", true);
  await page.waitForFunction(() => document.querySelectorAll(".node-card").length >= 2, { timeout: 15000 });
  await sleep(3500); // un ciclo de actualización
  const nodeCards = await page.$$eval(".node-card", (els) => els.map((e) => e.textContent));
  check(
    "Monitoreo: tarjeta por nodo, ambos operativos",
    nodeCards.length === 2 && nodeCards.every((t) => t.includes("Operativo")),
    `${nodeCards.length} tarjetas`,
  );
  const statTiles = await page.$$eval(".stat-tile", (els) => els.map((e) => e.textContent));
  check("Monitoreo: indicadores del clúster (2 / 2 nodos)", statTiles.length === 6 && statTiles[0].includes("2 / 2"), statTiles[0]);
  const linePaths = await page.$$eval(".chart-svg path", (els) => els.filter((p) => (p.getAttribute("d") || "").length > 10).length);
  check("Monitoreo: gráficos con una línea por nodo", linePaths >= 3, `${linePaths} trazos`);
  const svgBox = await (await page.$(".chart-svg")).boundingBox();
  await page.mouse.move(svgBox.x + svgBox.width - 80, svgBox.y + svgBox.height / 2);
  await page.waitForSelector(".chart-tooltip", { timeout: 5000 });
  check("Monitoreo: el tooltip de la cruz de lectura muestra ambos nodos", (await page.$$(".chart-tooltip .tt-row")).length === 2);
  await page.mouse.move(0, 0);
  const eventKinds = await page.$$eval(".events-table .level", (els) => els.map((e) => e.textContent));
  check(
    "Monitoreo: eventos de caos y de failover de BD",
    eventKinds.some((k) => k.includes("Caos")) && eventKinds.some((k) => k.includes("Failover BD")),
    `${eventKinds.length} eventos`,
  );
  check("Monitoreo: el gateway reporta conexiones", (await text(".infra-grid .card:first-child .metrics-grid")).includes("Conexiones activas"));
  await shot("11_monitoreo.png");
  await clickButton("Ver tabla", ".chart-card");
  const tableRows = await page.$$eval(".chart-table tbody tr", (rows) => rows.length);
  check("Monitoreo: cada gráfico tiene vista de tabla", tableRows >= 30, `${tableRows} filas`);
  await clickButton("Ver gráfico", ".chart-card");

  // ------------------------------------------------------------------ eliminación
  await go("pedidos");
  await page.waitForSelector("tbody .customer");
  for (const name of ["Pedido con nodo caído", "Pedido con BD primaria caída"]) await deleteRow(name);
  check("Eliminar pedidos con confirmación en dos pasos", !(await customers()).some((c) => c.startsWith("Pedido con")));

  // ------------------------------------------------------------------ cliente (rol user)
  await clickButton("Cerrar sesión");
  await page.waitForSelector(".login-card");
  check("Cerrar sesión vuelve a la pantalla de inicio", true);
  const clientUser = `cliente.${Date.now().toString(36)}`;
  await clickButton("Crear cuenta", ".login-tabs");
  const registerInputs = await page.$$(".login-card input");
  await registerInputs[0].type(clientUser);
  await registerInputs[1].type("Camila Rojas");
  await registerInputs[2].type("Cliente2026");
  await registerInputs[3].type("Cliente2026");
  await page.click(".login-card button[type=submit]");
  await page.waitForSelector(".role-badge");
  check("Registro de cliente inicia sesión con rol Cliente", (await text(".role-badge")) === "Cliente");
  await page.waitForSelector('main.content[data-route="pedidos"]');
  await page.waitForFunction(() => document.querySelector("#orders-title")?.textContent === "Tus pedidos");
  const clientNav = await navRoutes();
  check("Menú del cliente: sólo sus pedidos, nuevo pedido y su conexión", JSON.stringify(clientNav) === JSON.stringify(CLIENT_ROUTES), clientNav.join(", "));
  check("El cliente no ve los pedidos de otros", (await customers()).length === 0);
  await page.evaluate(() => {
    window.location.hash = "/cluster";
  });
  await sleep(400);
  check(
    "Una ruta de administrador escrita a mano no se abre para el cliente",
    (await currentRoute()) === "pedidos" && !(await exists(".cluster")) && (await page.evaluate(() => window.location.hash)) === "#/pedidos",
  );
  check("El cliente no ve controles de caos ni de bases de datos", !(await page.$$eval("button", (bs) => bs.some((b) => /Simular|Restaurar|Sincronizar/.test(b.textContent)))));
  await go("nuevo");
  check("El formulario propone el nombre del cliente", (await page.$eval(".order-form .field input", (i) => i.value)) === "Camila Rojas");
  await fillOrder("", [["Sillas plegables", 6, 22.5]]);
  await submitNewOrder();
  await go("pedidos");
  await page.waitForSelector("tbody .customer");
  const clientRows = await customers();
  check("El cliente crea un pedido y sólo ve el suyo", clientRows.length === 1 && clientRows[0] === "Camila Rojas", clientRows.join(" | "));
  check("El cliente no puede avanzar estados (sin botón →)", !(await page.$$eval("tbody button", (bs) => bs.some((b) => b.textContent.startsWith("→")))));
  check("El cliente puede cancelar su pedido pendiente", await page.$$eval("tbody button", (bs) => bs.some((b) => b.textContent === "Cancelar pedido")));
  await sleep(500);
  await shot("10_vista_cliente.png");
  await go("conexion");
  check("Mi conexión: muestra el nodo que atendió la última petición", /Nodo-(Alpha-01|Beta-02)/.test(await text(".last-request .node-chip")));
  check(
    "Mi conexión: topología con el recorrido de la petición (sin datos internos del clúster)",
    (await exists(".topology--client")) && (await exists('.topo-edge.is-path[data-edge="clients-gateway"]')) && !(await exists(".topo-node.topo-up")),
  );
  await sleep(1200);
  await shot("14_mi_conexion.png");

  // ------------------------------------------------------------------ vista móvil (cliente)
  await go("pedidos");
  await page.setViewport({ width: 390, height: 844, isMobile: true, deviceScaleFactor: 2 });
  await page.waitForSelector('main.content[data-route="pedidos"] tbody .customer');
  await page.waitForNetworkIdle({ idleTime: 500, timeout: 15000 });
  await page.evaluate(() => {
    document.querySelectorAll(".toast .icon-btn").forEach((b) => b.click());
    window.scrollTo(0, 0);
  });
  await sleep(300);
  check("Vista móvil sin desplazamiento horizontal", await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1));
  await page.screenshot({ path: path.join(OUT, "09_vista_movil.png") });
  console.log("      📸 09_vista_movil.png");

  // ------------------------------------------------------------------ administración de datos (admin)
  // Cambiar isMobile hace que Puppeteer recargue la página: se espera a que la app termine de arrancar
  // (sus primeras peticiones) antes de cerrar sesión.
  await page.setViewport({ width: 1440, height: 1000 });
  await page.waitForSelector(".role-badge");
  await page.waitForNetworkIdle({ idleTime: 500, timeout: 15000 });
  await clickButton("Cerrar sesión");
  await page.waitForSelector(".login-card");
  await fillLogin(ADMIN_USER, ADMIN_PASSWORD);
  await clickButton("Entrar", ".login-card");
  await page.waitForSelector(".role-badge");
  await go("usuarios");
  const clientRow = `tr[data-username="${clientUser}"]`;
  await page.waitForSelector(clientRow, { timeout: 10000 });
  const clientOrders = await page.$eval(`${clientRow} td.num`, (td) => td.textContent.trim());
  check("Usuarios: lista de usuarios con sus pedidos", clientOrders === "1", `${clientUser}: ${clientOrders} pedido(s)`);
  const selfButtons = await page.$$eval(`tr[data-username="${ADMIN_USER}"] button`, (bs) =>
    bs.filter((b) => /Desactivar|Eliminar/.test(b.textContent)).map((b) => b.disabled),
  );
  check("Usuarios: el admin no puede desactivarse ni eliminarse", selfButtons.length === 2 && selfButtons.every(Boolean));

  const clickInSelector = (selector, label) =>
    page.evaluate(
      (selector, label) => {
        const btn = [...document.querySelectorAll(`${selector} button`)].find((b) => b.textContent.trim() === label && !b.disabled);
        btn?.click();
        return Boolean(btn);
      },
      selector,
      label,
    );
  await clickInSelector(clientRow, "Editar");
  await page.waitForSelector(".dialog");
  const nameInput = await page.$(".dialog .field input");
  await nameInput.click({ clickCount: 3 });
  await nameInput.type("Camila Rojas Pérez");
  await clickButton("Guardar cambios", ".dialog");
  await page.waitForFunction((sel) => document.querySelector(sel)?.textContent.includes("Camila Rojas Pérez"), { timeout: 10000 }, clientRow);
  check("Usuarios: editar el nombre de un usuario", true);
  await clickInSelector(clientRow, "Desactivar");
  await page.waitForFunction((sel) => document.querySelector(sel)?.textContent.includes("Desactivada"), { timeout: 10000 }, clientRow);
  check("Usuarios: desactivar una cuenta", true);
  await sleep(400);
  await shot("12_administracion_usuarios.png");

  await go("correcciones");
  const deliveredRow = 'tr[data-customer="María Fernanda López"]';
  await page.waitForSelector(deliveredRow, { timeout: 10000 });
  await clickInSelector(deliveredRow, "Corregir");
  await page.waitForSelector(".dialog select");
  await page.select(".dialog select", "enviado");
  await clickButton("Guardar corrección", ".dialog");
  await page.waitForFunction((sel) => document.querySelector(`${sel} .status`)?.textContent === "Enviado", { timeout: 10000 }, deliveredRow);
  check("Correcciones: un pedido entregado puede volver a un estado anterior", true);
  const deletedRow = 'tr[data-customer="Pedido con nodo caído"]';
  await page.waitForSelector(deletedRow, { timeout: 10000 });
  await clickInSelector(deletedRow, "Restaurar");
  await page.waitForFunction((sel) => !document.querySelector(sel)?.classList.contains("row-deleted"), { timeout: 10000 }, deletedRow);
  check("Correcciones: restaurar un pedido eliminado", true);

  await go("auditoria");
  await page.waitForFunction(() => document.querySelectorAll(".audit-table tbody tr").length > 5, { timeout: 10000 });
  const auditActions = await page.$$eval(".audit-table tbody tr", (rows) =>
    rows.map((r) => `${r.children[1].textContent}|${r.children[2].textContent}`),
  );
  const expected = ["admin|Restauró pedido", "admin|Corrección admin", "admin|Desactivó cuenta", "admin|Editó usuario", `${clientUser}|Creó pedido`, `${clientUser}|Registro`];
  check(
    "Auditoría: registra quién hizo cada cambio",
    expected.every((e) => auditActions.includes(e)),
    `${auditActions.length} registros`,
  );
  await shot("13_auditoria.png");
} catch (error) {
  check(`Ejecución sin excepciones`, false, error.message);
  await page.screenshot({ path: path.join(OUT, "_error.png"), fullPage: true });
} finally {
  check("Sin errores de JavaScript en la consola", pageErrors.length === 0, pageErrors.join(" | "));
  await browser.close();
  const failed = results.filter((r) => !r.ok).length;
  console.log(`\nRESULTADO UI: ${results.length - failed}/${results.length} verificaciones OK`);
  process.exitCode = failed ? 1 : 0;
}
