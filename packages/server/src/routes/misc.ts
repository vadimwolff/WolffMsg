import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { prisma } from '../db.js';
import { env } from '../env.js';
import { requireAuth } from '../auth/session.js';
import { RATE_LIMITS, consumeByUser } from '../security/rateLimit.js';
import {
  removePushSubscription,
  savePushSubscription,
  vapidPublicKey,
} from '../services/push.js';
import {
  markNotificationsRead,
  unreadNotificationCount,
} from '../services/notifications.js';

export async function miscRoutes(app: FastifyInstance): Promise<void> {
  /** Liveness probe. Deliberately reveals nothing about the deployment. */
  app.get('/api/health', async () => ({ status: 'ok' }));

  /** Readiness probe — checks the database is actually reachable. */
  app.get('/api/ready', async (_request, reply) => {
    try {
      await prisma.$queryRaw`SELECT 1`;
      return { status: 'ready' };
    } catch {
      reply.status(503);
      return { status: 'unavailable' };
    }
  });

  /** Client bootstrap: what this server supports. */
  app.get('/api/config', async () => ({
    registrationOpen: env.ALLOW_REGISTRATION,
    pushEnabled: env.pushEnabled,
    vapidPublicKey: vapidPublicKey(),
    maxAttachmentBytes: env.MAX_ATTACHMENT_BYTES,
    maxAvatarBytes: env.MAX_AVATAR_BYTES,
    callsEnabled: true,
    turnConfigured: Boolean(env.TURN_SERVER),
  }));

  app.post('/api/push/subscribe', async (request, reply) => {
    const auth = requireAuth(request);
    await consumeByUser(RATE_LIMITS.pushSubscribe, auth.userId);

    const body = z
      .object({
        endpoint: z.string().min(1).max(1_000),
        keys: z.object({
          p256dh: z.string().min(1).max(200),
          auth: z.string().min(1).max(200),
        }),
      })
      .parse(request.body);

    await savePushSubscription(auth.userId, auth.deviceId, body);
    reply.status(201);
    return { ok: true };
  });

  app.post('/api/push/unsubscribe', async (request) => {
    const auth = requireAuth(request);
    const { endpoint } = z
      .object({ endpoint: z.string().min(1).max(1_000) })
      .parse(request.body);
    await removePushSubscription(auth.userId, endpoint);
    return { ok: true };
  });

  app.get('/api/notifications', async (request) => {
    const auth = requireAuth(request);
    const items = await prisma.notification.findMany({
      where: { userId: auth.userId },
      orderBy: { createdAt: 'desc' },
      take: 50,
      select: {
        id: true,
        kind: true,
        summary: true,
        chatId: true,
        messageId: true,
        createdAt: true,
        readAt: true,
      },
    });
    return {
      notifications: items.map((n) => ({
        ...n,
        createdAt: n.createdAt.toISOString(),
        readAt: n.readAt?.toISOString() ?? null,
      })),
      unread: await unreadNotificationCount(auth.userId),
    };
  });

  app.post('/api/notifications/read', async (request) => {
    const auth = requireAuth(request);
    const { chatId } = z
      .object({ chatId: z.string().min(1).max(64).optional() })
      .parse(request.body ?? {});
    await markNotificationsRead(auth.userId, chatId);
    return { ok: true };
  });
}
