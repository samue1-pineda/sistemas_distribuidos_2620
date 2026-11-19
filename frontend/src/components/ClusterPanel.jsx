import { dbLabel, formatClock, nodeTone, upstreamAttempts } from "../format.js";

function NodeChip({ node, large = false }) {
  return (
    <span className={`node-chip tone-${nodeTone(node)} ${large ? "node-chip--large" : ""}`}>
      <span className="dot" />
      {node ?? "Sin respuesta"}
    </span>
  );
}

function DbChip({ dbUsed }) {
  if (!dbUsed) return <span className="db-chip db-none">—</span>;
  return <span className={`db-chip ${dbUsed === "primary" ? "db-primary" : "db-failover"}`}>{dbLabel(dbUsed)}</span>;
}

export function LastRequestCard({ meta }) {
  const attempts = upstreamAttempts(meta?.upstreamStatus);
  const retried = attempts.length > 1;
  return (
    <article className="card last-request" aria-live="polite" data-request-id={meta?.id ?? ""}>
      <header className="card-head">
        <h3>Última petición</h3>
        {meta && <span className="muted mono">{formatClock(meta.at)}</span>}
      </header>
      {!meta ? (
        <p className="muted">Aún no hay peticiones.</p>
      ) : (
        <>
          <div className="lr-row">
            <span className="lr-label">Nodo que respondió</span>
            <NodeChip node={meta.node} large />
          </div>
          <div className="lr-row">
            <span className="lr-label">Base de datos usada</span>
            <DbChip dbUsed={meta.dbUsed} />
          </div>
          <div className="lr-meta mono">
            <span className="method">{meta.method}</span> {meta.path}
            <span className={`http-code ${meta.ok ? "ok" : "fail"}`}>{meta.status || "ERR"}</span>
            <span className="muted">{meta.durationMs} ms</span>
          </div>
          {retried && (
            <p className="callout callout-warn">
              <strong>Failover de nodo en NGINX:</strong> intentos {attempts.join(" → ")}. El primer nodo falló y
              el gateway reintentó en el otro sin que el usuario viera el error.
            </p>
          )}
          {meta.dbUsed === "replica_failover" && (
            <p className="callout callout-amber">
              <strong>Failover de BD:</strong> db-primary no respondió; la operación se atendió en db-replica
              {meta.replication === "pending" ? " y se copiará a la primaria al recuperarse." : "."}
            </p>
          )}
        </>
      )}
    </article>
  );
}

function nodeState(node) {
  if (!node.reachable) return { tone: "down", label: "Inalcanzable" };
  if (node.simulate_crash) return { tone: "crash", label: "Caída simulada (503)" };
  return { tone: "up", label: "Operativo" };
}

export function NodesCard({ nodes, handled, pending, onToggleNode, onTestBalancing, balance }) {
  return (
    <article className="card">
      <header className="card-head">
        <h3>Nodos backend</h3>
        <span className="muted">Round-Robin vía NGINX</span>
      </header>
      <div className="tiles">
        {nodes.length === 0 && <p className="muted">Sin datos del clúster.</p>}
        {nodes.map((node) => {
          const name = node.node ?? node.url;
          const state = nodeState(node);
          const busy = pending[`node:${name}`];
          return (
            <div key={name} className={`tile tile-${state.tone}`}>
              <div className="tile-top">
                <NodeChip node={name} />
                <span className={`pill pill-${state.tone}`}>{state.label}</span>
              </div>
              <p className="tile-sub muted">
                Peticiones atendidas en esta sesión: <strong>{handled[name] ?? 0}</strong>
              </p>
              <button
                type="button"
                className={node.simulate_crash ? "btn btn-success" : "btn btn-danger"}
                disabled={!node.reachable || busy}
                onClick={() => onToggleNode(name, !node.simulate_crash)}
              >
                {busy ? "Aplicando…" : node.simulate_crash ? "Restaurar nodo" : "Simular Caída de Nodo"}
              </button>
            </div>
          );
        })}
      </div>
      <div className="balance">
        <button type="button" className="btn btn-ghost" disabled={pending.balance} onClick={onTestBalancing}>
          {pending.balance ? "Enviando…" : "Probar balanceo (6 peticiones)"}
        </button>
        <div className="balance-strip" aria-label="Resultado de la prueba de balanceo">
          {balance.map((meta, index) => (
            <span
              key={meta.id ?? index}
              className={`balance-cell tone-${meta.ok ? nodeTone(meta.node) : "fail"}`}
              title={`${meta.node ?? "error"} · HTTP ${meta.status} · upstream ${meta.upstreamStatus ?? "—"}`}
            >
              {meta.ok ? (nodeTone(meta.node) === "alpha" ? "α" : nodeTone(meta.node) === "beta" ? "β" : "?") : "×"}
            </span>
          ))}
        </div>
      </div>
    </article>
  );
}

function dbState(info) {
  if (!info) return { tone: "down", label: "Sin datos" };
  if (info.status === "up") return { tone: "up", label: `Operativa${info.latency_ms != null ? ` · ${info.latency_ms} ms` : ""}` };
  if (info.status === "simulated_down") return { tone: "crash", label: "Caída simulada" };
  return { tone: "down", label: "Caída (real)" };
}

export function DatabasesCard({ databases, replication, primaryDown, pending, onToggleDb, onSync }) {
  const primary = dbState(databases?.primary);
  const replica = dbState(databases?.replica);
  const lastSync = databases?.last_sync;
  const inSync = replication?.in_sync;
  return (
    <article className="card">
      <header className="card-head">
        <h3>Bases de datos</h3>
        <span className="muted">PostgreSQL 16 · escritura dual</span>
      </header>
      <div className="tiles">
        <div className={`tile tile-${primary.tone}`}>
          <div className="tile-top">
            <span className="db-name">db-primary</span>
            <span className={`pill pill-${primary.tone}`}>{primary.label}</span>
          </div>
          <p className="tile-sub muted">
            Filas: {replication?.primary?.rows ?? "—"} · Circuit breaker: {databases?.circuit_breaker === "open" ? "abierto" : "cerrado"}
          </p>
          <button
            type="button"
            className={primaryDown ? "btn btn-success" : "btn btn-danger"}
            disabled={pending.db}
            onClick={() => onToggleDb(!primaryDown)}
          >
            {pending.db ? "Aplicando…" : primaryDown ? "Restaurar BD Primaria" : "Simular Caída de BD Primaria"}
          </button>
        </div>
        <div className={`tile tile-${replica.tone}`}>
          <div className="tile-top">
            <span className="db-name">db-replica</span>
            <span className={`pill pill-${replica.tone}`}>{replica.label}</span>
          </div>
          <p className="tile-sub muted">Filas: {replication?.replica?.rows ?? "—"} · recibe cada escritura</p>
          <button type="button" className="btn btn-ghost" disabled={pending.sync} onClick={onSync}>
            {pending.sync ? "Sincronizando…" : "Sincronizar ahora"}
          </button>
        </div>
      </div>
      <div className={`sync-line ${inSync ? "sync-ok" : "sync-warn"}`}>
        <strong>{inSync ? "✓ Réplica en sincronía" : replication?.divergent_orders != null ? `⚠ ${replication.divergent_orders} pedido(s) divergentes` : "⚠ Sincronía no verificable (primaria no disponible)"}</strong>
        <span className="muted">
          Última reconciliación: {lastSync ? `${formatClock(lastSync.at)} (${lastSync.status}${lastSync.copied_to_primary || lastSync.copied_to_replica ? `, +${(lastSync.copied_to_primary ?? 0) + (lastSync.copied_to_replica ?? 0)} filas` : ""})` : "—"}
        </span>
      </div>
    </article>
  );
}

export default function ClusterPanel({
  lastRequest,
  cluster,
  replication,
  handled,
  pending,
  balance,
  onToggleNode,
  onToggleDb,
  onSync,
  onTestBalancing,
}) {
  const nodes = [...(cluster?.nodes ?? [])].sort((a, b) => (a.node ?? a.url).localeCompare(b.node ?? b.url));
  return (
    <section className="cluster" aria-labelledby="cluster-title">
      <div className="section-head">
        <h2 id="cluster-title">Controles de caos</h2>
        <span className="muted">
          Reportado por {cluster?.reporter ?? "—"} · se actualiza cada 3 s
        </span>
      </div>
      <div className="cluster-grid">
        <LastRequestCard meta={lastRequest} />
        <NodesCard
          nodes={nodes}
          handled={handled}
          pending={pending}
          balance={balance}
          onToggleNode={onToggleNode}
          onTestBalancing={onTestBalancing}
        />
        <DatabasesCard
          databases={cluster?.databases}
          replication={replication}
          primaryDown={Boolean(cluster?.simulate_db_primary_down)}
          pending={pending}
          onToggleDb={onToggleDb}
          onSync={onSync}
        />
      </div>
    </section>
  );
}

export { NodeChip, DbChip };
