import { GROUPS, routesFor } from "../navigation.js";
import Icon from "./Icons.jsx";

// Menú de navegación: un botón por sección, agrupados por propósito.
export default function Sidebar({ role, route, onNavigate, badges = {} }) {
  const routes = routesFor(role);
  return (
    <nav className="sidebar" aria-label="Secciones">
      {GROUPS.map((group) => {
        const items = routes.filter(([, r]) => r.group === group.key);
        if (!items.length) return null;
        return (
          <div key={group.key} className="nav-group">
            {role === "admin" && <span className="nav-group-label">{group.label}</span>}
            {items.map(([name, r]) => (
              <button
                key={name}
                type="button"
                className={`nav-item ${route === name ? "active" : ""}`}
                aria-current={route === name ? "page" : undefined}
                data-route={name}
                onClick={() => onNavigate(name)}
              >
                <Icon name={r.icon} />
                <span>{role === "user" && r.clientLabel ? r.clientLabel : r.label}</span>
                {badges[name] != null && <span className="nav-badge">{badges[name]}</span>}
              </button>
            ))}
          </div>
        );
      })}
    </nav>
  );
}

export function PageHeader({ title, description, children }) {
  return (
    <header className="page-header">
      <div>
        <h1>{title}</h1>
        {description && <p>{description}</p>}
      </div>
      {children && <div className="page-actions">{children}</div>}
    </header>
  );
}
