import ClusterPanel from "../components/ClusterPanel.jsx";
import ClusterTopology from "../components/ClusterTopology.jsx";
import MonitoringPanel from "../components/MonitoringPanel.jsx";
import RequestLog from "../components/RequestLog.jsx";
import { PageHeader } from "../components/Sidebar.jsx";
import { ROUTES } from "../navigation.js";

// ---------------------------------------------------------------------- Clúster y caos (admin)
export function ClusterPage({ chaos, log, onClearLog }) {
  return (
    <>
      <PageHeader title="Clúster y caos" description={ROUTES.cluster.description} />
      <section className="card topology-card">
        <header className="card-head">
          <h3>Topología en vivo</h3>
          <span className="muted small">Las caídas que provoques abajo se reflejan aquí al instante</span>
        </header>
        <ClusterTopology mode="admin" cluster={chaos.cluster} replication={chaos.replication} lastRequest={chaos.lastRequest} handled={chaos.handled} />
      </section>
      <ClusterPanel {...chaos} />
      <RequestLog entries={log} onClear={onClearLog} />
    </>
  );
}

// ---------------------------------------------------------------------- Monitoreo (admin)
export function MonitoreoPage() {
  return (
    <>
      <PageHeader title="Monitoreo" description={ROUTES.monitoreo.description} />
      <MonitoringPanel />
    </>
  );
}
