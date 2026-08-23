import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { prisma } from '../db.js';
import { badRequest, forbidden, notFound } from '../errors.js';
import { requireAuth } from '../auth/session.js';
import { RATE_LIMITS, consumeByUser } from '../security/rateLimit.js';
import {
  claimPreKeyBundles,
  listDevices,
  preKeysRemaining,
  removeDevice,
  replenishPreKeys,
  rotateSignedPreKey,
} from '../services/devices.js';
import { requireMembership } from '../services/access.js';
import { disconnectSessions } from '../realtime/hub.js';

const preKeySchema = z.object({
  id: z.string().min(1).max(64),
  publicKey: z.string().min(1).max(128),
  signature: z.string().min(1).max(256),
});

export async function keyRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/devices', async (request) => {
    const auth = requireAuth(request);
    return { devices: await listDevices(auth.userId, auth.deviceId) };
  });

  app.delete<{ Params: { deviceId: string } }>(
    '/api/devices/:deviceId',
    async (request) => {
      const auth = requireAuth(request);
      const sessions = await prisma.session.findMany({
        where: { deviceId: request.params.deviceId, userId: auth.userId, revokedAt: null },
        select: { id: true },
      });
      await removeDevice(auth.userId, request.params.deviceId);
      await disconnectSessions(
        sessions.map((s) => s.id),
        'device removed',
      );
      return { ok: true };
    },
  );

  /** Top up this device's one-time prekeys. */
  app.post('/api/keys/one-time', async (request) => {
    const auth = requireAuth(request);
    if (!auth.deviceId) throw forbidden('This session is not bound to a device');
    const { preKeys } = z
      .object({ preKeys: z.array(preKeySchema).min(1).max(200) })
      .parse(request.body);
    return replenishPreKeys(auth.userId, auth.deviceId, preKeys);
  });

  app.post('/api/keys/signed', async (request) => {
    const auth = requireAuth(request);
    if (!auth.deviceId) throw forbidden('This session is not bound to a device');
    const { preKey } = z.object({ preKey: preKeySchema }).parse(request.body);
    await rotateSignedPreKey(auth.userId, auth.deviceId, preKey);
    return { ok: true };
  });

  app.get('/api/keys/status', async (request) => {
    const auth = requireAuth(request);
    if (!auth.deviceId) return { remaining: 0, deviceId: null };
    return {
      deviceId: auth.deviceId,
      remaining: await preKeysRemaining(auth.deviceId),
    };
  });

  /**
   * Claim prekey bundles for every device that must be able to read a message
   * in `chatId`.
   *
   * Scoped to a chat on purpose: a client cannot enumerate the key material of
   * arbitrary users, only of people it already shares a conversation with. The
   * one-time keys handed out here are consumed and never reissued.
   */
  app.post('/api/keys/claim', async (request) => {
    const auth = requireAuth(request);
    await consumeByUser(RATE_LIMITS.claimPreKeys, auth.userId);

    const { chatId, includeSelf } = z
      .object({
        chatId: z.string().min(1).max(64),
        includeSelf: z.boolean().default(true),
      })
      .parse(request.body);

    await requireMembership(chatId, auth.userId);

    const members = await prisma.chatMember.findMany({
      where: { chatId },
      select: { userId: true },
    });

    const devices = await prisma.device.findMany({
      where: {
        userId: { in: members.map((m) => m.userId) },
        removedAt: null,
      },
      select: { id: true, userId: true },
    });

    // The sender's *own* device is excluded — it already holds the plaintext —
    // but their other devices are included so history stays in sync.
    const targetIds = devices
      .filter((d) => d.id !== auth.deviceId)
      .filter((d) => includeSelf || d.userId !== auth.userId)
      .map((d) => d.id);

    const bundles = await claimPreKeyBundles(targetIds);
    return { bundles };
  });

  /** Claim bundles for one specific user (used before a DM exists). */
  app.post('/api/keys/claim-user', async (request) => {
    const auth = requireAuth(request);
    await consumeByUser(RATE_LIMITS.claimPreKeys, auth.userId);

    const { userId } = z
      .object({ userId: z.string().min(1).max(64) })
      .parse(request.body);

    // Only reachable for someone you actually share a conversation with, or
    // yourself. Otherwise this would drain a stranger's one-time prekeys.
    if (userId !== auth.userId) {
      const shared = await prisma.chatMember.findFirst({
        where: {
          userId: auth.userId,
          chat: { members: { some: { userId } } },
        },
        select: { chatId: true },
      });
      if (!shared) {
        throw forbidden('Open a conversation with this person first');
      }
    }

    const devices = await prisma.device.findMany({
      where: { userId, removedAt: null },
      select: { id: true },
    });
    const bundles = await claimPreKeyBundles(
      devices.map((d) => d.id).filter((id) => id !== auth.deviceId),
    );
    if (bundles.length === 0) {
      throw notFound('That person has no device able to receive messages');
    }
    return { bundles };
  });

  /**
   * A device proves it still holds its identity private key by signing a
   * server-issued nonce. Used when re-binding a session to an existing device.
   */
  app.post('/api/devices/rename', async (request) => {
    const auth = requireAuth(request);
    const { deviceId, name } = z
      .object({ deviceId: z.string().min(1).max(64), name: z.string().min(1).max(64) })
      .parse(request.body);

    const device = await prisma.device.findFirst({
      where: { id: deviceId, userId: auth.userId, removedAt: null },
      select: { id: true },
    });
    if (!device) throw notFound('That device is not registered to you');

    const clean = name.replace(/[\u0000-\u001F\u007F]/g, '').trim();
    if (!clean) throw badRequest('Give the device a name');

    await prisma.device.update({
      where: { id: deviceId },
      data: { name: clean.slice(0, 64) },
    });
    return { ok: true };
  });
}
