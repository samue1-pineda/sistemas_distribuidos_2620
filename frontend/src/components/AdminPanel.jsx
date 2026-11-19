import { useCallback, useEffect, useState } from "react";
import { api } from "../api.js";
import { STATUSES, STATUS_LABELS, dbLabel, formatDateTime, formatMoney, formatNumber, shortId } from "../format.js";
import { NodeChip } from "./ClusterPanel.jsx";
import Dialog from "./Dialog.jsx";

const ACTION_LABELS = {
  "order.create": "Creó pedido",
  "order.update": "Editó pedido",
  "order.status": "Cambió estado",
  "order.delete": "Eliminó pedido",
  "order.admin_update": "Corrección admin",
  "order.restore": "Restauró pedido",
  "user.register": "Registro",
  "user.update": "Editó usuario",
  "user.role": "Cambió rol",
  "user.activate": "Reactivó cuenta",
  "user.deactivate": "Desactivó cuenta",
  "user.password_reset": "Restableció contraseña",
  "user.delete": "Eliminó cuenta",
  "user.admin_cli": "Admin (CLI)",
};
const FIELD_LABELS = { customer_name: "cliente", items: "ítems", total: "total", status: "estado", full_name: "nombre", role: "rol", is_active: "activo", username: "usuario" };

function describeValue(field, value) {
  if (value == null) return "—";
  if (field === "items") return value.map((item) => `${item.product} ×${item.quantity}`).join(", ");
  if (field === "is_active") return value ? "sí" : "no";
  if (field === "total") return formatMoney(value);
  if (field === "role") return value === "admin" ? "admin" : "cliente";
  return String(value);
}

function Changes({ changes }) {
  if (!changes) return <span className="muted">—</span>;
  const pairs = Object.entries(changes).filter(([, v]) => Array.isArray(v) && v.length === 2);
  const extras = Object.entries(changes).filter(([, v]) => !Array.isArray(v));
  return (
    <span className="changes">
      {pairs.map(([field, [before, after]]) => (
        <span key={field} className="change">
          {FIELD_LABELS[field] ?? field}: <s>{describeValue(field, before)}</s> → <strong>{describeValue(field, after)}</strong>
        </span>
      ))}
      {extras.map(([field, value]) => (
        <span key={field} className="change muted">
          {field}: {String(value)}
        </span>
      ))}
    </span>
  );
}

function RoleBadge({ role }) {
  return <span className={`role-badge role-${role}`}>{role === "admin" ? "Admin" : "Cliente"}</span>;
}

// ---------------------------------------------------------------------- diálogos
function EditUserDialog({ user, onClose, onSaved, notify }) {
  const [fullName, setFullName] = useState(user.full_name);
  const [role, setRole] = useState(user.role);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const save = async () => {
    const body = {};
    if (fullName.trim() !== user.full_name) body.full_name = fullName.trim();
    if (role !== user.role) body.role = role;
    if (!Object.keys(body).length) return onClose();
    setBusy(true);
    try {
      const { data } = await api.adminUpdateUser(user.id, body);
      notify("success", `Usuario '${user.username}' actualizado (${data.node} · ${dbLabel(data.db_used)})`);
      onSaved();
    } catch (err) {
      setError(err.message);
      setBusy(false);
    }
  };
  return (
    <Dialog
      title={`Editar a ${user.username}`}
      onClose={onClose}
      actions={
        <>
          <button type="button" className="btn btn-ghost" onClick={onClose}>Cancelar</button>
          <button type="button" className="btn btn-primary" disabled={busy} onClick={save}>{busy ? "Guardando…" : "Guardar cambios"}</button>
        </>
      }
    >
      <label className="field">
        <span>Nombre completo</span>
        <input value={fullName} onChange={(e) => setFullName(e.target.value)} maxLength={120} />
      </label>
      <label className="field">
        <span>Rol</span>
        <select value={role} onChange={(e) => setRole(e.target.value)}>
          <option value="user">Cliente</option>
          <option value="admin">Administrador</option>
        </select>
      </label>
      <p className="hint muted">El cambio de rol tiene efecto inmediato en ambos nodos, sin volver a iniciar sesión.</p>
      {error && <p className="form-error">{error}</p>}
    </Dialog>
  );
}

function PasswordDialog({ user, onClose, onSaved, notify }) {
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const save = async () => {
    if (password.length < 8 || !/[A-Za-z]/.test(password) || !/\d/.test(password)) {
      setError("Mínimo 8 caracteres, con letras y números.");
      return;
    }
    if (password !== confirm) {
      setError("Las contraseñas no coinciden.");
      return;
    }
    setBusy(true);
    try {
      await api.adminResetPassword(user.id, password);
      notify("success", `Contraseña de '${user.username}' restablecida`);
      onSaved();
    } catch (err) {
      setError(err.message);
      setBusy(false);
    }
  };
  return (
    <Dialog
      title={`Restablecer contraseña de ${user.username}`}
      onClose={onClose}
      actions={
        <>
          <button type="button" className="btn btn-ghost" onClick={onClose}>Cancelar</button>
          <button type="button" className="btn btn-primary" disabled={busy} onClick={save}>{busy ? "Guardando…" : "Restablecer"}</button>
        </>
      }
    >
      <label className="field">
        <span>Nueva contraseña</span>
        <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="new-password" maxLength={128} />
      </label>
      <label className="field">
        <span>Confirmar</span>
        <input type="password" value={confirm} onChange={(e) => setConfirm(e.target.value)} autoComplete="new-password" maxLength={128} />
      </label>
      <p className="hint muted">La contraseña no se guarda en la auditoría: sólo que fue restablecida y por quién.</p>
      {error && <p className="form-error">{error}</p>}
    </Dialog>
  );
}

function DeleteUserDialog({ user, onClose, onSaved, notify }) {
  const [mode, setMode] = useState("keep");
  const [confirmText, setConfirmText] = useState("");
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const remove = async () => {
    setBusy(true);
    try {
      const { data } = await api.adminDeleteUser(user.id, mode);
      notify("warn", `Cuenta '${user.username}' eliminada · ${data.data.orders_affected} pedido(s) ${mode === "delete" ? "eliminados" : "conservados"}`);
      onSaved();
    } catch (err) {
      setError(err.message);
      setBusy(false);
    }
  };
  return (
    <Dialog
      title={`Eliminar la cuenta de ${user.username}`}
      onClose={onClose}
      actions={
        <>
          <button type="button" className="btn btn-ghost" onClick={onClose}>Cancelar</button>
          <button type="button" className="btn btn-danger" disabled={busy || confirmText !== user.username} onClick={remove}>
            {busy ? "Eliminando…" : "Eliminar cuenta"}
          </button>
        </>
      }
    >
      <p>
        Los datos personales se <strong>anonimizan</strong> (usuario y nombre) y la cuenta deja de poder iniciar sesión.
        ¿Qué hacer con sus <strong>{user.orders_count}</strong> pedido(s) activos?
      </p>
      <fieldset className="radio-group">
        <label>
          <input type="radio" name="orders-mode" value="keep" checked={mode === "keep"} onChange={() => setMode("keep")} />
          Conservarlos (quedan a nombre de "Usuario eliminado")
        </label>
        <label>
          <input type="radio" name="orders-mode" value="delete" checked={mode === "delete"} onChange={() => setMode("delete")} />
          Eliminarlos también (se pueden restaurar desde la vista Pedidos)
        </label>
      </fieldset>
      <label className="field">
        <span>Escribe <code>{user.username}</code> para confirmar</span>
        <input value={confirmText} onChange={(e) => setConfirmText(e.target.value)} autoComplete="off" />
      </label>
      {error && <p className="form-error">{error}</p>}
    </Dialog>
  );
}

function EditOrderDialog({ order, onClose, onSaved, notify }) {
  const [customer, setCustomer] = useState(order.customer_name);
  const [status, setStatus] = useState(order.status);
  const [items, setItems] = useState(order.items.map((i) => ({ ...i })));
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const setItem = (index, field, value) => setItems((list) => list.map((it, i) => (i === index ? { ...it, [field]: value } : it)));
  const save = async () => {
    const cleanItems = items.map((i) => ({ product: String(i.product).trim(), quantity: Number(i.quantity), unit_price: Number(i.unit_price) }));
    if (cleanItems.some((i) => !i.product || !Number.isInteger(i.quantity) || i.quantity < 1 || !(i.unit_price >= 0))) {
      setError("Revisa los ítems: producto, cantidad entera ≥ 1 y precio ≥ 0.");
      return;
    }
    const body = {};
    if (customer.trim() !== order.customer_name) body.customer_name = customer.trim();
    if (status !== order.status) body.status = status;
    if (JSON.stringify(cleanItems) !== JSON.stringify(order.items)) body.items = cleanItems;
    if (!Object.keys(body).length) return onClose();
    setBusy(true);
    try {
      const { data } = await api.adminUpdateOrder(order.id, body);
      notify("success", `Pedido #${shortId(order.id)} corregido (${data.node} · ${dbLabel(data.db_used)})`);
      onSaved();
    } catch (err) {
      setError(err.message);
      setBusy(false);
    }
  };
  return (
    <Dialog
      title={`Corregir pedido #${shortId(order.id)}`}
      onClose={onClose}
      actions={
        <>
          <button type="button" className="btn btn-ghost" onClick={onClose}>Cancelar</button>
          <button type="button" className="btn btn-primary" disabled={busy} onClick={save}>{busy ? "Guardando…" : "Guardar corrección"}</button>
        </>
      }
    >
      <p className="callout callout-amber">
        Corrección administrativa: permite cambiar cualquier dato y cualquier estado (incluso retroceder). Queda en la auditoría.
      </p>
      <label className="field">
        <span>Cliente</span>
        <input value={customer} onChange={(e) => setCustomer(e.target.value)} maxLength={120} />
      </label>
      <label className="field">
        <span>Estado</span>
        <select value={status} onChange={(e) => setStatus(e.target.value)}>
          {STATUSES.map((s) => (
            <option key={s} value={s}>{STATUS_LABELS[s]}</option>
          ))}
        </select>
      </label>
      <div className="items-head">
        <span>Producto</span>
        <span>Cant.</span>
        <span>Precio unit.</span>
        <span />
      </div>
      {items.map((item, index) => (
        <div className="item-row" key={index}>
          <input aria-label={`Producto ${index + 1}`} value={item.product} onChange={(e) => setItem(index, "product", e.target.value)} />
          <input aria-label={`Cantidad ${index + 1}`} type="number" min="1" value={item.quantity} onChange={(e) => setItem(index, "quantity", e.target.value)} />
          <input aria-label={`Precio ${index + 1}`} type="number" min="0" step="0.01" value={item.unit_price} onChange={(e) => setItem(index, "unit_price", e.target.value)} />
          <button type="button" className="icon-btn" aria-label={`Quitar ítem ${index + 1}`} disabled={items.length === 1} onClick={() => setItems((l) => l.filter((_, i) => i !== index))}>×</button>
        </div>
      ))}
      <button type="button" className="btn btn-link" onClick={() => setItems((l) => [...l, { product: "", quantity: 1, unit_price: 0 }])}>
        + Agregar ítem
      </button>
      {error && <p className="form-error">{error}</p>}
    </Dialog>
  );
}

// ---------------------------------------------------------------------- vistas
export function UsersView({ currentUserId, notify, onChanged, reloadKey }) {
  const [filters, setFilters] = useState({ search: "", role: "", status: "" });
  const [rows, setRows] = useState([]);
  const [error, setError] = useState(null);
  const [dialog, setDialog] = useState(null);
  const load = useCallback(async () => {
    try {
      const { data } = await api.adminUsers(filters);
      setRows(data.data);
      setError(null);
    } catch (err) {
      setError(err.message);
    }
  }, [filters]);
  useEffect(() => {
    load();
  }, [load, reloadKey]);

  const toggleActive = async (user) => {
    try {
      await api.adminUpdateUser(user.id, { is_active: !user.is_active });
      notify(user.is_active ? "warn" : "success", `Cuenta '${user.username}' ${user.is_active ? "desactivada: sus sesiones se cierran" : "reactivada"}`);
      onChanged();
    } catch (err) {
      notify("error", err.message);
    }
  };
  const afterDialog = () => {
    setDialog(null);
    onChanged();
  };
  const deletedView = filters.status === "deleted";

  return (
    <>
      <div className="filter-row">
        <input className="search" type="search" placeholder="Buscar usuario o nombre…" value={filters.search} onChange={(e) => setFilters((f) => ({ ...f, search: e.target.value }))} aria-label="Buscar usuarios" />
        <select value={filters.role} onChange={(e) => setFilters((f) => ({ ...f, role: e.target.value }))} aria-label="Filtrar por rol">
          <option value="">Todos los roles</option>
          <option value="user">Clientes</option>
          <option value="admin">Administradores</option>
        </select>
        <select value={filters.status} onChange={(e) => setFilters((f) => ({ ...f, status: e.target.value }))} aria-label="Filtrar por estado">
          <option value="">Activos y desactivados</option>
          <option value="active">Sólo activos</option>
          <option value="inactive">Sólo desactivados</option>
          <option value="deleted">Eliminados (anonimizados)</option>
        </select>
      </div>
      {error && <p className="form-error">{error}</p>}
      <div className="table-wrap">
        <table className="admin-table">
          <thead>
            <tr>
              <th>Usuario</th>
              <th>Nombre</th>
              <th>Rol</th>
              <th>Estado</th>
              <th className="num">Pedidos</th>
              <th>Alta</th>
              <th className="actions-col">Acciones</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 && (
              <tr>
                <td colSpan={7} className="empty">Ningún usuario coincide con el filtro.</td>
              </tr>
            )}
            {rows.map((user) => {
              const isMe = user.id === currentUserId;
              return (
                <tr key={user.id} data-username={user.username}>
                  <td className="mono">
                    {user.username} {isMe && <span className="you-badge">Tú</span>}
                  </td>
                  <td>{user.full_name}</td>
                  <td><RoleBadge role={user.role} /></td>
                  <td>
                    {user.deleted_at ? (
                      <span className="pill pill-down">Eliminada</span>
                    ) : (
                      <span className={`pill ${user.is_active ? "pill-up" : "pill-crash"}`}>{user.is_active ? "Activa" : "Desactivada"}</span>
                    )}
                  </td>
                  <td className="num mono">{formatNumber(user.orders_count)}</td>
                  <td className="muted small nowrap">{formatDateTime(user.created_at)}</td>
                  <td>
                    {!deletedView && !user.deleted_at && (
                      <div className="actions">
                        <button type="button" className="btn btn-sm btn-ghost" onClick={() => setDialog({ kind: "edit", user })}>Editar</button>
                        <button type="button" className="btn btn-sm btn-ghost" onClick={() => setDialog({ kind: "password", user })}>Contraseña</button>
                        <button type="button" className="btn btn-sm btn-ghost" disabled={isMe} title={isMe ? "No puedes desactivar tu propia cuenta" : undefined} onClick={() => toggleActive(user)}>
                          {user.is_active ? "Desactivar" : "Reactivar"}
                        </button>
                        <button type="button" className="btn btn-sm btn-ghost-danger" disabled={isMe} title={isMe ? "No puedes eliminar tu propia cuenta" : undefined} onClick={() => setDialog({ kind: "delete", user })}>
                          Eliminar
                        </button>
                      </div>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {dialog?.kind === "edit" && <EditUserDialog user={dialog.user} onClose={() => setDialog(null)} onSaved={afterDialog} notify={notify} />}
      {dialog?.kind === "password" && <PasswordDialog user={dialog.user} onClose={() => setDialog(null)} onSaved={afterDialog} notify={notify} />}
      {dialog?.kind === "delete" && <DeleteUserDialog user={dialog.user} onClose={() => setDialog(null)} onSaved={afterDialog} notify={notify} />}
    </>
  );
}

export function OrdersView({ notify, onChanged, reloadKey }) {
  const [filters, setFilters] = useState({ search: "", status: "", include_deleted: true });
  const [rows, setRows] = useState([]);
  const [error, setError] = useState(null);
  const [editing, setEditing] = useState(null);
  const load = useCallback(async () => {
    try {
      const { data } = await api.adminOrders(filters);
      setRows(data.data);
      setError(null);
    } catch (err) {
      setError(err.message);
    }
  }, [filters]);
  useEffect(() => {
    load();
  }, [load, reloadKey]);

  const restore = async (order) => {
    try {
      const { data } = await api.adminRestoreOrder(order.id);
      notify("success", `Pedido #${shortId(order.id)} restaurado (${data.node} · ${dbLabel(data.db_used)})`);
      onChanged();
    } catch (err) {
      notify("error", err.message);
    }
  };

  return (
    <>
      <div className="filter-row">
        <input className="search" type="search" placeholder="Buscar cliente o ID…" value={filters.search} onChange={(e) => setFilters((f) => ({ ...f, search: e.target.value }))} aria-label="Buscar pedidos" />
        <select value={filters.status} onChange={(e) => setFilters((f) => ({ ...f, status: e.target.value }))} aria-label="Filtrar por estado">
          <option value="">Todos los estados</option>
          {STATUSES.map((s) => (
            <option key={s} value={s}>{STATUS_LABELS[s]}</option>
          ))}
        </select>
        <label className="checkbox">
          <input type="checkbox" checked={filters.include_deleted} onChange={(e) => setFilters((f) => ({ ...f, include_deleted: e.target.checked }))} />
          Mostrar eliminados
        </label>
      </div>
      {error && <p className="form-error">{error}</p>}
      <div className="table-wrap">
        <table className="admin-table">
          <thead>
            <tr>
              <th>Pedido</th>
              <th>Cliente</th>
              <th>Cuenta</th>
              <th className="num">Total</th>
              <th>Estado</th>
              <th>Último nodo</th>
              <th className="actions-col">Acciones</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 && (
              <tr>
                <td colSpan={7} className="empty">Ningún pedido coincide con el filtro.</td>
              </tr>
            )}
            {rows.map((order) => (
              <tr key={order.id} className={order.deleted_at ? "row-deleted" : ""} data-customer={order.customer_name}>
                <td className="nowrap">
                  <div className="mono">#{shortId(order.id)}</div>
                  <div className="muted small">{formatDateTime(order.created_at)}</div>
                </td>
                <td>{order.customer_name}</td>
                <td className="small">{order.owner_username ?? <span className="muted">datos de ejemplo</span>}</td>
                <td className="num mono">{formatMoney(order.total)}</td>
                <td>
                  {order.deleted_at ? (
                    <span className="pill pill-down">Eliminado · {STATUS_LABELS[order.status]}</span>
                  ) : (
                    <span className={`status status-${order.status.replace(" ", "-")}`}>{STATUS_LABELS[order.status]}</span>
                  )}
                </td>
                <td><NodeChip node={order.handled_by_node} /></td>
                <td>
                  <div className="actions">
                    {order.deleted_at ? (
                      <button type="button" className="btn btn-sm btn-success" onClick={() => restore(order)}>Restaurar</button>
                    ) : (
                      <button type="button" className="btn btn-sm btn-ghost" onClick={() => setEditing(order)}>Corregir</button>
                    )}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {editing && (
        <EditOrderDialog
          order={editing}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            onChanged();
          }}
          notify={notify}
        />
      )}
    </>
  );
}

export function AuditView({ reloadKey }) {
  const [filters, setFilters] = useState({ entity: "", actor: "" });
  const [rows, setRows] = useState([]);
  const [error, setError] = useState(null);
  useEffect(() => {
    api
      .adminAudit({ ...filters, limit: 200 })
      .then(({ data }) => {
        setRows(data.data);
        setError(null);
      })
      .catch((err) => setError(err.message));
  }, [filters, reloadKey]);

  return (
    <>
      <div className="filter-row">
        <select value={filters.entity} onChange={(e) => setFilters((f) => ({ ...f, entity: e.target.value }))} aria-label="Filtrar por entidad">
          <option value="">Pedidos y usuarios</option>
          <option value="order">Sólo pedidos</option>
          <option value="user">Sólo usuarios</option>
        </select>
        <input className="search" type="search" placeholder="Usuario que actuó (p. ej. admin)…" value={filters.actor} onChange={(e) => setFilters((f) => ({ ...f, actor: e.target.value }))} aria-label="Filtrar por usuario" />
        <span className="muted small">Se replica en ambas bases y se escribe en la misma transacción que el cambio.</span>
      </div>
      {error && <p className="form-error">{error}</p>}
      <div className="table-wrap audit-wrap">
        <table className="admin-table audit-table">
          <thead>
            <tr>
              <th>Fecha</th>
              <th>Quién</th>
              <th>Acción</th>
              <th>Descripción</th>
              <th>Cambios</th>
              <th>Nodo</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 && (
              <tr>
                <td colSpan={6} className="empty">Sin registros para este filtro.</td>
              </tr>
            )}
            {rows.map((entry) => (
              <tr key={entry.id}>
                <td className="muted small nowrap">{formatDateTime(entry.created_at)}</td>
                <td className="mono">{entry.actor_username}</td>
                <td className="nowrap">
                  <span className={`audit-action audit-${entry.entity}`}>{ACTION_LABELS[entry.action] ?? entry.action}</span>
                </td>
                <td className="event-message">{entry.summary}</td>
                <td className="small"><Changes changes={entry.changes} /></td>
                <td><NodeChip node={entry.node} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}
