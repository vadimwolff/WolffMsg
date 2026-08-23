import crypto from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  LIMITS,
  normalizeDisplayText,
  normalizeUsername,
  validateDisplayName,
  validatePassword,
  validateUsername,
  type SessionSummary,
} from '@wolffmsg/shared';
import sodium from 'libsodium-wrappers-sumo';
import { bytes, prisma, isUniqueViolation } from '../db.js';
import { env } from '../env.js';
import { badRequest, conflict, forbidden, notFound, unauthorized } from '../errors.js';
import { logger } from '../logger.js';
import { counters } from '../redis.js';
import {
  decoyVerify,
  hashPassword,
  needsRehash,
  verifyPassword,
} from '../auth/password.js';
import {
  clearAuthCookies,
  createSession,
  csrfCookieName,
  revokeAllSessions,
  revokeSession,
  setCsrfCookie,
  setSessionCookie,
  requireAuth,
} from '../auth/session.js';
import { RATE_LIMITS, clearLimit, consume, consumeByIp } from '../security/rateLimit.js';
import { describeUserAgent, ipHint, rateLimitKey } from '../security/ipHint.js';
import { registerDevice } from '../services/devices.js';
import { loadSelf } from '../services/users.js';
import { recordSecurityEvent } from '../services/securityEvents.js';
import { disconnectSessions } from '../realtime/hub.js';

const preKeySchema = z.object({
  id: z.string().min(1).max(64),
  publicKey: z.string().min(1).max(128),
  signature: z.string().min(1).max(256),
});

const deviceSchema = z.object({
  name: z.string().min(1).max(64),
  platform: z.string().min(1).max(32),
  identityPublicKey: z.string().min(1).max(128),
  signedPreKey: preKeySchema,
  oneTimePreKeys: z.array(preKeySchema).max(200),
});

const registerSchema = z.object({
  username: z.string().min(1).max(64),
  password: z.string().min(1).max(LIMITS.passwordMax),
  displayName: z.string().min(1).max(200),
  device: deviceSchema,
});

const existingDeviceSchema = z.object({
  deviceId: z.string().min(1).max(64),
  nonce: z.string().min(1).max(128),
  signature: z.string().min(1).max(256),
});

const loginSchema = z.object({
  username: z.string().min(1).max(64),
  password: z.string().min(1).max(LIMITS.passwordMax),
  device: deviceSchema.optional(),
  existingDevice: existingDeviceSchema.optional(),
});

const passwordChangeSchema = z.object({
  currentPassword: z.string().min(1).max(LIMITS.passwordMax),
  newPassword: z.string().min(1).max(LIMITS.passwordMax),
  /** When true, every other session is signed out. Defaults to true. */
  revokeOtherSessions: z.boolean().optional(),
});

/** Hash a username for the durable login-attempt log, never storing it raw. */
function subjectHash(username: string): Buffer {
  return crypto
    .createHmac('sha256', env.SESSION_SECRET)
    .update(`login:${username}`)
    .digest();
}

/**
 * Durable brute-force check.
 *
 * Redis carries the fast path, but its counters vanish on a flush. This second
 * check reads the database, so an attacker cannot reset a lockout by taking
 * the cache down.
 */
async function assertNotLockedOut(username: string): Promise<void> {
  const since = new Date(Date.now() - 15 * 60 * 1000);
  const failures = await prisma.loginAttempt.count({
    where: { subjectHash: bytes(subjectHash(username)), success: false, createdAt: { gte: since } },
  });
  if (failures >= 15) {
    // Same message and status as the Redis-backed limiter, so the two are
    // indistinguishable from outside.
    throw conflict(
      'Too many sign-in attempts for this account. Try again in a few minutes.',
      'rate_limited',
    );
  }
}

async function recordLoginAttempt(
  username: string,
  request: FastifyRequest,
  success: boolean,
): Promise<void> {
  await prisma.loginAttempt
    .create({
      data: { subjectHash: bytes(subjectHash(username)), ipHint: ipHint(request), success },
    })
    .catch(() => undefined);
}

export async function authRoutes(app: FastifyInstance): Promise<void> {
  /**
   * A single-use nonce a client signs with its device identity key to prove
   * it still holds the private half before re-binding an existing device.
   */
  app.get('/api/auth/challenge', async (request) => {
    await consumeByIp(RATE_LIMITS.login, request);
    const nonce = crypto.randomBytes(24).toString('base64');
    await counters.setEx(`devchal:${nonce}`, '1', 120);
    return { nonce, expiresInSeconds: 120 };
  });

  app.post('/api/auth/register', async (request, reply) => {
    if (!env.ALLOW_REGISTRATION) {
      throw forbidden('Registration is closed on this server');
    }
    await consumeByIp(RATE_LIMITS.register, request);

    const body = registerSchema.parse(request.body);
    const username = normalizeUsername(body.username);
    const displayName = normalizeDisplayText(body.displayName);

    const fields: Record<string, string> = {};
    const usernameProblem = validateUsername(username);
    if (usernameProblem) fields.username = usernameProblem.message;
    const passwordProblem = validatePassword(body.password);
    if (passwordProblem) fields.password = passwordProblem.message;
    const nameProblem = validateDisplayName(displayName);
    if (nameProblem) fields.displayName = nameProblem.message;
    if (Object.keys(fields).length > 0) {
      throw badRequest('Some of those details are not valid', fields);
    }

    const passwordHash = await hashPassword(body.password);

    let userId: string;
    try {
      const user = await prisma.user.create({
        data: {
          username,
          displayName,
          passwordHash,
          settings: { create: {} },
        },
        select: { id: true },
      });
      userId = user.id;
    } catch (err) {
      if (isUniqueViolation(err, 'username')) {
        throw conflict('That username is already taken', 'username_taken');
      }
      throw err;
    }

    const { deviceId } = await registerDevice({
      userId,
      name: body.device.name,
      platform: body.device.platform,
      identityPublicKey: body.device.identityPublicKey,
      signedPreKey: body.device.signedPreKey,
      oneTimePreKeys: body.device.oneTimePreKeys,
      ipHint: ipHint(request),
    });

    const session = await createSession({
      userId,
      deviceId,
      passwordVersion: 1,
      request,
    });
    setSessionCookie(reply, session.cookieValue, session.expiresAt);
    setCsrfCookie(reply, session.csrfToken);

    await recordSecurityEvent({
      userId,
      kind: 'session.created',
      detail: 'Account created',
      ipHint: ipHint(request),
    });

    const self = await loadSelf(userId);
    reply.status(201);
    return { user: self, deviceId, csrfToken: session.csrfToken };
  });

  app.post('/api/auth/login', async (request, reply) => {
    await consumeByIp(RATE_LIMITS.login, request);

    const body = loginSchema.parse(request.body);
    const username = normalizeUsername(body.username);

    // Per-account limit, keyed by a hash so the counter itself is not a
    // username oracle for anyone who can read Redis.
    const accountKey = subjectHash(username).toString('hex').slice(0, 32);
    await consume(RATE_LIMITS.loginPerAccount, `acct:${accountKey}`);
    await assertNotLockedOut(username);

    const user = await prisma.user.findUnique({
      where: { username },
      select: {
        id: true,
        passwordHash: true,
        passwordVersion: true,
        disabledAt: true,
      },
    });

    /**
     * Account-enumeration protection: an unknown username still runs a full
     * Argon2id verification against a decoy hash, so the request costs the
     * same and the response is byte-identical.
     */
    const valid = user
      ? await verifyPassword(user.passwordHash, body.password)
      : (await decoyVerify(body.password), false);

    if (!user || !valid || user.disabledAt) {
      await recordLoginAttempt(username, request, false);
      if (user) {
        await recordSecurityEvent({
          userId: user.id,
          kind: 'login.failed',
          detail: 'Incorrect password',
          ipHint: ipHint(request),
        });
      }
      throw unauthorized('That username or password is not right');
    }

    await recordLoginAttempt(username, request, true);
    await clearLimit(RATE_LIMITS.loginPerAccount, `acct:${accountKey}`);
    await clearLimit(RATE_LIMITS.login, `ip:${rateLimitKey(request)}`);

    // Opportunistically strengthen an old hash now that we have the password.
    if (needsRehash(user.passwordHash)) {
      const upgraded = await hashPassword(body.password);
      await prisma.user
        .update({ where: { id: user.id }, data: { passwordHash: upgraded } })
        .catch((err) => logger.warn({ err }, 'password rehash failed'));
    }

    const deviceId = await resolveLoginDevice(user.id, body, request);

    const session = await createSession({
      userId: user.id,
      deviceId,
      passwordVersion: user.passwordVersion,
      request,
    });
    setSessionCookie(reply, session.cookieValue, session.expiresAt);
    setCsrfCookie(reply, session.csrfToken);

    const agent = describeUserAgent(request.headers['user-agent']);
    await recordSecurityEvent({
      userId: user.id,
      kind: 'session.created',
      detail: `Signed in from ${agent.name} on ${agent.platform}`,
      ipHint: ipHint(request),
    });

    const self = await loadSelf(user.id);
    return { user: self, deviceId, csrfToken: session.csrfToken };
  });

  /**
   * Bind the session to a device: either register a fresh one, or re-attach to
   * an existing one after the client proves it still holds that device's
   * private identity key.
   */
  async function resolveLoginDevice(
    userId: string,
    body: z.infer<typeof loginSchema>,
    request: FastifyRequest,
  ): Promise<string | null> {
    if (body.existingDevice) {
      const { deviceId, nonce, signature } = body.existingDevice;

      const consumed = await counters.getValue(`devchal:${nonce}`);
      if (!consumed) throw badRequest('That sign-in challenge has expired');
      await counters.del(`devchal:${nonce}`);

      const device = await prisma.device.findFirst({
        where: { id: deviceId, userId, removedAt: null },
        select: { id: true, identityPublicKey: true },
      });
      if (!device) throw notFound('That device is no longer registered');

      await sodium.ready;
      let ok = false;
      try {
        ok = sodium.crypto_sign_verify_detached(
          Buffer.from(signature, 'base64'),
          Buffer.from(`wolffmsg:device-auth:v1:${nonce}`, 'utf8'),
          Buffer.from(device.identityPublicKey),
        );
      } catch {
        ok = false;
      }
      if (!ok) throw unauthorized('That device could not prove its identity');
      return device.id;
    }

    if (body.device) {
      const { deviceId } = await registerDevice({
        userId,
        name: body.device.name,
        platform: body.device.platform,
        identityPublicKey: body.device.identityPublicKey,
        signedPreKey: body.device.signedPreKey,
        oneTimePreKeys: body.device.oneTimePreKeys,
        ipHint: ipHint(request),
      });
      return deviceId;
    }

    // A session with no device can read chat metadata but cannot decrypt.
    return null;
  }

  app.post('/api/auth/logout', async (request, reply) => {
    const auth = request.auth;
    if (auth) {
      await revokeSession(auth.sessionId, 'signed out');
      await disconnectSessions([auth.sessionId], 'signed out');
      await recordSecurityEvent({
        userId: auth.userId,
        kind: 'session.revoked',
        detail: 'Signed out',
        ipHint: ipHint(request),
      });
    }
    clearAuthCookies(reply);
    return { ok: true };
  });

  app.get('/api/auth/me', async (request, reply) => {
    const auth = requireAuth(request);
    const user = await loadSelf(auth.userId);
    if (!user) throw unauthorized();

    // A client that still holds a valid session but lost its CSRF cookie
    // (cleared site data, expiry skew) can recover here rather than being
    // stuck unable to make any write.
    let csrfToken = request.cookies?.[csrfCookieName()];
    if (!csrfToken) {
      csrfToken = crypto.randomBytes(32).toString('base64url');
      setCsrfCookie(reply, csrfToken);
    }

    return {
      user,
      deviceId: auth.deviceId,
      sessionId: auth.sessionId,
      csrfToken,
    };
  });

  app.post('/api/auth/password', async (request, reply) => {
    const auth = requireAuth(request);
    await consume(RATE_LIMITS.passwordChange, `u:${auth.userId}`);

    const body = passwordChangeSchema.parse(request.body);
    const problem = validatePassword(body.newPassword);
    if (problem) throw badRequest(problem.message, { newPassword: problem.message });
    if (body.currentPassword === body.newPassword) {
      throw badRequest('Choose a password you have not used here before', {
        newPassword: 'That is your current password',
      });
    }

    const user = await prisma.user.findUniqueOrThrow({
      where: { id: auth.userId },
      select: { passwordHash: true, passwordVersion: true },
    });
    if (!(await verifyPassword(user.passwordHash, body.currentPassword))) {
      throw unauthorized('That is not your current password');
    }

    const passwordHash = await hashPassword(body.newPassword);
    const revokeOthers = body.revokeOtherSessions ?? true;

    await prisma.user.update({
      where: { id: auth.userId },
      data: {
        passwordHash,
        // Bumping the version retires every session issued under the old
        // password — including any an attacker may already hold.
        ...(revokeOthers ? { passwordVersion: { increment: 1 } } : {}),
      },
    });

    if (revokeOthers) {
      const revoked = await revokeAllSessions(
        auth.userId,
        'password changed',
        auth.sessionId,
      );
      await disconnectSessions(revoked, 'password changed');
      // Keep this session alive by re-issuing it under the new version.
      await prisma.session.update({
        where: { id: auth.sessionId },
        data: { passwordVersion: { increment: 1 } },
      });
    }

    await recordSecurityEvent({
      userId: auth.userId,
      kind: 'password.changed',
      detail: revokeOthers
        ? 'Password changed; other sessions signed out'
        : 'Password changed',
      ipHint: ipHint(request),
    });

    reply.status(200);
    return { ok: true };
  });

  app.get('/api/auth/sessions', async (request) => {
    const auth = requireAuth(request);
    const sessions = await prisma.session.findMany({
      where: { userId: auth.userId, revokedAt: null, expiresAt: { gt: new Date() } },
      orderBy: { lastActiveAt: 'desc' },
      select: {
        id: true,
        userAgent: true,
        createdAt: true,
        lastActiveAt: true,
        expiresAt: true,
        ipHint: true,
      },
    });

    const items: SessionSummary[] = sessions.map((s) => {
      const [name, platform] = (s.userAgent ?? ' · ').split(' · ');
      return {
        id: s.id,
        deviceName: name || 'Unknown',
        platform: platform || 'Unknown',
        createdAt: s.createdAt.toISOString(),
        lastActiveAt: s.lastActiveAt.toISOString(),
        expiresAt: s.expiresAt.toISOString(),
        ipHint: s.ipHint,
        current: s.id === auth.sessionId,
      };
    });
    return { sessions: items };
  });

  app.delete<{ Params: { sessionId: string } }>(
    '/api/auth/sessions/:sessionId',
    async (request) => {
      const auth = requireAuth(request);
      const { sessionId } = request.params;

      // Scoped to the caller's own sessions — an id alone grants nothing.
      const target = await prisma.session.findFirst({
        where: { id: sessionId, userId: auth.userId },
        select: { id: true },
      });
      if (!target) throw notFound('That session does not exist');

      await revokeSession(sessionId, 'revoked by user');
      await disconnectSessions([sessionId], 'signed out from another device');
      await recordSecurityEvent({
        userId: auth.userId,
        kind: 'session.revoked',
        detail: 'Session signed out from another device',
        ipHint: ipHint(request),
      });
      return { ok: true };
    },
  );

  app.post('/api/auth/sessions/revoke-others', async (request) => {
    const auth = requireAuth(request);
    const revoked = await revokeAllSessions(
      auth.userId,
      'revoked by user',
      auth.sessionId,
    );
    await disconnectSessions(revoked, 'signed out from another device');
    await recordSecurityEvent({
      userId: auth.userId,
      kind: 'session.revoked',
      detail: `${revoked.length} other session(s) signed out`,
      ipHint: ipHint(request),
    });
    return { revoked: revoked.length };
  });

  app.get('/api/auth/registration-open', async () => ({
    open: env.ALLOW_REGISTRATION,
  }));

  /** Availability check for the sign-up form. */
  app.get<{ Querystring: { username?: string } }>(
    '/api/auth/username-available',
    async (request: FastifyRequest<{ Querystring: { username?: string } }>, reply: FastifyReply) => {
      await consumeByIp(RATE_LIMITS.search, request);
      const username = normalizeUsername(request.query.username ?? '');
      const problem = validateUsername(username);
      if (problem) {
        reply.status(200);
        return { available: false, reason: problem.message };
      }
      const existing = await prisma.user.findUnique({
        where: { username },
        select: { id: true },
      });
      return { available: !existing, reason: existing ? 'Already taken' : null };
    },
  );

}
