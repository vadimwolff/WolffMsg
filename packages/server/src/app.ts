import Fastify, {
  type FastifyBaseLogger,
  type FastifyInstance,
} from 'fastify';
import cookie from '@fastify/cookie';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import multipart from '@fastify/multipart';
import { initCrypto } from '@wolffmsg/shared';
import { env } from './env.js';
import { logger } from './logger.js';
import { registerErrorHandler } from './errors.js';
import {
  resolveSession,
  rotateSession,
  sessionCookieName,
  setSessionCookie,
  touchSession,
} from './auth/session.js';
import { assertCsrf } from './security/csrf.js';
import { authRoutes } from './routes/auth.js';
import { userRoutes } from './routes/users.js';
import { chatRoutes } from './routes/chats.js';
import { messageRoutes } from './routes/messages.js';
import { socialRoutes } from './routes/social.js';
import { keyRoutes } from './routes/keys.js';
import { mediaRoutes } from './routes/media.js';
import { miscRoutes } from './routes/misc.js';
import { registerWebClient } from './web.js';

/**
 * Endpoints reachable without a session. Everything else requires one; the
 * list is an explicit allow-list rather than a per-route opt-in, so a new
 * route is private by default.
 */
const PUBLIC_ROUTES = new Set([
  'POST:/api/auth/register',
  'POST:/api/auth/login',
  'POST:/api/auth/logout',
  'GET:/api/auth/challenge',
  'GET:/api/auth/registration-open',
  'GET:/api/auth/username-available',
  'GET:/api/health',
  'GET:/api/ready',
  'GET:/api/config',
]);

export async function buildApp(): Promise<FastifyInstance> {
  await initCrypto();

  const app = Fastify({
    // Fastify 5 takes a pre-built pino instance via `loggerInstance`;
    // `logger` is reserved for inline configuration objects. The cast pins
    // the instance to Fastify's own logger interface — without it, pino's
    // concrete generic leaks into `FastifyInstance` and stops matching the
    // plugin signatures.
    loggerInstance: logger as unknown as FastifyBaseLogger,
    // Only honour X-Forwarded-For behind a known proxy. In development a
    // client could otherwise forge it and sidestep per-IP rate limiting.
    trustProxy: env.isProduction,
    bodyLimit: 1_000_000,
    // Request logging is governed by the logger's own level, which is
    // `silent` under test — no separate switch needed.
    genReqId: () => Math.random().toString(36).slice(2, 12),
  });

  await app.register(helmet, {
    /*
     * Set per response instead, in the hook below. This process may now serve
     * the web client as well as the API, and those need opposite policies: the
     * API's `default-src 'none'` would block the client's own scripts, and the
     * client's policy would be far too generous for a JSON endpoint.
     */
    contentSecurityPolicy: false,
    frameguard: { action: 'deny' },
    crossOriginEmbedderPolicy: false,
    crossOriginResourcePolicy: { policy: 'same-site' },
    referrerPolicy: { policy: 'no-referrer' },
    hsts: env.isProduction
      ? { maxAge: 31_536_000, includeSubDomains: true, preload: false }
      : false,
  });

  /**
   * The API's own Content Security Policy.
   *
   * It serves JSON and opaque blobs and never renders HTML, so nothing needs
   * to be permitted at all. The client's policy travels inside its HTML (see
   * packages/web/csp.ts), which is what lets a static host have one too.
   */
  app.addHook('onSend', async (request, reply) => {
    if (!request.url.startsWith('/api')) return;
    // Blob routes set a stricter, sandboxed policy of their own.
    if (reply.getHeader('content-security-policy')) return;
    reply.header(
      'Content-Security-Policy',
      "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
    );
  });

  await app.register(cors, {
    origin: (origin, callback) => {
      // Same-origin and non-browser requests arrive without an Origin header.
      if (!origin) return callback(null, true);
      // Withhold the CORS headers rather than raising: an error here would
      // surface as a 500. The request still gets a clean 403 from the CSRF
      // origin check, and the browser blocks the response either way.
      callback(null, env.webOrigins.includes(origin));
    },
    credentials: true,
    methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['content-type', 'x-wolff-csrf'],
    maxAge: 600,
  });

  await app.register(cookie, {
    parseOptions: { httpOnly: true, sameSite: env.COOKIE_SAMESITE, path: '/' },
  });

  await app.register(multipart, {
    limits: {
      fileSize: env.MAX_ATTACHMENT_BYTES,
      files: 1,
      fields: 8,
      fieldSize: 4_096,
      headerPairs: 64,
    },
  });

  registerErrorHandler(app);

  /**
   * Authentication and CSRF, in one hook so no route can accidentally skip it.
   *
   * Order matters: the session is resolved first so `request.auth` is
   * available to the error path, then CSRF is enforced, then the allow-list
   * decides whether a session was actually required.
   */
  app.addHook('onRequest', async (request, reply) => {
    const cookieValue = request.cookies?.[sessionCookieName()];
    const resolved = await resolveSession(cookieValue);

    if (resolved) {
      request.auth = {
        userId: resolved.userId,
        sessionId: resolved.sessionId,
        deviceId: resolved.deviceId,
      };

      if (resolved.rotate) {
        const rotated = await rotateSession(resolved.sessionId);
        setSessionCookie(reply, rotated.cookieValue, rotated.expiresAt);
      } else if (resolved.touch) {
        // Fire and forget: a `lastActiveAt` write must not add latency.
        void touchSession(resolved.sessionId, request);
      }
    }

    if (request.method === 'OPTIONS') return;

    assertCsrf(request);

    const routeUrl = request.routeOptions?.url ?? request.url.split('?')[0] ?? '';

    /*
     * Only the API is session-gated. When this process also serves the web
     * client, those files are public by nature — they are the same bytes for
     * everyone, and the client cannot present a session before it has loaded.
     * Gating them would mean a blank 401 instead of a sign-in screen.
     */
    if (!routeUrl.startsWith('/api')) return;

    const key = `${request.method}:${routeUrl}`;
    if (PUBLIC_ROUTES.has(key)) return;

    if (!request.auth) {
      reply.status(401).send({
        error: { code: 'unauthorized', message: 'You need to sign in to do that' },
      });
    }
  });

  await app.register(authRoutes);
  await app.register(userRoutes);
  await app.register(chatRoutes);
  await app.register(messageRoutes);
  await app.register(socialRoutes);
  await app.register(keyRoutes);
  await app.register(mediaRoutes);
  await app.register(miscRoutes);

  // Last, so nothing it registers can shadow an API route.
  await registerWebClient(app);

  return app;
}
