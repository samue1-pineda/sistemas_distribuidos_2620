import ClusterTopology from "../components/ClusterTopology.jsx";
import { LastRequestCard } from "../components/ClusterPanel.jsx";
import Icon from "../components/Icons.jsx";
import OrderForm from "../components/OrderForm.jsx";
import OrdersTable from "../components/OrdersTable.jsx";
import RequestLog from "../components/RequestLog.jsx";
import { PageHeader } from "../components/Sidebar.jsx";
import { formatNumber } from "../format.js";
import { ROUTES } from "../navigation.js";

function Tile({ label, value, hint, tone }) {
  return (
    <div className={`stat-tile ${tone ? `stat-tile--${tone}` : ""}`}>
      <span className="stat-label">{label}</span>
      <span className="stat-value">{value}</span>
      {hint && <span className={`stat-hint ${tone === "warn" ? "stat-warn" : tone === "ok" ? "stat-ok" : "muted"}`}>{hint}</span>}
    </div>
  );
}

// ---------------------------------------------------------------------- Resumen (admin)
export function ResumenPage({ cluster, replication, orders, lastRequest, handled, onNavigate }) {
  const nodes = cluster?.nodes ?? [];
  const up = nodes.filter((n) => n.reachable && !n.simulate_crash).length;
  const primary = cluster?.databases?.primary?.status;
  const primaryOk = primary === "up";
  const byStatus = (status) => orders.filter((o) => o.status === status).length;
  const shortcuts = [
    { route: "nuevo", text: "Registrar un pedido y ver qué nodo lo atiende" },
    { route: "cluster", text: "Simular caídas de nodos o de la base primaria" },
    { route: "monitoreo", text: "Tráfico, latencia y eventos en vivo" },
    { route: "usuarios", text: "Roles, cuentas y contraseñas" },
  ];
  return (
    <>
      <PageHeader title="Resumen" description={ROUTES.resumen.description} />
      <div className="stat-row stat-row--4">
        <Tile
          label="Nodos operativos"
          value={cluster ? `${up} / ${nodes.length}` : "—"}
          hint={!cluster ? "cargando…" : up === nodes.length ? "✓ todos atienden tráfico" : "⚠ hay nodos fuera de servicio"}
          tone={!cluster ? null : up === nodes.length ? "ok" : "warn"}
        />
        <Tile
          label="Base de datos primaria"
          value={!cluster ? "—" : primaryOk ? "Operativa" : "Caída"}
          hint={!cluster ? "" : primaryOk ? "✓ lecturas y escrituras normales" : "⚠ atendiendo desde la réplica"}
          tone={!cluster ? null : primaryOk ? "ok" : "warn"}
        />
        <Tile
          label="Réplica"
          value={replication ? (replication.in_sync ? "En sincronía" : "Divergente") : "—"}
          hint={replication?.in_sync ? "✓ ambas bases coinciden" : replication ? "⚠ reconciliación pendiente" : ""}
          tone={replication ? (replication.in_sync ? "ok" : "warn") : null}
        />
        <Tile
          label="Pedidos activos"
          value={formatNumber(orders.length)}
          hint={`${byStatus("pendiente")} pendientes · ${byStatus("en proceso") + byStatus("enviado")} en camino`}
        />
      </div>
      <section className="card topology-card">
        <header className="card-head">
          <h3>Topología del clúster</h3>
          <span className="muted small">Cada punto es una petición real recorriendo el sistema</span>
        </header>
        <ClusterTopology mode="admin" cluster={cluster} replication={replication} lastRequest={lastRequest} handled={handled} />
      </section>
      <section className="shortcuts" aria-label="Accesos rápidos">
        {shortcuts.map(({ route, text }) => (
          <button key={route} type="button" className="shortcut card" onClick={() => onNavigate(route)}>
            <span className="shortcut-icon"><Icon name={ROUTES[route].icon} size={22} /></span>
            <span className="shortcut-text">
              <strong>{ROUTES[route].label}</strong>
              <span className="muted small">{text}</span>
            </span>
            <Icon name="arrow" />
          </button>
        ))}
      </section>
    </>
  );
}

// ---------------------------------------------------------------------- Pedidos
export function PedidosPage({ isAdmin, orders, ordersState, pending, onAdvance, onEdit, onDelete, onRefresh, onNavigate }) {
  const route = ROUTES.pedidos;
  return (
    <>
      <PageHeader title={isAdmin ? route.label : route.clientLabel} description={isAdmin ? route.description : route.clientDescription}>
        <button type="button" className="btn btn-primary" onClick={() => onNavigate("nuevo")}>
          <Icon name="plus" size={16} /> Nuevo pedido
        </button>
      </PageHeader>
      <OrdersTable
        isAdmin={isAdmin}
        orders={orders}
        state={ordersState}
        pending={pending}
        onAdvance={onAdvance}
        onEdit={onEdit}
        onDelete={onDelete}
        onRefresh={onRefresh}
      />
    </>
  );
}

// ---------------------------------------------------------------------- Nuevo pedido
export function NuevoPedidoPage({ isAdmin, user, busy, onCreate, lastRequest, onNavigate }) {
  return (
    <>
      <PageHeader title="Nuevo pedido" description={ROUTES.nuevo.description}>
        <button type="button" className="btn btn-ghost" onClick={() => onNavigate("pedidos")}>
          {isAdmin ? "Ver pedidos" : "Ver mis pedidos"}
        </button>
      </PageHeader>
      <div className="split">
        <OrderForm defaultCustomer={isAdmin ? "" : user.full_name} busy={busy} onCreate={onCreate} />
        <aside className="split-aside">
          <LastRequestCard meta={lastRequest} />
          <div className="card steps-card">
            <h3>¿Qué pasa al crear un pedido?</h3>
            <ol className="steps">
              <li>El gateway NGINX lo envía a uno de los dos nodos (por turnos).</li>
              <li>El nodo lo guarda en la base primaria y lo copia en la réplica.</li>
              <li>Si algo falla, otro nodo o la réplica lo atienden sin que lo notes.</li>
            </ol>
          </div>
        </aside>
      </div>
    </>
  );
}

// ---------------------------------------------------------------------- Mi conexión (cliente)
export function ConexionPage({ lastRequest, log, onClearLog }) {
  return (
    <>
      <PageHeader title="Mi conexión" description={ROUTES.conexion.description} />
      <section className="card topology-card">
        <header className="card-head">
          <h3>Así viajó tu última petición</h3>
        </header>
        <ClusterTopology mode="client" lastRequest={lastRequest} />
      </section>
      <div className="split split--wide-right">
        <LastRequestCard meta={lastRequest} />
        <RequestLog entries={log} onClear={onClearLog} />
      </div>
    </>
  );
}
