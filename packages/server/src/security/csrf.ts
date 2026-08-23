import crypto from 'node:crypto';
import type { FastifyRequest } from 'fastify';
import { env } from '../env.js';
import { forbidden } from '../errors.js';
import { CSRF_HEADER, csrfCookieName, sessionCookieName } from '../auth/session.js';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * Cross-site request forgery defence.
 *
 * CSRF is the problem of a *third-party page* causing the browser to make an
 * authenticated request using a cookie it cannot read. The defence therefore
 * has two independent parts:
 *
 *  1. **Origin check — applies to every unsafe request.** If the browser tells
 *     us where the request came from and it is not an origin we serve, it is
 *     refused outright. Combined with `SameSite=strict` on the session cookie
 *     this also covers *login* CSRF, where an attacker tries to sign a victim
 *     into the attacker's account.
 *
 *  2. **Double-submit token — applies to requests carrying a session.** A value
 *     stored in a JS-readable cookie on our origin must be echoed in a custom
 *     header. A cross-origin page can neither read the cookie nor set the
 *     header without triggering a CORS preflight it will fail.
 *
 * Part 2 is deliberately scoped to authenticated requests. Sign-up and sign-in
 * are the very requests that *issue* the token, so demanding it there would
 * make a first visit impossible — and it would add nothing, because those
 * requests carry their authority in the body rather than in an ambient cookie.
 */
export function assertCsrf(request: FastifyRequest): void {
  if (SAFE_METHODS.has(request.method)) return;

  // ── 1. Origin ────────────────────────────────────────────────────────────
  const origin = request.headers.origin;
  if (origin && !env.webOrigins.includes(origin)) {
    throw forbidden('This request came from an unrecognised origin');
  }

  // ── 2. Double-submit, for anything relying on the session cookie ─────────
  const hasSession = Boolean(request.cookies?.[sessionCookieName()]);
  if (!hasSession) return;

  /*
   * With `SameSite=none` the browser is no longer refusing cross-site requests
   * for us, so a *missing* Origin header can no longer be read as "same-site".
   * Every browser sends one on a cross-origin fetch, so requiring it costs
   * nothing and closes the gap the relaxed cookie opens.
   */
  if (env.COOKIE_SAMESITE === 'none' && !origin) {
    throw forbidden('This request did not declare an origin');
  }

  const cookieToken = request.cookies?.[csrfCookieName()];
  const headerToken = request.headers[CSRF_HEADER];
  const provided = Array.isArray(headerToken) ? headerToken[0] : headerToken;

  if (!cookieToken || !provided) {
    throw forbidden('Missing request verification token');
  }

  const a = Buffer.from(cookieToken, 'utf8');
  const b = Buffer.from(provided, 'utf8');
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    throw forbidden('Request verification token does not match');
  }
}

/**
 * The same origin check applied to a WebSocket upgrade. Browsers do not apply
 * the same-origin policy to WebSockets, so this is the only thing standing
 * between a hostile page and a cookie-authenticated socket.
 */
export function isAllowedWebSocketOrigin(origin: string | undefined): boolean {
  if (!origin) return !env.isProduction;
  return env.webOrigins.includes(origin);
}
