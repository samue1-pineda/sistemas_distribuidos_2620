// Sesión del usuario en el navegador (token JWT + datos públicos del usuario).
// Se guarda en localStorage para sobrevivir a recargas; el backend vuelve a validar el usuario en
// cada petición, así que una cuenta desactivada pierde el acceso aunque el token siga guardado.
const KEY = "pedidos.session";
// true cuando la sesión se cerró en ESTA pestaña (la app ya volvió al login); false si caducó o la cerró otra pestaña.
let closedHere = false;

export function sessionClosedHere() {
  return closedHere;
}

export function loadSession() {
  try {
    const session = JSON.parse(localStorage.getItem(KEY) || "null");
    if (!session?.token || !session?.user) return null;
    if (session.expiresAt && Date.now() > session.expiresAt) {
      localStorage.removeItem(KEY);
      return null;
    }
    return session;
  } catch {
    return null;
  }
}

export function saveSession({ access_token: token, expires_in: expiresIn, user }) {
  const session = { token, user, expiresAt: Date.now() + expiresIn * 1000 };
  closedHere = false;
  try {
    localStorage.setItem(KEY, JSON.stringify(session));
  } catch {
    /* almacenamiento no disponible: la sesión dura lo que la pestaña */
  }
  return session;
}

export function clearSession() {
  closedHere = true;
  try {
    localStorage.removeItem(KEY);
  } catch {
    /* nada que limpiar */
  }
}

export function getToken() {
  return loadSession()?.token ?? null;
}
