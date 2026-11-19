import { useCallback, useEffect, useRef, useState } from "react";
import { dbLabel, nodeTone, upstreamAttempts } from "../format.js";

// Topología del clúster en vivo: Clientes → Gateway NGINX → Nodo Alpha / Nodo Beta → db-primary / db-replica.
// Cada petición real se dibuja como un "paquete" que recorre el camino que siguió (incluidos los reintentos
// de NGINX y el failover a la réplica). Colores de nodo validados para daltonismo sobre fondo oscuro
// (azul #3987e5 / naranja #d95926); el estado siempre va acompañado de texto, nunca sólo de color.

const NODE_COLORS = { alpha: "#3987e5", beta: "#d95926", other: "#94a3b8" };
const STATUS = {
  up: { color: "#22c55e", label: "Operativo" },
  crash: { color: "#ef4444", label: "Caída simulada (503)" },
  down: { color: "#ef4444", label: "Inalcanzable" },
  unknown: { color: "#64748b", label: "" },
};
const DB_STATUS = {
  up: { color: "#22c55e", label: "Operativa" },
  simulated_down: { color: "#ef4444", label: "Caída simulada" },
  down: { color: "#ef4444", label: "Caída" },
  unknown: { color: "#64748b", label: "" },
};

// Geometría (viewBox 1000 × 380)
const POS = {
  clients: { x: 95, y: 190 },
  gateway: { x: 320, y: 190 },
  alpha: { x: 575, y: 95 },
  beta: { x: 575, y: 285 },
  primary: { x: 855, y: 95 },
  replica: { x: 855, y: 285 },
};
const BOX_W = 180;
const BOX_H = 80;
const half = BOX_W / 2;

const gwToNode = (n) => `M${POS.gateway.x + half},190 C${POS.gateway.x + half + 40},190 ${POS.alpha.x - half - 40},${POS[n].y} ${POS.alpha.x - half},${POS[n].y}`;
const nodeToDb = (n, db) => {
  const from = POS[n];
  const to = POS[db];
  if (from.y === to.y) return `M${from.x + half},${from.y} L${to.x - half},${to.y}`;
  return `M${from.x + half},${from.y} C${from.x + half + 50},${from.y} ${to.x - half - 50},${to.y} ${to.x - half},${to.y}`;
};
// Recorrido completo de un paquete (pasa "por dentro" de las cajas, que se dibujan encima).
const route = (n, db) => {
  const ny = POS[n].y;
  const dy = POS[db].y;
  const toDb = ny === dy ? `L${POS[db].x},${dy}` : `C${POS[n].x + half + 50},${ny} ${POS[db].x - half - 50},${dy} ${POS[db].x - half},${dy} L${POS[db].x},${dy}`;
  return `M${POS.clients.x + 60},190 L${POS.gateway.x + half},190 C${POS.gateway.x + half + 40},190 ${POS.alpha.x - half - 40},${ny} ${POS.alpha.x - half},${ny} L${POS[n].x + half},${ny} ${toDb}`;
};
const rejectedRoute = (n) =>
  `M${POS.clients.x + 60},190 L${POS.gateway.x + half},190 C${POS.gateway.x + half + 40},190 ${POS.alpha.x - half - 40},${POS[n].y} ${POS.alpha.x - half},${POS[n].y}`;

const prefersReducedMotion = () =>
  typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;

function Packet({ d, color, duration, failed, onDone }) {
  const pathRef = useRef(null);
  const dotRef = useRef(null);
  useEffect(() => {
    const path = pathRef.current;
    if (!path) return undefined;
    const total = path.getTotalLength();
    const start = performance.now();
    let frame;
    const step = (now) => {
      const t = Math.min(1, (now - start) / duration);
      const eased = t < 0.5 ? 2 * t * t : -1 + (4 - 2 * t) * t;
      const point = path.getPointAtLength(eased * total);
      dotRef.current?.setAttribute("transform", `translate(${point.x},${point.y})`);
      if (t < 1) frame = requestAnimationFrame(step);
      else onDone();
    };
    frame = requestAnimationFrame(step);
    return () => cancelAnimationFrame(frame);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return (
    <g className={`topo-packet ${failed ? "is-failed" : ""}`}>
      <path ref={pathRef} d={d} fill="none" stroke="none" />
      <g ref={dotRef} transform={`translate(${POS.clients.x + 60},190)`}>
        <circle r="11" fill={color} opacity="0.22" />
        <circle r="5.5" fill={color} stroke="#0b1424" strokeWidth="2" />
      </g>
    </g>
  );
}

function Box({ id, x, y, title, status, statusLabel, detail, accent, className = "", icon, width = BOX_W, height = BOX_H }) {
  const left = x - width / 2;
  const top = y - height / 2;
  return (
    <g className={`topo-node ${className}`} data-node={id}>
      <rect className="topo-box" x={left} y={top} width={width} height={height} rx="14" stroke={status.color} />
      {accent && <rect x={left} y={top + 14} width="4" height={height - 28} rx="2" fill={accent} />}
      <circle className="topo-status-dot" cx={left + 20} cy={top + 24} r="5" fill={status.color} />
      <text className="topo-title" x={left + 32} y={top + 28}>
        {icon && <tspan className="topo-icon">{icon} </tspan>}
        {title}
      </text>
      {statusLabel && (
        <text className="topo-status" x={left + 16} y={top + 50} fill={status.color}>
          {statusLabel}
        </text>
      )}
      {detail && (
        <text className="topo-detail" x={left + 16} y={top + (statusLabel ? 68 : 52)}>
          {detail}
        </text>
      )}
    </g>
  );
}

function EdgeLabel({ x, y, text, tone = "neutral" }) {
  const width = text.length * 6.4 + 16;
  return (
    <g className={`topo-edge-label tone-${tone}`}>
      <rect x={x - width / 2} y={y - 10} width={width} height="20" rx="10" />
      <text x={x} y={y + 4} textAnchor="middle">
        {text}
      </text>
    </g>
  );
}

/**
 * mode: "admin" (estado real del clúster), "client" (sólo el recorrido de la última petición del usuario)
 * o "demo" (animación de ejemplo en la pantalla de inicio de sesión).
 */
export default function ClusterTopology({ mode = "admin", cluster, replication, lastRequest, handled = {} }) {
  const [packets, setPackets] = useState([]);
  const seq = useRef(0);

  const names = { alpha: "Nodo-Alpha-01", beta: "Nodo-Beta-02" };
  (cluster?.nodes ?? []).forEach((n) => {
    const tone = nodeTone(n.node);
    if (tone === "alpha" || tone === "beta") names[tone] = n.node;
  });
  const nodeInfo = (tone) => cluster?.nodes?.find((n) => nodeTone(n.node) === tone);
  const nodeState = (tone) => {
    if (mode !== "admin") return "unknown";
    const info = nodeInfo(tone);
    if (!info) return "unknown";
    if (!info.reachable) return "down";
    return info.simulate_crash ? "crash" : "up";
  };
  const dbState = (name) => {
    if (mode === "admin") return cluster?.databases?.[name]?.status ?? "unknown";
    if (mode === "client" && lastRequest?.dbUsed === "replica_failover") return name === "primary" ? "down" : "up";
    return "unknown";
  };
  const primaryState = dbState("primary");
  const failover = primaryState !== "up" && primaryState !== "unknown";

  // Último recorrido (para resaltar las aristas y para el resumen en texto)
  const lastNode = nodeTone(lastRequest?.node);
  const lastDb = lastRequest?.dbUsed === "replica_failover" ? "replica" : lastRequest?.dbUsed === "primary" ? "primary" : null;
  const attempts = upstreamAttempts(lastRequest?.upstreamStatus);
  const retried = attempts.length > 1;
  const onPath = (edge) => {
    if (!lastRequest?.node || (lastNode !== "alpha" && lastNode !== "beta")) return false;
    if (edge === "clients-gateway") return true;
    if (edge === `gateway-${lastNode}`) return true;
    return lastDb != null && edge === `${lastNode}-${lastDb}`;
  };

  const spawn = useCallback((items) => {
    if (prefersReducedMotion()) return;
    items.forEach(({ delay = 0, ...packet }) => {
      setTimeout(() => {
        const id = ++seq.current;
        setPackets((list) => [...list.slice(-11), { id, ...packet }]);
      }, delay);
    });
  }, []);
  const remove = useCallback((id) => setPackets((list) => list.filter((p) => p.id !== id)), []);

  // Cada petición real dispara su paquete (y el intento fallido si NGINX reintentó).
  useEffect(() => {
    if (mode === "demo" || !lastRequest?.node) return;
    const tone = nodeTone(lastRequest.node);
    if (tone !== "alpha" && tone !== "beta") return;
    const db = lastDb ?? "primary";
    const items = [];
    if (retried) {
      const other = tone === "alpha" ? "beta" : "alpha";
      items.push({ d: rejectedRoute(other), color: "#ef4444", failed: true, duration: 650 });
      items.push({ d: lastDb ? route(tone, db) : rejectedRoute(tone), color: NODE_COLORS[tone], duration: 1000, delay: 520 });
    } else {
      items.push({ d: lastDb ? route(tone, db) : rejectedRoute(tone), color: NODE_COLORS[tone], duration: 1000 });
    }
    spawn(items);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lastRequest?.id]);

  // Demostración: tráfico Round-Robin continuo en la pantalla de inicio de sesión.
  useEffect(() => {
    if (mode !== "demo") return undefined;
    let turn = 0;
    const timer = setInterval(() => {
      const tone = turn % 2 === 0 ? "alpha" : "beta";
      turn += 1;
      spawn([{ d: route(tone, "primary"), color: NODE_COLORS[tone], duration: 1300 }]);
    }, 1100);
    return () => clearInterval(timer);
  }, [mode, spawn]);

  const edgeClass = (edge, base = "") => `topo-edge ${base} ${onPath(edge) ? "is-path" : ""}`;
  const gwEdgeState = (tone) => {
    const state = nodeState(tone);
    return state === "up" ? "is-active" : state === "unknown" ? "" : "is-down";
  };
  const dbDetail = (name) => {
    if (mode !== "admin") return "PostgreSQL 16";
    const info = cluster?.databases?.[name];
    const rows = replication?.[name]?.rows;
    const parts = [];
    if (rows != null) parts.push(`${rows} pedidos`);
    if (info?.latency_ms != null) parts.push(`${info.latency_ms} ms`);
    return parts.join(" · ") || "PostgreSQL 16";
  };
  const nodeDetail = (tone) => {
    if (mode !== "admin") return "FastAPI · Python 3.11";
    return `${handled[names[tone]] ?? 0} peticiones en esta sesión`;
  };
  const statusOf = (tone) => {
    const state = nodeState(tone);
    return { ...STATUS[state], label: state === "unknown" ? "" : STATUS[state].label };
  };
  const dbStatusOf = (name) => {
    const state = dbState(name);
    const s = DB_STATUS[state] ?? DB_STATUS.down;
    if (mode === "client" && state !== "unknown") {
      return { ...s, label: state === "up" ? "Atendió tu petición" : "No respondió" };
    }
    return s;
  };
  const inSync = replication?.in_sync;
  const syncTone = mode !== "admin" ? "neutral" : inSync ? "ok" : "warn";

  const summary = lastRequest?.node
    ? `${lastRequest.method} ${lastRequest.path} → ${retried ? `reintento de NGINX (${attempts.join(" → ")}) → ` : ""}${lastRequest.node}${
        lastDb ? ` → ${lastDb === "replica" ? "db-replica (failover)" : "db-primary"}` : ""
      }`
    : mode === "demo"
      ? "Ejemplo: NGINX reparte las peticiones por turnos entre los dos nodos."
      : "Esperando la primera petición…";

  return (
    <figure className={`topology topology--${mode}`} aria-label="Topología del clúster distribuido">
      <svg viewBox="0 0 1000 380" className="topo-svg" role="img" aria-labelledby="topo-desc">
        <desc id="topo-desc">
          {`Clientes, gateway NGINX, ${names.alpha} y ${names.beta}, db-primary y db-replica. ${summary}`}
        </desc>
        {/* aristas */}
        <path className={edgeClass("clients-gateway", "is-active")} data-edge="clients-gateway" d={`M${POS.clients.x + 65},190 L${POS.gateway.x - half},190`} />
        {["alpha", "beta"].map((tone) => (
          <path key={tone} className={edgeClass(`gateway-${tone}`, gwEdgeState(tone))} data-edge={`gateway-${tone}`} d={gwToNode(tone)} />
        ))}
        {["alpha", "beta"].map((tone) => (
          <g key={tone}>
            <path className={edgeClass(`${tone}-primary`, failover ? "is-down" : "is-db")} data-edge={`${tone}-primary`} d={nodeToDb(tone, "primary")} />
            <path className={edgeClass(`${tone}-replica`, failover ? "is-failover" : "is-standby")} data-edge={`${tone}-replica`} d={nodeToDb(tone, "replica")} />
          </g>
        ))}
        <path className={`topo-edge topo-sync tone-${syncTone}`} data-edge="primary-replica" d={`M${POS.primary.x},${POS.primary.y + BOX_H / 2} L${POS.replica.x},${POS.replica.y - BOX_H / 2}`} />

        {/* etiquetas de aristas */}
        {["alpha", "beta"].map((tone) =>
          nodeState(tone) === "crash" ? (
            <EdgeLabel key={tone} x={426} y={tone === "alpha" ? 128 : 252} text="503 → reintento" tone="danger" />
          ) : nodeState(tone) === "down" ? (
            <EdgeLabel key={tone} x={426} y={tone === "alpha" ? 128 : 252} text="✕ sin respuesta" tone="danger" />
          ) : null,
        )}
        {failover && <EdgeLabel x={715} y={190} text="failover → réplica" tone="warn" />}
        <EdgeLabel
          x={POS.primary.x + 62}
          y={190}
          text={mode !== "admin" ? "escritura dual" : inSync ? "✓ en sincronía" : "⚠ reconciliando"}
          tone={syncTone}
        />

        {/* paquetes (debajo de las cajas) */}
        {packets.map((p) => (
          <Packet key={p.id} d={p.d} color={p.color} duration={p.duration} failed={p.failed} onDone={() => remove(p.id)} />
        ))}

        {/* cajas */}
        <Box id="clients" {...POS.clients} width={130} height={70} title={mode === "client" ? "Tú" : "Clientes"} icon="◉"
             status={STATUS.up} statusLabel="" detail={mode === "client" ? "navegador" : "navegadores"} />
        <Box id="gateway" {...POS.gateway} title="Gateway NGINX" status={{ color: "#2dd4bf" }} statusLabel="Round-Robin + failover"
             detail="balanceador · puerto 80" className="topo-gateway" />
        {["alpha", "beta"].map((tone) => {
          const status = statusOf(tone);
          return (
            <Box key={tone} id={tone} {...POS[tone]} title={names[tone]} status={status} statusLabel={status.label}
                 detail={nodeDetail(tone)} accent={NODE_COLORS[tone]} className={`topo-${nodeState(tone)} ${lastNode === tone ? "is-last" : ""}`} />
          );
        })}
        {["primary", "replica"].map((name) => {
          const status = dbStatusOf(name);
          return (
            <Box key={name} id={name} {...POS[name]} title={`db-${name}`} icon="⛁" status={status} statusLabel={status.label}
                 detail={dbDetail(name)} className={`topo-db topo-${dbState(name)} ${lastDb === name ? "is-last" : ""}`} />
          );
        })}
      </svg>
      <figcaption className="topo-caption">
        <span className="topo-live">
          <span className="topo-live-dot" /> {mode === "demo" ? "Demostración" : "En vivo"}
        </span>
        <span className="topo-summary" data-testid="topo-summary">
          {summary}
          {lastRequest?.dbUsed && mode !== "demo" ? ` · ${dbLabel(lastRequest.dbUsed)}` : ""}
        </span>
        <span className="topo-legend">
          <span><i className="lg-flow" /> tráfico</span>
          <span><i className="lg-standby" /> réplica / failover</span>
          <span><i className="lg-down" /> caído</span>
        </span>
      </figcaption>
    </figure>
  );
}
