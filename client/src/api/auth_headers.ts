/**
 * Shared REST auth helper.
 *
 * The gateway (python/vtt_orchestrator/server.py) signs HMAC session tokens at
 * login/signup and accepts them via the `Authorization: Bearer <token>` header
 * (preferred — tokens in URLs leak into proxy/access logs) with the legacy
 * `?token=` query param kept as a back-compat fallback. WebSocket clients keep
 * the query param because browsers cannot set headers on the WS handshake.
 */

const TOKEN_KEY = 'aethertable_token';

/** The raw gateway session token, or null when signed out / storage blocked. */
export function getStoredToken(): string | null {
  try {
    return sessionStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

/**
 * Headers carrying the caller's identity, or `{}` when unauthenticated so
 * callers can spread it into any `headers` object without conditionals:
 *   fetch(path, { headers: { 'Content-Type': 'application/json', ...authHeaders() } })
 */
export function authHeaders(): Record<string, string> {
  const token = getStoredToken();
  return token ? { Authorization: `Bearer ${token}` } : {};
}
