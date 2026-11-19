import { useEffect, useMemo, useState } from "react";
import { STATUSES, STATUS_LABELS, formatDateTime, formatMoney, shortId } from "../format.js";
import { DbChip, NodeChip } from "./ClusterPanel.jsx";

function StatusBadge({ status }) {
  return <span className={`status status-${status.replace(" ", "-")}`}>{STATUS_LABELS[status] ?? status}</span>;
}

function Progress({ status }) {
  const current = STATUSES.indexOf(status);
  return (
    <span className="progress" aria-label={`Paso ${current + 1} de ${STATUSES.length}`}>
      {STATUSES.map((s, i) => (
        <span key={s} className={`step ${i <= current ? "done" : ""}`} title={STATUS_LABELS[s]} />
      ))}
    </span>
  );
}

function itemsSummary(items) {
  return items.map((item) => `${item.product} ×${item.quantity}`).join(", ");
}

function DeleteButton({ disabled, onConfirm, label = "Eliminar" }) {
  const [armed, setArmed] = useState(false);
  useEffect(() => {
    if (!armed) return undefined;
    const timer = setTimeout(() => setArmed(false), 3000);
    return () => clearTimeout(timer);
  }, [armed]);
  return (
    <button
      type="button"
      className={`btn btn-sm ${armed ? "btn-danger" : "btn-ghost-danger"}`}
      disabled={disabled}
      onClick={() => (armed ? onConfirm() : setArmed(true))}
    >
      {armed ? "¿Confirmar?" : label}
    </button>
  );
}

export default function OrdersTable({ orders, state, pending, onAdvance, onEdit, onDelete, onRefresh, editingId, isAdmin = true }) {
  const [filter, setFilter] = useState("todos");
  const [query, setQuery] = useState("");

  const counts = useMemo(() => {
    const result = { todos: orders.length };
    STATUSES.forEach((s) => {
      result[s] = orders.filter((o) => o.status === s).length;
    });
    return result;
  }, [orders]);

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return orders.filter(
      (o) =>
        (filter === "todos" || o.status === filter) &&
        (!q ||
          o.customer_name.toLowerCase().includes(q) ||
          o.id.startsWith(q) ||
          (o.owner_username ?? "").toLowerCase().includes(q)),
    );
  }, [orders, filter, query]);

  return (
    <section className="card orders" aria-labelledby="orders-title">
      <header className="card-head">
        <h3 id="orders-title">{isAdmin ? "Todos los clientes" : "Tus pedidos"}</h3>
        <div className="orders-tools">
          <span className="muted small">
            Leído desde <DbChip dbUsed={state.dbUsed} />
          </span>
          <button type="button" className="btn btn-ghost btn-sm" onClick={onRefresh} disabled={pending.refresh}>
            {pending.refresh ? "Cargando…" : "↻ Refrescar"}
          </button>
        </div>
      </header>

      <div className="filters">
        <div className="chips" role="tablist" aria-label="Filtrar por estado">
          {["todos", ...STATUSES].map((s) => (
            <button
              key={s}
              type="button"
              role="tab"
              aria-selected={filter === s}
              className={`chip ${filter === s ? "chip-active" : ""}`}
              onClick={() => setFilter(s)}
            >
              {s === "todos" ? "Todos" : STATUS_LABELS[s]} <span className="chip-count">{counts[s]}</span>
            </button>
          ))}
        </div>
        <input
          className="search"
          type="search"
          placeholder="Buscar cliente o ID…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          aria-label="Buscar pedidos"
        />
      </div>

      {state.error && <p className="form-error">No se pudieron cargar los pedidos: {state.error}</p>}

      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Pedido</th>
              <th>Cliente / ítems</th>
              <th className="num">Total</th>
              <th>Estado</th>
              <th>Atendido por</th>
              <th className="actions-col">Acciones</th>
            </tr>
          </thead>
          <tbody>
            {state.loading && orders.length === 0 && (
              <tr>
                <td colSpan={6} className="empty">Cargando pedidos…</td>
              </tr>
            )}
            {!state.loading && visible.length === 0 && (
              <tr>
                <td colSpan={6} className="empty">
                  {orders.length === 0
                    ? isAdmin
                      ? "No hay pedidos todavía."
                      : "Aún no tienes pedidos. Crea el primero con el formulario."
                    : "Ningún pedido coincide con el filtro."}
                </td>
              </tr>
            )}
            {visible.map((order) => {
              const busy = pending[`order:${order.id}`];
              return (
                <tr key={order.id} className={editingId === order.id ? "row-editing" : ""}>
                  <td className="nowrap">
                    <div className="mono" title={order.id}>#{shortId(order.id)}</div>
                    <div className="muted small">{formatDateTime(order.created_at)}</div>
                  </td>
                  <td className="customer-cell">
                    <div className="customer">{order.customer_name}</div>
                    <div className="items-line muted small" title={itemsSummary(order.items)}>
                      {itemsSummary(order.items)}
                    </div>
                    {isAdmin && (
                      <div className="owner-line small" title="Cuenta que creó el pedido">
                        👤 {order.owner_username ?? "sin cuenta (datos de ejemplo)"}
                      </div>
                    )}
                  </td>
                  <td className="num mono">{formatMoney(order.total)}</td>
                  <td>
                    <div className="status-cell">
                      <StatusBadge status={order.status} />
                      <Progress status={order.status} />
                    </div>
                  </td>
                  <td><NodeChip node={order.handled_by_node} /></td>
                  <td>
                    <div className="actions">
                    {!order.next_status ? (
                      <span className="done-label">✓ Completado</span>
                    ) : isAdmin ? (
                      <button type="button" className="btn btn-sm btn-primary" disabled={busy} onClick={() => onAdvance(order)}>
                        → {STATUS_LABELS[order.next_status]}
                      </button>
                    ) : null}
                    {order.status === "pendiente" && (
                      <button type="button" className="btn btn-sm btn-ghost" disabled={busy} onClick={() => onEdit(order)}>
                        Editar
                      </button>
                    )}
                    {(isAdmin || order.status === "pendiente") && (
                      <DeleteButton label={isAdmin ? "Eliminar" : "Cancelar pedido"} disabled={busy} onConfirm={() => onDelete(order)} />
                    )}
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}
