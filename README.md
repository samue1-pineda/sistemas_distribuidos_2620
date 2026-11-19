# Sistema Distribuido de Gestión de Pedidos Tolerante a Fallos

[![CI](https://github.com/samue1-pineda/sistemas_distribuidos_2620/actions/workflows/ci.yml/badge.svg)](https://github.com/samue1-pineda/sistemas_distribuidos_2620/actions/workflows/ci.yml)

Proyecto final de Sistemas Distribuidos (`sistemas_distribuidos_2620`). Aplicación web que **crea,
lista, actualiza y elimina pedidos** y **sigue funcionando cuando falla un nodo de aplicación o la base
de datos principal**, gracias a balanceo con failover, replicación de datos y reconciliación automática.

![Dashboard](docs/img/01_dashboard.png)

## Arquitectura

```mermaid
flowchart LR
    B["Navegador"] -->|":8080 → :80"| G["gateway · NGINX<br/>React en / · Round-Robin + failover en /api/"]
    G --> N1["backend-node-1<br/>Nodo-Alpha-01"]
    G --> N2["backend-node-2<br/>Nodo-Beta-02"]
    N1 <-.->|"REST entre nodos"| N2
    N1 & N2 -->|"lectura / escritura"| P[("db-primary<br/>PostgreSQL 16")]
    N1 & N2 -.->|"réplica + failover"| R[("db-replica<br/>PostgreSQL 16")]
```

| Mecanismo | Qué resuelve |
|-----------|--------------|
| NGINX Round-Robin + `proxy_next_upstream` | Si un nodo cae o responde 5xx, la petición se reintenta en el otro: el usuario no ve el error |
| Chaos Engineering (`SIMULATE_CRASH`) | Un nodo "caído" responde 503 en `/api/orders*` para demostrar el failover en vivo |
| Escritura dual primaria → réplica | Cada escritura queda en ambas bases |
| Failover de BD (`SIMULATE_DB_PRIMARY_DOWN` o caída real) | Si `db-primary` falla, se lee/escribe en `db-replica` y la API responde `"db_used": "replica_failover"` (nunca HTTP 500) |
| Circuit breaker + reconciliación last-write-wins | Evita esperar a una primaria caída y la pone al día cuando vuelve |
| UUID + operaciones idempotentes | Los reintentos (incluso de `POST`) no duplican pedidos |
| Sesión JWT sin estado + usuarios replicados | La sesión es válida en ambos nodos y el login funciona aunque caiga un nodo o `db-primary` |
| Roles `user` / `admin` + cabeceras de seguridad | Cada cliente ve sólo sus pedidos; sólo el admin cambia estados y usa el caos; CSP estricta en el gateway |
| Panel de monitoreo (admin) | Métricas y eventos de cada nodo reunidos por REST, estado del gateway y de las bases, en vivo |
| Panel de administración + auditoría replicada | Gestionar usuarios (rol, desactivar, contraseña, eliminar anonimizando) y pedidos (corregir, restaurar); cada cambio queda auditado en la misma transacción |

Detalles en el [Manual Técnico](docs/01_manual_tecnico.md).

## Estructura

```text
backend/     Nodo FastAPI (Python 3.11, SQLAlchemy 2, Pydantic v2) + tests pytest
frontend/    Dashboard React 18 + Vite
nginx/       nginx.conf (upstream + failover), security-headers.conf y Dockerfile multi-stage (build React → nginx:alpine)
database/    init.sql (tablas orders y users + 3 pedidos de ejemplo) y Dockerfile de PostgreSQL 16
e2e-ui/      Prueba de interfaz con Chrome headless (genera las capturas de docs/img)
.github/     Workflow de GitHub Actions (pytest, PostgreSQL, build y clúster completo)
docs/        01_manual_tecnico.md · 02_manual_usuario.md · 03_informe_pruebas.md · img/
.claude/     Comandos de Claude Code: /verify-cluster · /run-qa · /generate-docs
```

## Despliegue local (Docker)

Requisitos: Docker Desktop (o Docker Engine con Compose v2).

```bash
cp .env.example .env             # recomendado: define ADMIN_PASSWORD y JWT_SECRET
docker compose up -d --build     # construye y levanta los 5 contenedores
docker compose ps                # esperar a que los 5 estén "healthy"
```

**Acceso:** entra con el usuario `admin` y la contraseña de `ADMIN_PASSWORD`. Si no la definiste, se
generó una aleatoria: `docker compose logs backend-node-1 backend-node-2 | grep "ADMIN inicial"`.
Cualquiera puede crear una cuenta de **cliente** desde la pantalla de inicio. Para crear o restablecer
un administrador: `docker compose exec backend-node-1 python -m app.cli create-admin --username admin --password 'NuevaClave2026'`.

| URL | Contenido |
|-----|-----------|
| <http://localhost:8080> | Dashboard logístico |
| <http://localhost:8080/api/docs> | Swagger de la API |
| <http://localhost:8080/api/health> | Salud del nodo que responde |

```bash
docker compose logs -f backend-node-1 backend-node-2   # trazas FAILOVER / REPLICATION / SYNC
docker compose down                                    # detener (conserva datos)
docker compose down -v                                 # detener y borrar datos (vuelve a init.sql)
```

Si el puerto 8080 está ocupado, copia `.env.example` a `.env` y cambia `GATEWAY_PORT`.

## Demostración rápida de tolerancia a fallos

Desde el dashboard: botones **Simular Caída de Nodo**, **Simular Caída de BD Primaria** y
**Probar balanceo**, con sesión de administrador (ver [Manual de Usuario §7](docs/02_manual_usuario.md#7-cómo-demostrar-la-tolerancia-a-fallos)).
Desde la terminal:

```bash
BASE=http://localhost:8080
TOKEN=$(curl -s -X POST $BASE/api/auth/login -H 'Content-Type: application/json' \
  -d '{"username":"admin","password":"<ADMIN_PASSWORD>"}' | python -c "import sys,json; print(json.load(sys.stdin)['access_token'])")
AUTH="Authorization: Bearer $TOKEN"

for i in 1 2 3 4; do curl -s -i -H "$AUTH" $BASE/api/orders | grep -i x-handled-by-node; done   # alterna Alpha/Beta

curl -s -H "$AUTH" -X POST $BASE/api/chaos/toggle/Nodo-Alpha-01                    # "tumba" Alpha
for i in 1 2 3 4; do curl -s -i -H "$AUTH" $BASE/api/orders | grep -iE "^HTTP|x-handled-by-node|x-upstream-status"; done
curl -s -H "$AUTH" -X POST $BASE/api/chaos/toggle/Nodo-Alpha-01                    # lo restaura

curl -s -H "$AUTH" -X POST $BASE/api/chaos/db-primary/toggle                       # "tumba" db-primary
curl -s -H "$AUTH" $BASE/api/orders | grep -o '"db_used":"[a-z_]*"'                # replica_failover
curl -s -H "$AUTH" -X POST $BASE/api/chaos/db-primary/toggle                       # restaura + reconcilia
curl -s -H "$AUTH" $BASE/api/replication/status                                    # "in_sync": true

docker compose stop backend-node-1 && curl -s -o /dev/null -w '%{http_code}\n' -H "$AUTH" $BASE/api/orders   # fallo real → 200
docker compose start backend-node-1
```

## API

| Método | Ruta | Descripción | Acceso |
|--------|------|-------------|--------|
| GET | `/api/health` | Salud del nodo y de ambas bases | público |
| POST | `/api/auth/register` | Crear cuenta de cliente `{username, full_name, password}` | público |
| POST | `/api/auth/login` | Iniciar sesión → `{access_token, expires_in, user}` | público |
| GET | `/api/auth/me` | Usuario de la sesión | sesión |
| GET | `/api/orders?status=&customer=` | Listar/filtrar pedidos (cliente: los suyos) | sesión |
| GET | `/api/orders/{id}` | Obtener un pedido | dueño o admin |
| POST | `/api/orders` | Crear pedido `{id?, customer_name, items:[{product, quantity, unit_price}]}` | sesión |
| PATCH | `/api/orders/{id}` | Editar (dueño o admin, en `pendiente`) o cambiar `status` (admin) | sesión |
| DELETE | `/api/orders/{id}` | Eliminar (admin) o cancelar un pedido propio `pendiente` | sesión |
| GET | `/api/chaos/status` | Estado del clúster (nodos, banderas, bases) | admin |
| POST | `/api/chaos/toggle` · `/api/chaos/toggle/{nodo}` | Alternar `SIMULATE_CRASH` (nodo actual o concreto) | admin |
| PUT | `/api/chaos/crash/{nodo}` | Fijar `SIMULATE_CRASH` con `{"enabled": bool}` | admin |
| POST / PUT | `/api/chaos/db-primary/toggle` · `/api/chaos/db-primary` | Simular/restaurar la caída de `db-primary` (todo el clúster) | admin |
| GET / POST | `/api/replication/status` · `/api/replication/sync` | Estado de sincronía / forzar reconciliación | admin |
| GET | `/api/monitoring/local` · `/api/monitoring/cluster` | Métricas y eventos de un nodo / de todo el clúster (`?window=300`) | admin |
| GET / PATCH / POST / DELETE | `/api/admin/users…` | Listar, editar (nombre, rol, activo), restablecer contraseña, eliminar (`?orders=keep\|delete`) | admin |
| GET / PATCH / POST | `/api/admin/orders…` | Listar (con eliminados), corrección administrativa, `…/{id}/restore` | admin |
| GET | `/api/admin/summary` · `/api/admin/audit` | Totales y registro de auditoría | admin |

Las rutas con sesión requieren `Authorization: Bearer <token>`; sin token responden `401`, y con rol
insuficiente `403`. Todas las respuestas incluyen la cabecera `X-Handled-By-Node`; las de pedidos, `db_used` y
`X-DB-Used`. NGINX añade `X-Upstream-Status` (p. ej. `503, 200` cuando reintentó en el otro nodo).

## Desarrollo sin Docker

```bash
# Backend (usa SQLite local si no se definen PRIMARY_DB_URL / REPLICA_DB_URL)
cd backend
python -m venv .venv && .venv/Scripts/python -m pip install -r requirements-dev.txt   # Linux/macOS: .venv/bin/python
NODE_ID=Nodo-Alpha-01 .venv/Scripts/python -m uvicorn app.main:app --port 8000

# Frontend (proxy de /api hacia el gateway :8080 o hacia un nodo con VITE_API_PROXY)
cd frontend
npm install
VITE_API_PROXY=http://localhost:8000 npm run dev    # http://localhost:5173
```

## Pruebas

```bash
cd backend
python -m pytest -v                                                     # 48 pruebas con SQLite temporal (e2e se omiten)
TEST_PRIMARY_DB_URL=postgresql://… TEST_REPLICA_DB_URL=postgresql://… python -m pytest tests/test_orders.py tests/test_auth.py tests/test_monitoring.py tests/test_admin.py   # PostgreSQL real
CLUSTER_BASE_URL=http://localhost:8080 CLUSTER_ADMIN_PASSWORD=… python -m pytest tests/test_cluster_e2e.py -v   # e2e contra el clúster

cd ../e2e-ui && npm install && UI_ADMIN_PASSWORD=… node ui-test.mjs     # interfaz con Chrome headless + capturas
```

> ⚠️ Con `TEST_*_DB_URL` las tablas se vacían en cada test: usa una base aparte (p. ej. `orders_test`).

Resultados: **48/48** (SQLite y PostgreSQL 16; 15 de pedidos/fallos + 13 de seguridad + 8 de monitoreo +
12 de administración), **7/7** e2e, **52/52** de interfaz. Ver
[Informe de Pruebas](docs/03_informe_pruebas.md).

### Integración continua (GitHub Actions)

`.github/workflows/ci.yml` se ejecuta en cada push a `main` y en cada pull request:

| Job | Qué hace |
|-----|----------|
| `backend` | pytest en Python 3.11 con dos SQLite temporales |
| `backend-postgres` | La misma suite contra dos PostgreSQL 16 reales (service containers) |
| `frontend` | `npm ci` + build de producción de Vite |
| `cluster` | `docker compose up --build --wait` de los 5 contenedores, pytest e2e vía NGINX y prueba de interfaz con Chrome. Las capturas quedan como artefacto `capturas-interfaz` |

Si el job `cluster` pasa, las mismas imágenes que construirá Coolify arrancan y superan las pruebas de
fallo.

## Despliegue en Coolify

El `docker-compose.yml` ya es compatible: el gateway escucha en el puerto interno **80** (`expose: 80`)
y sólo publica `${GATEWAY_PORT:-8080}` en el host; las bases se construyen con `init.sql` dentro de la
imagen (sin *bind mounts*) y el archivo no usa anclas YAML.

**Antes de desplegar**

- Servidor validado en Coolify con el proxy (Traefik) en marcha y ≥ 2 GB de RAM (el build compila
  React y levanta 2 PostgreSQL + 2 nodos Python).
- Repositorio accesible: público, o privado con la **GitHub App** de Coolify autorizada para este repo.
- Dominio: registro DNS `A` hacia la IP del servidor (o usar el dominio `sslip.io` que genera Coolify).

**Pasos**

1. **Project → Environment → + New → Public Repository** (o *Private Repository (with GitHub App)*),
   rama `main`.
2. **Build Pack: Docker Compose**, *Base Directory* `/`, *Docker Compose Location* `/docker-compose.yml`.
3. **Environment Variables:**
   - `POSTGRES_PASSWORD` → contraseña fuerte (**obligatorio**: el valor por defecto está en el repo).
   - `JWT_SECRET` → secreto largo y aleatorio (**obligatorio**), p. ej. `python -c "import secrets; print(secrets.token_urlsafe(48))"`.
     Es el mismo para ambos nodos; si se cambia, todas las sesiones abiertas se cierran.
   - `ADMIN_PASSWORD` → contraseña del administrador inicial (recomendado; si se deja vacía se genera una
     y aparece en el log del nodo que crea al admin). Sólo se usa la primera vez.
   - `GATEWAY_PORT` → un puerto **libre** del servidor, p. ej. `18080`. El proxy Traefik de Coolify suele
     publicar su panel en el **8080** y el despliegue fallaría con *port is already allocated*.
   - Opcionales: `POSTGRES_USER`, `POSTGRES_DB`. No definir `NODE1_SIMULATE_CRASH`/`NODE2_SIMULATE_CRASH`.
4. En el servicio **`gateway`**, asignar el dominio (p. ej. `https://pedidos.midominio.com`); Traefik
   enruta al puerto interno 80. Los demás servicios **no** llevan dominio.
5. **Deploy** y comprobar `https://<dominio>/api/health`, el dashboard y `https://<dominio>/api/docs`.
6. Validar contra el despliegue: `cd backend && CLUSTER_BASE_URL=https://<dominio> python -m pytest tests/test_cluster_e2e.py -v`.

**Actualizar un despliegue existente (v1.0 → v1.1):** no hace falta borrar volúmenes. Al arrancar, los
nodos crean la tabla `users`, añaden `orders.owner_id` y crean el administrador inicial (ver
[Informe de Pruebas §6.5](docs/03_informe_pruebas.md)). Los pedidos anteriores quedan visibles sólo para el admin.

**Error frecuente:** `Bind for 0.0.0.0:8080 failed: port is already allocated` al arrancar
`gateway-…`. Algo del servidor ya usa el 8080 (normalmente Traefik). Define `GATEWAY_PORT` con un
puerto libre en *Environment Variables* y pulsa **Redeploy**; no hace falta tocar el código.

Notas: los volúmenes `pg_primary_data` y `pg_replica_data` persisten entre despliegues (para volver a
los datos de ejemplo hay que borrarlos). El frontend usa rutas relativas `/api/...`, así que funciona
con cualquier dominio, con o sin HTTPS. Los endpoints `/api/chaos/*` y `/api/replication/*` requieren
sesión de administrador.


## Documentación

- [Manual Técnico](docs/01_manual_tecnico.md) — arquitectura, diagramas Mermaid, tolerancia a fallos, seguridad, monitoreo, administración y auditoría, API
- [Manual de Usuario](docs/02_manual_usuario.md) — instalación, uso y guion de demostración con capturas
- [Informe de Pruebas](docs/03_informe_pruebas.md) — casos, salida real de pytest, pruebas de fallo y conclusiones
