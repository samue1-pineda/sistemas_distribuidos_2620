import { useCallback, useEffect, useMemo, useState } from "react";
import { api } from "../api.js";
import { formatClock, formatDuration, formatNumber, formatPercent, nodeTone } from "../format.js";
import LineChart from "./LineChart.jsx";
import { NodeChip } from "./ClusterPanel.jsx";

const POLL_MS = 3000;
const RANGES = [
  { seconds: 300, label: "Últimos 5 min" },
  { seconds: 900, label: "Últimos 15 min" },
];
// Colores de serie validados para daltonismo (ver styles.css): azul = Alpha, naranja = Beta.
const SERIES_COLORS = { alpha: "#2563eb", beta: "#eb6834", other: "#64748b" };

const EVENT_GROUPS = [
  { key: "todos", label: "Todos", kinds: null },
  { key: "failover", label: "Failover", kinds: ["failover", "replication"] },
  { key: "chaos", label: "Caos", kinds: ["chaos"] },
  { key: "sync", label: "Reconciliación", kinds: ["sync"] },
  { key: "security", label: "Seguridad", kinds: ["auth", "security"] },
  { key: "system", label: "Sistema", kinds: ["schema", "lifecycle", "other"] },
];
const KIND_LABELS = {
  failover: "Failover BD",
  replication: "Replicación",
  sync: "Reconciliación",
  chaos: "Caos",
  auth: "Seguridad",
  security: "Seguridad",
  schema: "Esquema",
  lifecycle: "Arranque",
  other: "Otro",
};

function nodeState(node) {
  if (!node.reachable) return { tone: "down", label: "Inalcanzable" };
  if (node.chaos?.simulate_crash) return { tone: "crash", label: "Caída simulada (503)" };
  return { tone: "up", label: "Operativo" };
}

function StatTile({ label, value, hint, status }) {
  return (
    <div className="stat-tile">
      <span className="stat-label">{label}</span>
      <span className="stat-value">{value}</span>
      {hint && <span className={`stat-hint ${status ? `stat-${status}` : "muted"}`}>{hint}</span>}
    </div>
  );
}

function Metric({ label, children }) {
  return (
    <div className="metric">
      <dt>{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}

function NodeCard({ node }) {
  const state = nodeState(node);
  if (!node.reachable) {
    return (
      <article className={`card node-card tile-${state.tone}`}>
        <header className="node-card-head">
          <NodeChip node={node.node} />
          <span className={`pill pill-${state.tone}`}>{state.label}</span>
        </header>
        <p className="muted small">No respondió a la consulta REST del monitoreo: {node.error}</p>
      </article>
    );
  }
  const total = node.traffic.total;
  const latency = node.latency_ms;
  return (
    <article className={`card node-card tile-${state.tone}`}>
      <header className="node-card-head">
        <NodeChip node={node.node} />
        <span className={`pill pill-${state.tone}`}>{state.label}</span>
        {node.self && <span className="muted small">(reporta)</span>}
      </header>
      <dl className="metrics-grid">
        <Metric label="En línea">{formatDuration(node.uptime_seconds)}</Metric>
        <Metric label="Peticiones / min">{formatNumber(node.traffic.requests_per_minute)}</Metric>
        <Metric label="Peticiones (total)">{formatNumber(total.requests)}</Metric>
        <Metric label="Latencia p50 · p95">
          {latency.p50 == null ? "—" : `${latency.p50} · ${latency.p95} ms`}
        </Metric>
        <Metric label="Errores 4xx · 5xx">
          {formatNumber(total.client_errors)} · {formatNumber(total.server_errors)}
        </Metric>
        <Metric label="503 simulados">{formatNumber(total.simulated_crash)}</Metric>
        <Metric label="Servidas por la réplica">{formatNumber(total.replica_served)}</Metric>
        <Metric label="Failovers de BD">{formatNumber(node.database.failover_count)}</Metric>
        <Metric label="Circuit breaker">{node.database.circuit_breaker === "open" ? "Abierto" : "Cerrado"}</Metric>
        <Metric label="Versión · Python">
          {node.version} · {node.python}
        </Metric>
      </dl>
      {node.database.last_primary_error && (
        // En rojo sólo mientras el problema sigue activo; si no, queda como historial.
        <p
          className={`small ${
            node.database.circuit_breaker === "open" || node.chaos.simulate_db_primary_down ? "node-card-error" : "node-card-history"
          }`}
        >
          Último error de db-primary ({formatClock(node.database.last_primary_error_at)}): {node.database.last_primary_error}
        </p>
      )}
    </article>
  );
}

function GatewayCard({ gateway }) {
  return (
    <article className="card">
      <header className="card-head">
        <h3>Gateway NGINX</h3>
        <span className="muted small">stub_status interno</span>
      </header>
      {!gateway?.configured ? (
        <p className="muted small">No configurado (variable GATEWAY_STATUS_URL de los nodos).</p>
      ) : !gateway.reachable ? (
        <p className="node-card-error small">No se pudo leer el estado del gateway: {gateway.error}</p>
      ) : (
        <dl className="metrics-grid">
          <Metric label="Conexiones activas">{formatNumber(gateway.active)}</Metric>
          <Metric label="Peticiones atendidas">{formatNumber(gateway.requests)}</Metric>
          <Metric label="Conexiones aceptadas">{formatNumber(gateway.accepts)}</Metric>
          <Metric label="Leyendo · escribiendo · en espera">
            {gateway.reading} · {gateway.writing} · {gateway.waiting}
          </Metric>
        </dl>
      )}
    </article>
  );
}

function dbLine(info) {
  if (!info) return "—";
  if (info.status === "up") return `Operativa · ${info.latency_ms} ms`;
  if (info.status === "simulated_down") return "Caída simulada";
  return "Caída (real)";
}

function DatabasesCard({ databases }) {
  const health = databases?.health;
  const replication = databases?.replication;
  const rows = (name) => replication?.[name];
  const lastSync = health?.last_sync;
  return (
    <article className="card">
      <header className="card-head">
        <h3>Bases de datos</h3>
        <span className={`pill ${replication?.in_sync ? "pill-up" : "pill-warn"}`}>
          {replication?.in_sync ? "✓ En sincronía" : "⚠ Divergentes o sin verificar"}
        </span>
      </header>
      <dl className="metrics-grid">
        <Metric label="db-primary">{dbLine(health?.primary)}</Metric>
        <Metric label="db-replica">{dbLine(health?.replica)}</Metric>
        <Metric label="Pedidos · usuarios (primaria)">
          {rows("primary")?.rows ?? "—"} · {rows("primary")?.users ?? "—"}
        </Metric>
        <Metric label="Pedidos · usuarios (réplica)">
          {rows("replica")?.rows ?? "—"} · {rows("replica")?.users ?? "—"}
        </Metric>
        <Metric label="Filas divergentes">
          {replication?.divergent_by_table
            ? Object.entries(replication.divergent_by_table)
                .map(([table, count]) => `${table}: ${count}`)
                .join(" · ")
            : "no verificable"}
        </Metric>
        <Metric label="Última reconciliación">
          {lastSync ? `${formatClock(lastSync.at)} (${lastSync.status})` : "—"}
        </Metric>
      </dl>
    </article>
  );
}

function EventsCard({ events }) {
  const [group, setGroup] = useState("todos");
  const selected = EVENT_GROUPS.find((g) => g.key === group);
  const visible = selected.kinds ? events.filter((e) => selected.kinds.includes(e.kind)) : events;
  return (
    <section className="card events-card" aria-labelledby="events-title">
      <header className="card-head">
        <h3 id="events-title">Eventos del clúster</h3>
        <span className="muted small">Capturados de los logs de cada nodo · los repetidos se agrupan</span>
      </header>
      <div className="chips events-filter" role="tablist" aria-label="Filtrar eventos">
        {EVENT_GROUPS.map((g) => (
          <button
            key={g.key}
            type="button"
            role="tab"
            aria-selected={group === g.key}
            className={`chip ${group === g.key ? "chip-active" : ""}`}
            onClick={() => setGroup(g.key)}
          >
            {g.label}
          </button>
        ))}
      </div>
      {visible.length === 0 ? (
        <p className="muted">Sin eventos en esta categoría.</p>
      ) : (
        <div className="table-wrap events-wrap">
          <table className="events-table">
            <thead>
              <tr>
                <th>Hora</th>
                <th>Nodo</th>
                <th>Tipo</th>
                <th>Mensaje</th>
                <th className="num">Veces</th>
              </tr>
            </thead>
            <tbody>
              {visible.map((event) => (
                <tr key={`${event.node}-${event.at}-${event.message}`}>
                  <td className="mono muted nowrap">{formatClock(event.at * 1000)}</td>
                  <td>
                    <NodeChip node={event.node} />
                  </td>
                  <td className="nowrap">
                    <span className={`level level-${event.level}`}>
                      {event.level === "error" ? "✖" : event.level === "warning" ? "⚠" : "●"} {KIND_LABELS[event.kind] ?? event.kind}
                    </span>
                  </td>
                  <td className="event-message">{event.message}</td>
                  <td className="num mono">{event.count > 1 ? `×${event.count}` : ""}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

export default function MonitoringPanel() {
  const [range, setRange] = useState(300);
  const [paused, setPaused] = useState(false);
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(false);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const { data: view } = await api.monitoringCluster(range);
      setData(view);
      setError(null);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, [range]);

  useEffect(() => {
    refresh();
    if (paused) return undefined;
    const timer = setInterval(() => {
      if (!document.hidden) refresh();
    }, POLL_MS);
    return () => clearInterval(timer);
  }, [refresh, paused]);

  const reachable = useMemo(() => (data?.nodes ?? []).filter((n) => n.reachable), [data]);
  const times = reachable[0]?.timeseries.map((b) => b.t) ?? [];
  const seriesFor = (field) =>
    reachable
      .slice()
      .sort((a, b) => a.node.localeCompare(b.node))
      .map((node) => {
        const byTime = new Map(node.timeseries.map((b) => [b.t, b[field]]));
        return {
          key: node.node,
          label: node.node,
          color: SERIES_COLORS[nodeTone(node.node)] ?? SERIES_COLORS.other,
          values: times.map((t) => byTime.get(t) ?? null),
        };
      });
  const summary = data?.summary;
  const degraded = summary && summary.nodes_up < summary.nodes_total;

  return (
    <section className={`monitoring ${loading && data ? "is-refreshing" : ""}`} aria-label="Monitoreo de nodos">

      <div className="filter-row">
        <div className="chips" role="tablist" aria-label="Rango de tiempo">
          {RANGES.map((r) => (
            <button
              key={r.seconds}
              type="button"
              role="tab"
              aria-selected={range === r.seconds}
              className={`chip ${range === r.seconds ? "chip-active" : ""}`}
              onClick={() => setRange(r.seconds)}
            >
              {r.label}
            </button>
          ))}
        </div>
        <button type="button" className="btn btn-ghost btn-sm" onClick={() => setPaused((p) => !p)} aria-pressed={paused}>
          {paused ? "▶ Reanudar actualización" : "❚❚ Pausar actualización"}
        </button>
        <span className="muted small">
          {paused ? "En pausa" : "Se actualiza cada 3 s"}
          {data ? ` · reportado por ${data.reporter} a las ${formatClock(data.generated_at * 1000)}` : " · cargando…"}
        </span>
      </div>

      {error && <p className="form-error">No se pudo obtener el monitoreo: {error}</p>}

      {summary && (
        <>
          <div className="stat-row">
            <StatTile
              label="Nodos operativos"
              value={`${summary.nodes_up} / ${summary.nodes_total}`}
              hint={degraded ? "⚠ hay nodos fuera de servicio" : "✓ todos atienden tráfico"}
              status={degraded ? "warn" : "ok"}
            />
            <StatTile label="Peticiones por minuto" value={formatNumber(summary.requests_per_minute)} hint="suma de los nodos" />
            <StatTile
              label="Errores 5xx"
              value={formatPercent(summary.error_rate)}
              hint={`${formatNumber(summary.window_server_errors)} de ${formatNumber(summary.window_requests)} en la ventana`}
            />
            <StatTile
              label="Latencia p95"
              value={summary.latency_p95_worst_ms == null ? "—" : `${summary.latency_p95_worst_ms} ms`}
              hint="nodo más lento"
            />
            <StatTile
              label="Atendidas por la réplica"
              value={formatNumber(summary.window_replica_served)}
              hint="en la ventana (failover de BD)"
            />
            <StatTile label="Failovers de BD" value={formatNumber(summary.db_failovers)} hint="acumulado de los nodos" />
          </div>

          <div className="charts-grid">
            <LineChart
              title="Peticiones por nodo"
              subtitle="Cantidad cada 10 s (Round-Robin reparte por turnos)"
              times={times}
              series={seriesFor("requests")}
              format={(v) => formatNumber(Math.round(v))}
            />
            <LineChart
              title="Latencia media por nodo"
              subtitle="Milisegundos, cada 10 s · hueco = sin tráfico"
              times={times}
              series={seriesFor("latency_avg_ms")}
              format={(v) => formatNumber(Math.round(v))}
              unit=" ms"
            />
          </div>

          <div className="nodes-grid">
            {data.nodes
              .slice()
              .sort((a, b) => a.node.localeCompare(b.node))
              .map((node) => (
                <NodeCard key={node.node} node={node} />
              ))}
          </div>

          <div className="infra-grid">
            <GatewayCard gateway={data.gateway} />
            <DatabasesCard databases={data.databases} />
          </div>

          <EventsCard events={data.events} />
        </>
      )}
    </section>
  );
}
