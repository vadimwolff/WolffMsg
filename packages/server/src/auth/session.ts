import crypto from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { bytes, prisma } from '../db.js';
import { env } from '../env.js';
import { unauthorized } from '../errors.js';
import { describeUserAgent, ipHint } from '../security/ipHint.js';

/**
 * Session model
 * ─────────────
 * The cookie carries `<sessionId>.<secret>`, where `secret` is 32 bytes of
 * CSPRNG output. The database stores only HMAC-SHA256(secret, pepper), so a
 * dump of the sessions table cannot be replayed as a login.
 *
 * Lookup is by `sessionId` (an indexed primary key) followed by a
 * constant-time comparison of the hash — the secret itself is never used as a
 * query parameter, which keeps the comparison out of the database's reach.
 *
 * We use opaque server-side sessions rather than JWTs precisely because
 * revocation has to be instantaneous: "log out this device" must take effect
 * on the next request, not when a token happens to expire.
 */

export const SESSION_COOKIE = '__Host-wolff_session';
export const CSRF_COOKIE = 'wolff_csrf';
export const CSRF_HEADER = 'x-wolff-csrf';

const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
const ROTATE_AFTER_MS = 24 * 60 * 60 * 1000; // slide the secret daily
const TOUCH_INTERVAL_MS = 60 * 1000; // avoid a write per request

/**
 * `__Host-` prefixed cookies are only accepted by browsers when they are
 * Secure, path=/ and have no Domain attribute — a meaningful hardening. It
 * requires HTTPS, so plain-HTTP development falls back to an unprefixed name.
 */
export function sessionCookieName(): string {
  return env.COOKIE_SECURE ? SESSION_COOKIE : 'wolff_session';
}

let pepper: Buffer | null = null;

function sessionPepper(): Buffer {
  if (!pepper) {
    pepper = Buffer.from(
      crypto.hkdfSync(
        'sha256',
        Buffer.from(env.SESSION_SECRET, 'utf8'),
        Buffer.alloc(0),
        Buffer.from('wolffmsg:session-token:v1'),
        32,
      ),
    );
  }
  return pepper;
}

function hashSecret(secret: string): Buffer {
  return crypto.createHmac('sha256', sessionPepper()).update(secret).digest();
}

export interface AuthContext {
  userId: string;
  sessionId: string;
  deviceId: string | null;
}

export interface IssuedSession {
  sessionId: string;
  cookieValue: string;
  csrfToken: string;
  expiresAt: Date;
}

export async function createSession(params: {
  userId: string;
  deviceId: string | null;
  passwordVersion: number;
  request: FastifyRequest;
}): Promise<IssuedSession> {
  const secret = crypto.randomBytes(32).toString('base64url');
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS);
  const agent = describeUserAgent(params.request.headers['user-agent']);

  const session = await prisma.session.create({
    data: {
      userId: params.userId,
      deviceId: params.deviceId,
      tokenHash: bytes(hashSecret(secret)),
      passwordVersion: params.passwordVersion,
      expiresAt,
      ipHint: ipHint(params.request),
      userAgent: `${agent.name} · ${agent.platform}`,
    },
    select: { id: true },
  });

  return {
    sessionId: session.id,
    cookieValue: `${session.id}.${secret}`,
    csrfToken: crypto.randomBytes(32).toString('base64url'),
    expiresAt,
  };
}

/**
 * Resolve a cookie value to a live session.
 *
 * Returns `null` for every failure mode — expired, revoked, unknown, wrong
 * secret, or invalidated by a password change — so callers cannot accidentally
 * branch on *why* authentication failed.
 */
export async function resolveSession(
  cookieValue: string | undefined,
): Promise<(AuthContext & { rotate: boolean; touch: boolean }) | null> {
  if (!cookieValue) return null;

  const separator = cookieValue.indexOf('.');
  if (separator <= 0) return null;
  const sessionId = cookieValue.slice(0, separator);
  const secret = cookieValue.slice(separator + 1);
  if (!sessionId || !secret) return null;

  const session = await prisma.session.findUnique({
    where: { id: sessionId },
    select: {
      id: true,
      userId: true,
      deviceId: true,
      tokenHash: true,
      expiresAt: true,
      revokedAt: true,
      rotatedAt: true,
      lastActiveAt: true,
      passwordVersion: true,
      user: { select: { passwordVersion: true, disabledAt: true } },
    },
  });
  if (!session) return null;

  const expected = Buffer.from(session.tokenHash);
  const actual = hashSecret(secret);
  if (expected.length !== actual.length) return null;
  if (!crypto.timingSafeEqual(expected, actual)) return null;

  if (session.revokedAt) return null;
  if (session.expiresAt.getTime() <= Date.now()) return null;
  if (session.user.disabledAt) return null;
  // A password change bumps the user's version, retiring every older session.
  if (session.passwordVersion !== session.user.passwordVersion) return null;

  const now = Date.now();
  return {
    userId: session.userId,
    sessionId: session.id,
    deviceId: session.deviceId,
    rotate: now - session.rotatedAt.getTime() > ROTATE_AFTER_MS,
    touch: now - session.lastActiveAt.getTime() > TOUCH_INTERVAL_MS,
  };
}

/** Slide the session secret forward, invalidating the previous cookie value. */
export async function rotateSession(
  sessionId: string,
): Promise<{ cookieValue: string; expiresAt: Date }> {
  const secret = crypto.randomBytes(32).toString('base64url');
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS);
  await prisma.session.update({
    where: { id: sessionId },
    data: {
      tokenHash: bytes(hashSecret(secret)),
      rotatedAt: new Date(),
      lastActiveAt: new Date(),
      expiresAt,
    },
  });
  return { cookieValue: `${sessionId}.${secret}`, expiresAt };
}

export async function touchSession(
  sessionId: string,
  request: FastifyRequest,
): Promise<void> {
  await prisma.session
    .update({
      where: { id: sessionId },
      data: { lastActiveAt: new Date(), ipHint: ipHint(request) },
    })
    .catch(() => undefined);
}

export async function revokeSession(
  sessionId: string,
  reason: string,
): Promise<void> {
  await prisma.session
    .updateMany({
      where: { id: sessionId, revokedAt: null },
      data: { revokedAt: new Date(), revokedReason: reason },
    })
    .catch(() => undefined);
}

export async function revokeAllSessions(
  userId: string,
  reason: string,
  exceptSessionId?: string,
): Promise<string[]> {
  const targets = await prisma.session.findMany({
    where: {
      userId,
      revokedAt: null,
      ...(exceptSessionId ? { id: { not: exceptSessionId } } : {}),
    },
    select: { id: true },
  });
  if (targets.length === 0) return [];
  await prisma.session.updateMany({
    where: { id: { in: targets.map((t) => t.id) } },
    data: { revokedAt: new Date(), revokedReason: reason },
  });
  return targets.map((t) => t.id);
}

/* ─────────────────────────────── cookies ────────────────────────────────── */

function baseCookieOptions() {
  return {
    path: '/',
    httpOnly: true,
    // `strict` would break the OAuth-less flow not at all, and it is the
    // strongest CSRF mitigation available at the cookie layer.
    sameSite: 'strict' as const,
    secure: env.COOKIE_SECURE,
  };
}

export function setSessionCookie(
  reply: FastifyReply,
  cookieValue: string,
  expiresAt: Date,
): void {
  reply.setCookie(sessionCookieName(), cookieValue, {
    ...baseCookieOptions(),
    expires: expiresAt,
  });
}

export function setCsrfCookie(reply: FastifyReply, token: string): void {
  // Readable by JavaScript on purpose: the client echoes it back in a header,
  // which is the double-submit half of the CSRF defence.
  reply.setCookie(csrfCookieName(), token, {
    path: '/',
    httpOnly: false,
    sameSite: 'strict',
    secure: env.COOKIE_SECURE,
    maxAge: 60 * 60 * 24 * 30,
  });
}

export function csrfCookieName(): string {
  return env.COOKIE_SECURE ? `__Host-${CSRF_COOKIE}` : CSRF_COOKIE;
}

export function clearAuthCookies(reply: FastifyReply): void {
  reply.clearCookie(sessionCookieName(), { path: '/' });
  reply.clearCookie(csrfCookieName(), { path: '/' });
}

export function requireAuth(request: FastifyRequest): AuthContext {
  if (!request.auth) throw unauthorized();
  return request.auth;
}
