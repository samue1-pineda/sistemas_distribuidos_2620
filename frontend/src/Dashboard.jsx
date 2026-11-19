import { useCallback, useEffect, useRef, useState } from "react";
import { api, onApiEvent } from "./api.js";
import Dialog from "./components/Dialog.jsx";
import Icon from "./components/Icons.jsx";
import OrderForm from "./components/OrderForm.jsx";
import Sidebar from "./components/Sidebar.jsx";
import Toasts from "./components/Toasts.jsx";
import { STATUS_LABELS, dbLabel, shortId } from "./format.js";
import { useHashRoute } from "./navigation.js";
import { AuditoriaPage, CorreccionesPage, UsuariosPage } from "./pages/AdminPages.jsx";
import { ConexionPage, NuevoPedidoPage, PedidosPage, ResumenPage } from "./pages/OperacionPages.jsx";
import { ClusterPage, MonitoreoPage } from "./pages/SistemaPages.jsx";

const POLL_MS = 3000;
const LOG_SIZE = 30;
// Secciones que muestran el estado del clúster (sólo en ellas se consulta cada 3 s).
const CLUSTER_ROUTES = new Set(["resumen", "cluster"]);

export default function Dashboard({ user, onLogout }) {
  const isAdmin = user.role === "admin";
  const [route, navigate] = useHashRoute(user.role);
  const routeRef = useRef(route);
  routeRef.current = route;

  const [orders, setOrders] = useState([]);
  const [ordersState, setOrdersState] = useState({ loading: true, error: null, dbUsed: null });
  const [cluster, setCluster] = useState(null);
  const [replication, setReplication] = useState(null);
  const [gatewayUp, setGatewayUp] = useState(true);
  const [lastRequest, setLastRequest] = useState(null);
  const [log, setLog] = useState([]);
  const [handled, setHandled] = useState({});
  const [balance, setBalance] = useState([]);
  const [editing, setEditing] = useState(null);
  const [toasts, setToasts] = useState([]);
  const [pending, setPending] = useState({});
  const toastSeq = useRef(0);
  // Control de respuestas obsoletas: una recarga de la lista que empezó antes de un cambio local (o que
  // fue superada por otra más nueva) NO debe sobrescribir el estado. Sin esto, un GET lento que leyó la
  // BD antes de un PATCH devolvía el pedido a su estado anterior en pantalla.
  const ordersVersion = useRef(0);
  const listSeq = useRef(0);
  const applyList = useCallback((data, seq, versionAtStart) => {
    if (seq !== listSeq.current || versionAtStart !== ordersVersion.current) return false;
    setOrders(data.data);
    setOrdersState({ loading: false, error: null, dbUsed: data.db_used });
    return true;
  }, []);
  const mutateOrders = useCallback((updater) => {
    ordersVersion.current += 1;
    setOrders(updater);
  }, []);

  const dismiss = useCallback((id) => setToasts((list) => list.filter((t) => t.id !== id)), []);
  const notify = useCallback(
    (type, text) => {
      const id = ++toastSeq.current;
      setToasts((list) => [...list.slice(-3), { id, type, text }]);
      setTimeout(() => dismiss(id), 5000);
    },
    [dismiss],
  );

  // Cada respuesta de la API actualiza "Última petición", la topología y el registro.
  useEffect(
    () =>
      onApiEvent((meta) => {
        setGatewayUp(meta.status !== 0 && meta.status !== 502 && meta.status !== 504);
        if (meta.silent) return;
        setLastRequest(meta);
        setLog((list) => [meta, ...list].slice(0, LOG_SIZE));
        if (meta.node) setHandled((counts) => ({ ...counts, [meta.node]: (counts[meta.node] ?? 0) + 1 }));
      }),
    [],
  );

  const withPending = useCallback(async (key, fn) => {
    setPending((p) => ({ ...p, [key]: true }));
    try {
      return await fn();
    } finally {
      setPending((p) => ({ ...p, [key]: false }));
    }
  }, []);

  const loadOrders = useCallback(async ({ silent = false } = {}) => {
    const seq = ++listSeq.current;
    const versionAtStart = ordersVersion.current;
    try {
      const { data } = await api.listOrders({ silent });
      applyList(data, seq, versionAtStart);
      return data;
    } catch (error) {
      setOrdersState((s) => ({ ...s, loading: false, error: error.message }));
      throw error;
    }
  }, [applyList]);

  const refreshCluster = useCallback(async () => {
    if (!isAdmin || !CLUSTER_ROUTES.has(routeRef.current)) return;
    const [status, repl] = await Promise.allSettled([api.clusterStatus(), api.replicationStatus()]);
    if (status.status === "fulfilled") setCluster(status.value.data);
    if (repl.status === "fulfilled") setReplication(repl.value.data);
  }, [isAdmin]);

  useEffect(() => {
    loadOrders().catch(() => {});
    const timer = setInterval(() => {
      if (!document.hidden) refreshCluster();
    }, POLL_MS);
    return () => clearInterval(timer);
  }, [loadOrders, refreshCluster]);

  // Al entrar a una sección se refrescan sus datos (silenciosamente).
  useEffect(() => {
    if (CLUSTER_ROUTES.has(route)) refreshCluster();
    if (route === "pedidos" || route === "resumen") loadOrders({ silent: true }).catch(() => {});
  }, [route, refreshCluster, loadOrders]);

  // Las respuestas de escritura no traen owner_username: se conserva el que ya conocíamos.
  const upsertLocal = (order) =>
    mutateOrders((list) => {
      const exists = list.some((o) => o.id === order.id);
      return exists
        ? list.map((o) => (o.id === order.id ? { ...o, ...order, owner_username: order.owner_username ?? o.owner_username } : o))
        : [{ ...order, owner_username: order.owner_username ?? user.username }, ...list];
    });

  const where = (data) => `${data.node} · ${dbLabel(data.db_used)}`;

  // ------------------------------------------------------------------ pedidos
  const createOrder = (payload) =>
    withPending("form", async () => {
      try {
        const { data } = await api.createOrder(payload);
        upsertLocal(data.data);
        notify("success", `Pedido #${shortId(data.data.id)} creado (${where(data)})`);
        loadOrders({ silent: true }).catch(() => {});
      } catch (error) {
        notify("error", `No se pudo crear el pedido: ${error.message}`);
        throw error;
      }
    });

  const updateOrder = (id, payload) =>
    withPending("form", async () => {
      try {
        const { data } = await api.updateOrder(id, payload);
        upsertLocal(data.data);
        setEditing(null);
        notify("success", `Pedido #${shortId(id)} actualizado (${where(data)})`);
      } catch (error) {
        notify("error", `No se pudo actualizar: ${error.message}`);
        throw error;
      }
    });

  const advanceOrder = (order) =>
    withPending(`order:${order.id}`, async () => {
      try {
        const { data } = await api.updateOrder(order.id, { status: order.next_status });
        upsertLocal(data.data);
        notify("success", `#${shortId(order.id)} → ${STATUS_LABELS[data.data.status]} (${where(data)})`);
      } catch (error) {
        notify("error", `No se pudo cambiar el estado: ${error.message}`);
        loadOrders({ silent: true }).catch(() => {});
      }
    });

  const deleteOrder = (order) =>
    withPending(`order:${order.id}`, async () => {
      try {
        const { data } = await api.deleteOrder(order.id);
        mutateOrders((list) => list.filter((o) => o.id !== order.id));
        if (editing?.id === order.id) setEditing(null);
        notify("success", `Pedido #${shortId(order.id)} eliminado (${where(data)})`);
      } catch (error) {
        notify("error", `No se pudo eliminar: ${error.message}`);
      }
    });

  const refreshOrders = () =>
    withPending("refresh", () => loadOrders().catch((error) => notify("error", error.message)));

  // ------------------------------------------------------------------ caos
  const toggleNode = (node, enabled) =>
    withPending(`node:${node}`, async () => {
      try {
        await api.setNodeCrash(node, enabled);
        notify(
          enabled ? "warn" : "success",
          enabled
            ? `${node} caído (simulado): responde 503 y NGINX reenvía al otro nodo`
            : `${node} restaurado: vuelve a recibir tráfico`,
        );
      } catch (error) {
        notify("error", `No se pudo cambiar ${node}: ${error.message}`);
      } finally {
        refreshCluster();
      }
    });

  const toggleDb = (enabled) =>
    withPending("db", async () => {
      try {
        const { data } = await api.setDbPrimaryDown(enabled);
        if (enabled) {
          notify("warn", "db-primary caída (simulado) en todo el clúster: lecturas y escrituras van a db-replica");
        } else {
          const tables = data.sync?.tables ?? {};
          const restored = tables.orders?.copied_to_primary ?? 0;
          const auditRows = tables.audit_log?.copied_to_primary ?? 0;
          notify(
            "success",
            `db-primary restaurada · reconciliación: ${restored} pedido(s) y ${auditRows} registro(s) de auditoría copiados réplica → primaria`,
          );
        }
        loadOrders({ silent: true }).catch(() => {});
      } catch (error) {
        notify("error", `No se pudo cambiar db-primary: ${error.message}`);
      } finally {
        refreshCluster();
      }
    });

  const syncNow = () =>
    withPending("sync", async () => {
      try {
        const { data } = await api.syncReplication();
        if (data.status === "ok") {
          notify("success", `Reconciliación OK: +${data.copied_to_primary} a primaria, +${data.copied_to_replica} a réplica`);
        } else {
          notify("warn", `Reconciliación ${data.status}: ${data.detail ?? "primaria no disponible"}`);
        }
      } catch (error) {
        notify("error", `No se pudo sincronizar: ${error.message}`);
      } finally {
        refreshCluster();
      }
    });

  const testBalancing = () =>
    withPending("balance", async () => {
      const results = [];
      for (let i = 0; i < 6; i += 1) {
        try {
          // misma protección: si hubo un cambio local mientras tanto, esta lectura ya es vieja
          const seq = ++listSeq.current;
          const versionAtStart = ordersVersion.current;
          const { data, meta } = await api.listOrders();
          results.push(meta);
          applyList(data, seq, versionAtStart);
        } catch (error) {
          results.push(error.meta);
        }
        setBalance([...results]);
      }
    });

  // ------------------------------------------------------------------ secciones
  const clusterDown =
    cluster && (cluster.nodes.some((n) => !n.reachable || n.simulate_crash) || cluster.databases?.primary?.status !== "up");
  const badges = { pedidos: orders.length, ...(isAdmin && clusterDown ? { cluster: "!" } : {}) };
  const clearLog = () => setLog([]);
  const chaos = {
    lastRequest, cluster, replication, handled, pending, balance,
    onToggleNode: toggleNode, onToggleDb: toggleDb, onSync: syncNow, onTestBalancing: testBalancing,
  };

  let page;
  switch (route) {
    case "resumen":
      page = <ResumenPage cluster={cluster} replication={replication} orders={orders} lastRequest={lastRequest} handled={handled} onNavigate={navigate} />;
      break;
    case "nuevo":
      page = <NuevoPedidoPage isAdmin={isAdmin} user={user} busy={pending.form} onCreate={createOrder} lastRequest={lastRequest} onNavigate={navigate} />;
      break;
    case "conexion":
      page = <ConexionPage lastRequest={lastRequest} log={log} onClearLog={clearLog} />;
      break;
    case "cluster":
      page = <ClusterPage chaos={chaos} log={log} onClearLog={clearLog} />;
      break;
    case "monitoreo":
      page = <MonitoreoPage />;
      break;
    case "usuarios":
      page = <UsuariosPage currentUser={user} notify={notify} />;
      break;
    case "correcciones":
      page = <CorreccionesPage notify={notify} />;
      break;
    case "auditoria":
      page = <AuditoriaPage />;
      break;
    default:
      page = (
        <PedidosPage isAdmin={isAdmin} orders={orders} ordersState={ordersState} pending={pending}
                     onAdvance={advanceOrder} onEdit={setEditing} onDelete={deleteOrder} onRefresh={refreshOrders} onNavigate={navigate} />
      );
  }

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <img src="/favicon.svg" alt="" width="32" height="32" />
          <div>
            <h1>Pedidos Distribuidos</h1>
            <p>Panel logístico · sistema tolerante a fallos</p>
          </div>
        </div>
        <div className="topbar-right">
          <span className={`gateway-pill ${gatewayUp ? "up" : "down"}`}>
            <span className="dot" />
            <span>
              <span className="gateway-label">Gateway NGINX </span>
              {gatewayUp ? "conectado" : "sin backends"}
            </span>
          </span>
          {isAdmin && (
            <a className="topbar-link" href="/api/docs" target="_blank" rel="noreferrer">
              API docs
            </a>
          )}
          <span className="user-chip" title={`Sesión: ${user.username}`}>
            <span className="user-name">{user.full_name}</span>
            <span className={`role-badge role-${user.role}`}>{isAdmin ? "Administrador" : "Cliente"}</span>
          </span>
          <button type="button" className="topbar-link topbar-button" onClick={onLogout}>
            <Icon name="logout" size={15} /> Cerrar sesión
          </button>
        </div>
      </header>

      <div className="shell">
        <Sidebar role={user.role} route={route} onNavigate={navigate} badges={badges} />
        <main className="content" data-route={route}>
          {page}
        </main>
      </div>

      {editing && (
        <Dialog title={`Editar pedido #${shortId(editing.id)}`} onClose={() => setEditing(null)}>
          <OrderForm editing={editing} busy={pending.form} onUpdate={updateOrder} onCancelEdit={() => setEditing(null)} embedded />
        </Dialog>
      )}
      <Toasts toasts={toasts} onDismiss={dismiss} />
    </div>
  );
}
