// Iconos SVG en línea (trazo de 2 px, heredan el color del texto). Sin librerías externas.
const PATHS = {
  home: "M3 11.5 12 4l9 7.5M5.5 9.5V20h13V9.5",
  list: "M8 6h12M8 12h12M8 18h12M4 6h.01M4 12h.01M4 18h.01",
  plus: "M12 5v14M5 12h14",
  network: "M12 5.5a2 2 0 1 0 0-.01M5 18.5a2 2 0 1 0 0-.01M19 18.5a2 2 0 1 0 0-.01M12 7.5v4M12 11.5l-6 5M12 11.5l6 5",
  activity: "M3 12h4l3-7 4 14 3-7h4",
  users: "M16 19v-1.5a3.5 3.5 0 0 0-3.5-3.5h-5A3.5 3.5 0 0 0 4 17.5V19M10 10.5a3 3 0 1 0 0-6 3 3 0 0 0 0 6M20 19v-1.5a3.5 3.5 0 0 0-2.5-3.3M15.5 4.6a3 3 0 0 1 0 5.8",
  wrench: "M14.5 6.5a4 4 0 0 0 5 5L12 19a2.1 2.1 0 0 1-3-3l7.5-7.5a4 4 0 0 0-2-2ZM6 18h.01",
  shield: "M12 3 5 6v5c0 4.4 3 8.4 7 10 4-1.6 7-5.6 7-10V6l-7-3ZM9 12l2 2 4-4",
  logout: "M15 17l5-5-5-5M20 12H9M12 20H5a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1h7",
  arrow: "M5 12h14M13 6l6 6-6 6",
};

export default function Icon({ name, size = 18 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
         strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className="icon">
      <path d={PATHS[name] ?? PATHS.arrow} />
    </svg>
  );
}
