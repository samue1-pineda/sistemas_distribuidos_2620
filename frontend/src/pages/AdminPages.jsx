import { useCallback, useState } from "react";
import { AuditView, OrdersView, UsersView } from "../components/AdminPanel.jsx";
import { PageHeader } from "../components/Sidebar.jsx";
import { ROUTES } from "../navigation.js";

function useReload() {
  const [key, setKey] = useState(0);
  return [key, useCallback(() => setKey((k) => k + 1), [])];
}

export function UsuariosPage({ currentUser, notify }) {
  const [reloadKey, reload] = useReload();
  return (
    <>
      <PageHeader title="Usuarios" description={ROUTES.usuarios.description} />
      <section className="card admin">
        <UsersView currentUserId={currentUser.id} notify={notify} onChanged={reload} reloadKey={reloadKey} />
      </section>
    </>
  );
}

export function CorreccionesPage({ notify }) {
  const [reloadKey, reload] = useReload();
  return (
    <>
      <PageHeader title="Correcciones" description={ROUTES.correcciones.description} />
      <section className="card admin">
        <OrdersView notify={notify} onChanged={reload} reloadKey={reloadKey} />
      </section>
    </>
  );
}

export function AuditoriaPage() {
  return (
    <>
      <PageHeader title="Auditoría" description={ROUTES.auditoria.description} />
      <section className="card admin">
        <AuditView reloadKey={0} />
      </section>
    </>
  );
}
