import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  ALLOWED_AVATAR_MIME,
  LIMITS,
  PRIVACY_AUDIENCES,
  normalizeDisplayText,
  normalizeUsername,
  validateBio,
  validateDisplayName,
} from '@wolffmsg/shared';
import { prisma } from '../db.js';
import { env } from '../env.js';
import { badRequest, notFound, tooLarge } from '../errors.js';
import { requireAuth } from '../auth/session.js';
import { RATE_LIMITS, consumeByUser } from '../security/rateLimit.js';
import {
  loadPublicUser,
  loadSelf,
  publicUserSelect,
  projectUser,
  searchUsers,
} from '../services/users.js';
import { listSecurityEvents } from '../services/securityEvents.js';
import { deleteBlob, writeBuffer } from '../storage/local.js';
import { identityKeysFor } from '../services/devices.js';

const audience = z.enum(PRIVACY_AUDIENCES);

const profileSchema = z.object({
  displayName: z.string().min(1).max(200).optional(),
  bio: z.string().max(2_000).nullable().optional(),
});

const privacySchema = z.object({
  lastSeenVisibility: audience.optional(),
  avatarVisibility: audience.optional(),
  bioVisibility: audience.optional(),
  whoCanMessage: audience.optional(),
  whoCanAddToGroups: audience.optional(),
  readReceipts: z.boolean().optional(),
  typingIndicators: z.boolean().optional(),
});

const notificationSchema = z.object({
  enabled: z.boolean().optional(),
  showPreview: z.boolean().optional(),
  sound: z.boolean().optional(),
  mutedUntil: z.string().datetime().nullable().optional(),
});

const appearanceSchema = z.object({
  theme: z.enum(['dark', 'light', 'system']).optional(),
  accent: z.string().max(24).optional(),
  messageDensity: z.enum(['comfortable', 'compact']).optional(),
  reducedMotion: z.boolean().optional(),
  fontScale: z.number().min(0.8).max(1.4).optional(),
});

export async function userRoutes(app: FastifyInstance): Promise<void> {
  app.get<{ Querystring: { q?: string } }>('/api/users/search', async (request) => {
    const auth = requireAuth(request);
    await consumeByUser(RATE_LIMITS.search, auth.userId);

    const query = (request.query.q ?? '').slice(0, LIMITS.searchQueryMax);
    const users = await searchUsers(query, auth.userId);
    return { users };
  });

  app.get<{ Params: { userId: string } }>(
    '/api/users/:userId',
    async (request) => {
      const auth = requireAuth(request);
      const user = await loadPublicUser(request.params.userId, auth.userId);
      if (!user) throw notFound('That person could not be found');
      return { user };
    },
  );

  app.get<{ Params: { username: string } }>(
    '/api/users/by-username/:username',
    async (request) => {
      const auth = requireAuth(request);
      await consumeByUser(RATE_LIMITS.search, auth.userId);

      const row = await prisma.user.findFirst({
        where: {
          username: normalizeUsername(request.params.username),
          disabledAt: null,
        },
        select: publicUserSelect,
      });
      if (!row) throw notFound('That person could not be found');
      return { user: await projectUser(row, auth.userId) };
    },
  );

  /** Public identity keys, so a client can pin them and show a safety number. */
  app.get<{ Params: { userId: string } }>(
    '/api/users/:userId/identity',
    async (request) => {
      const auth = requireAuth(request);
      const user = await loadPublicUser(request.params.userId, auth.userId);
      if (!user) throw notFound('That person could not be found');
      return { devices: await identityKeysFor(request.params.userId) };
    },
  );

  app.patch('/api/me/profile', async (request) => {
    const auth = requireAuth(request);
    const body = profileSchema.parse(request.body);

    const data: { displayName?: string; bio?: string | null } = {};

    if (body.displayName !== undefined) {
      const displayName = normalizeDisplayText(body.displayName);
      const problem = validateDisplayName(displayName);
      if (problem) throw badRequest(problem.message, { displayName: problem.message });
      data.displayName = displayName;
    }

    if (body.bio !== undefined) {
      const bio = body.bio === null ? null : normalizeDisplayText(body.bio);
      const problem = validateBio(bio);
      if (problem) throw badRequest(problem.message, { bio: problem.message });
      data.bio = bio;
    }

    if (Object.keys(data).length > 0) {
      await prisma.user.update({ where: { id: auth.userId }, data });
    }
    return { user: await loadSelf(auth.userId) };
  });

  app.patch('/api/me/privacy', async (request) => {
    const auth = requireAuth(request);
    const body = privacySchema.parse(request.body);
    await prisma.userSettings.upsert({
      where: { userId: auth.userId },
      create: { userId: auth.userId, ...body },
      update: body,
    });
    return { user: await loadSelf(auth.userId) };
  });

  app.patch('/api/me/notifications', async (request) => {
    const auth = requireAuth(request);
    const body = notificationSchema.parse(request.body);
    const data = {
      ...(body.enabled !== undefined ? { notificationsEnabled: body.enabled } : {}),
      ...(body.showPreview !== undefined
        ? { notificationPreview: body.showPreview }
        : {}),
      ...(body.sound !== undefined ? { notificationSound: body.sound } : {}),
      ...(body.mutedUntil !== undefined
        ? { mutedUntil: body.mutedUntil ? new Date(body.mutedUntil) : null }
        : {}),
    };
    await prisma.userSettings.upsert({
      where: { userId: auth.userId },
      create: { userId: auth.userId, ...data },
      update: data,
    });
    return { user: await loadSelf(auth.userId) };
  });

  app.patch('/api/me/appearance', async (request) => {
    const auth = requireAuth(request);
    const body = appearanceSchema.parse(request.body);
    await prisma.userSettings.upsert({
      where: { userId: auth.userId },
      create: { userId: auth.userId, ...body },
      update: body,
    });
    return { user: await loadSelf(auth.userId) };
  });

  /**
   * Avatar upload.
   *
   * Unlike message attachments, avatars are shown to other people and so are
   * stored unencrypted. That makes them the one place the server does inspect
   * bytes: the magic number must match the declared type, which stops an
   * HTML or SVG payload being served under an image content type.
   */
  app.post('/api/me/avatar', async (request) => {
    const auth = requireAuth(request);
    await consumeByUser(RATE_LIMITS.uploadAttachment, auth.userId);

    const file = await request.file({ limits: { fileSize: env.MAX_AVATAR_BYTES } });
    if (!file) throw badRequest('No image was uploaded');

    const declared = (file.mimetype ?? '').split(';')[0]?.trim().toLowerCase() ?? '';
    if (!ALLOWED_AVATAR_MIME.has(declared)) {
      throw badRequest('Avatars must be a JPEG, PNG or WebP image');
    }

    const buffer = await file.toBuffer();
    if (file.file.truncated || buffer.length > env.MAX_AVATAR_BYTES) {
      throw tooLarge('That image is too large');
    }

    const detected = sniffImageType(buffer);
    if (!detected || detected !== declared) {
      throw badRequest('That file does not look like the image type it claims');
    }

    const stored = await writeBuffer(buffer);
    const previous = await prisma.user.findUniqueOrThrow({
      where: { id: auth.userId },
      select: { avatarKey: true },
    });

    await prisma.user.update({
      where: { id: auth.userId },
      data: { avatarKey: stored.storageKey },
    });
    if (previous.avatarKey) await deleteBlob(previous.avatarKey);

    return { user: await loadSelf(auth.userId) };
  });

  app.delete('/api/me/avatar', async (request) => {
    const auth = requireAuth(request);
    const previous = await prisma.user.findUniqueOrThrow({
      where: { id: auth.userId },
      select: { avatarKey: true },
    });
    await prisma.user.update({
      where: { id: auth.userId },
      data: { avatarKey: null },
    });
    if (previous.avatarKey) await deleteBlob(previous.avatarKey);
    return { user: await loadSelf(auth.userId) };
  });

  app.get('/api/me/security-events', async (request) => {
    const auth = requireAuth(request);
    return { events: await listSecurityEvents(auth.userId) };
  });

  /** Storage the account is using — shown on the Storage settings screen. */
  app.get('/api/me/storage', async (request) => {
    const auth = requireAuth(request);
    const [attachments, messages, chats] = await Promise.all([
      prisma.attachment.aggregate({
        where: { uploaderId: auth.userId },
        _sum: { encryptedSize: true },
        _count: { _all: true },
      }),
      prisma.message.count({ where: { senderId: auth.userId, deletedAt: null } }),
      prisma.chatMember.count({ where: { userId: auth.userId } }),
    ]);
    return {
      attachmentBytes: attachments._sum.encryptedSize ?? 0,
      attachmentCount: attachments._count._all,
      messageCount: messages,
      chatCount: chats,
    };
  });
}

/**
 * Identify an image by its magic bytes.
 *
 * Deliberately narrow: only the three raster formats we accept. Anything else
 * — including SVG, which is an XSS vector when served inline — fails.
 */
function sniffImageType(buffer: Buffer): string | null {
  if (buffer.length < 12) return null;
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return 'image/jpeg';
  }
  if (
    buffer[0] === 0x89 &&
    buffer[1] === 0x50 &&
    buffer[2] === 0x4e &&
    buffer[3] === 0x47 &&
    buffer[4] === 0x0d &&
    buffer[5] === 0x0a &&
    buffer[6] === 0x1a &&
    buffer[7] === 0x0a
  ) {
    return 'image/png';
  }
  if (
    buffer.subarray(0, 4).toString('ascii') === 'RIFF' &&
    buffer.subarray(8, 12).toString('ascii') === 'WEBP'
  ) {
    return 'image/webp';
  }
  return null;
}
