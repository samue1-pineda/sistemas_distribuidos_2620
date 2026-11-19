import { useCallback, useEffect, useState } from "react";

// Secciones de la aplicación: cada una se dedica a UNA tarea. La URL usa el hash (#/pedidos, #/cluster…)
// para no necesitar cambios en NGINX y permitir enlazar directamente a una sección.
export const ROUTES = {
  resumen: { label: "Resumen", icon: "home", roles: ["admin"], group: "operacion",
    description: "Estado general del sistema distribuido y accesos rápidos." },
  pedidos: { label: "Pedidos", clientLabel: "Mis pedidos", icon: "list", roles: ["admin", "user"], group: "operacion",
    description: "Consulta, filtra y avanza el estado de los pedidos.",
    clientDescription: "Consulta tus pedidos y su estado de entrega." },
  nuevo: { label: "Nuevo pedido", icon: "plus", roles: ["admin", "user"], group: "operacion",
    description: "Registra un pedido y mira qué nodo y qué base de datos lo guardaron." },
  conexion: { label: "Mi conexión", icon: "network", roles: ["user"], group: "operacion",
    description: "Cómo viajaron tus peticiones por el clúster." },
  cluster: { label: "Clúster y caos", icon: "network", roles: ["admin"], group: "sistema",
    description: "Provoca caídas de nodos o de la base primaria y observa cómo responde el sistema." },
  monitoreo: { label: "Monitoreo", icon: "activity", roles: ["admin"], group: "sistema",
    description: "Métricas y eventos en vivo de cada nodo, del gateway y de las bases." },
  usuarios: { label: "Usuarios", icon: "users", roles: ["admin"], group: "admin",
    description: "Roles, cuentas desactivadas, contraseñas y eliminación de cuentas." },
  correcciones: { label: "Correcciones", icon: "wrench", roles: ["admin"], group: "admin",
    description: "Corrige cualquier pedido o restaura los eliminados." },
  auditoria: { label: "Auditoría", icon: "shield", roles: ["admin"], group: "admin",
    description: "Quién cambió qué, cuándo y en qué nodo." },
};

export const GROUPS = [
  { key: "operacion", label: "Operación" },
  { key: "sistema", label: "Sistema distribuido" },
  { key: "admin", label: "Administración" },
];

export const DEFAULT_ROUTE = { admin: "resumen", user: "pedidos" };

export function routesFor(role) {
  return Object.entries(ROUTES).filter(([, route]) => route.roles.includes(role));
}

function parse(role) {
  const name = window.location.hash.replace(/^#\/?/, "");
  return ROUTES[name]?.roles.includes(role) ? name : DEFAULT_ROUTE[role];
}

/** Ruta actual según el hash; las rutas no permitidas para el rol vuelven a la de inicio. */
export function useHashRoute(role) {
  const [route, setRoute] = useState(() => parse(role));
  useEffect(() => {
    const onChange = () => {
      const name = parse(role);
      // La URL siempre refleja la sección visible (p. ej. al entrar sin hash o con una ruta no permitida).
      if (window.location.hash !== `#/${name}`) window.history.replaceState(null, "", `#/${name}`);
      setRoute(name);
    };
    window.addEventListener("hashchange", onChange);
    onChange();
    return () => window.removeEventListener("hashchange", onChange);
  }, [role]);
  const navigate = useCallback((name) => {
    if (window.location.hash !== `#/${name}`) window.location.hash = `/${name}`;
    else setRoute(name);
    window.scrollTo?.(0, 0);
  }, []);
  return [route, navigate];
}
