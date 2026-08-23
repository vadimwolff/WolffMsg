/**
 * Where the API lives.
 *
 * There are two deployment shapes, and this module is the only place that knows
 * which one is in play:
 *
 *  1. **Same origin** — the server serves the built client itself, or a reverse
 *     proxy puts both behind one hostname. Nothing is configured, every request
 *     is a relative path, and `SameSite=strict` cookies do their full job. This
 *     is the recommended shape and the default.
 *
 *  2. **Split origin** — the client is served from a static host (GitHub Pages,
 *     a CDN) and talks to a WolffMsg server somewhere else. The origin comes
 *     either from `VITE_API_ORIGIN` at build time or from the person using the
 *     app, who points this client at their own server.
 *
 * Shape 2 has a real, documented cost: a cross-site cookie cannot be
 * `SameSite=strict`, so that server must run with `COOKIE_SAMESITE=none` and
 * CSRF then rests on the Origin allow-list and the double-submit token rather
 * than on the browser. SECURITY.md says so plainly. Nothing about the
 * end-to-end encryption changes — the server never held plaintext in either
 * shape — but the transport story is weaker, so shape 1 stays the default.
 */

const STORAGE_KEY = 'wolffmsg.server-origin';

/** Set at build time. Empty (the default) means "same origin". */
const BUILD_TIME_ORIGIN = normaliseOrigin(
  (import.meta.env.VITE_API_ORIGIN as string | undefined) ?? '',
);

let override: string | null = null;
let loaded = false;

/**
 * Accept only a bare origin, and only a secure one.
 *
 * A path, query or fragment would be silently dropped when we join it to an API
 * path, so rejecting them is clearer than half-honouring them. Plain HTTP is
 * refused because the whole client depends on Web Crypto, which the browser
 * only exposes in a secure context — localhost excepted, for development.
 *
 * @returns the normalised origin, or `''` if the input is unusable.
 */
export function normaliseOrigin(value: string): string {
  const trimmed = value.trim().replace(/\/+$/, '');
  if (!trimmed) return '';

  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return '';
  }

  if (url.pathname !== '/' || url.search || url.hash) return '';

  const isLocal =
    url.hostname === 'localhost' ||
    url.hostname === '127.0.0.1' ||
    url.hostname === '[::1]';
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && isLocal)) {
    return '';
  }

  return url.origin;
}

/** Why a candidate origin was refused, for the connect form to show. */
export function describeOriginProblem(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) return 'Enter your server address';
  if (normaliseOrigin(trimmed)) return null;
  if (!/^https?:\/\//i.test(trimmed)) {
    return 'Include the scheme, for example https://chat.example.com';
  }
  if (/^http:\/\//i.test(trimmed)) {
    return 'HTTPS is required — the browser only exposes Web Crypto on a secure origin';
  }
  return 'Use the bare address only, with no path after the hostname';
}

function loadOverride(): void {
  if (loaded) return;
  loaded = true;
  try {
    override = normaliseOrigin(localStorage.getItem(STORAGE_KEY) ?? '') || null;
  } catch {
    // Storage can be blocked outright; the build-time default still applies.
    override = null;
  }
}

/**
 * The API origin, or `''` for same-origin.
 *
 * A person's own choice wins over the build-time default so a published client
 * can be pointed at a different server without rebuilding it.
 */
export function serverOrigin(): string {
  loadOverride();
  return override ?? BUILD_TIME_ORIGIN;
}

/** True when requests leave this page's origin, which changes cookie handling. */
export function isSplitOrigin(): boolean {
  const origin = serverOrigin();
  return origin !== '' && origin !== location.origin;
}

/** Join an API path onto the configured origin. */
export function apiUrl(path: string): string {
  const origin = serverOrigin();
  return origin ? `${origin}${path}` : path;
}

/** The realtime endpoint, derived from the same origin. */
export function socketUrl(): string {
  const origin = serverOrigin();
  const base = origin || location.origin;
  return `${base.replace(/^http/, 'ws')}/ws`;
}

/**
 * Point this client at a server.
 *
 * @throws Error when the address is not a usable origin.
 */
export function setServerOrigin(value: string): string {
  const normalised = normaliseOrigin(value);
  if (!normalised) {
    throw new Error(describeOriginProblem(value) ?? 'That address is not usable');
  }
  loadOverride();
  override = normalised;
  try {
    localStorage.setItem(STORAGE_KEY, normalised);
  } catch {
    // Not fatal: the choice holds for this page load.
  }
  return normalised;
}

/** Forget a chosen server, falling back to the build-time default. */
export function clearServerOrigin(): void {
  loadOverride();
  override = null;
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    // Nothing to undo.
  }
}

/** True when this build has no server to talk to until someone names one. */
export function needsServerChoice(): boolean {
  return serverOrigin() === '' && !import.meta.env.DEV && isStaticHost();
}

/**
 * A best-effort guess that this page is served by a static host rather than by
 * the WolffMsg server. Only used to choose which screen to show first; a wrong
 * guess costs one failed request, not correctness.
 */
function isStaticHost(): boolean {
  return (
    location.hostname.endsWith('.github.io') ||
    location.hostname.endsWith('.pages.dev') ||
    location.hostname.endsWith('.netlify.app') ||
    location.hostname.endsWith('.vercel.app')
  );
}
