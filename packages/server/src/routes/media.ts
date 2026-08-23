import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { prisma } from '../db.js';
import { env } from '../env.js';
import { badRequest, notFound } from '../errors.js';
import { requireAuth } from '../auth/session.js';
import { RATE_LIMITS, consumeByUser } from '../security/rateLimit.js';
import {
  deleteAttachment,
  openAttachment,
  uploadAttachment,
} from '../services/attachments.js';
import { audienceAllows, isBlockedEitherWay } from '../services/access.js';
import { readBlobStream } from '../storage/local.js';

/**
 * Headers applied to every blob response.
 *
 * The bytes here are either client-encrypted ciphertext or an image whose
 * magic number we verified. Either way the browser is told, unambiguously, not
 * to sniff, not to render inline, and not to execute anything — so even a
 * crafted payload cannot become script running on our origin.
 */
function applyBlobSecurityHeaders(reply: {
  header: (name: string, value: string) => unknown;
}): void {
  reply.header('X-Content-Type-Options', 'nosniff');
  reply.header('Content-Security-Policy', "default-src 'none'; sandbox");
  reply.header('Cross-Origin-Resource-Policy', 'same-origin');
  reply.header('Referrer-Policy', 'no-referrer');
}

export async function mediaRoutes(app: FastifyInstance): Promise<void> {
  /**
   * Upload an already-encrypted attachment.
   *
   * The declared MIME type is a routing hint from the client; the server
   * cannot verify it, because the bytes are ciphertext. It is checked against
   * an allow-list and never used to build a path or a response content type.
   */
  app.post<{ Querystring: { chatId?: string; mimeType?: string } }>(
    '/api/attachments',
    async (request, reply) => {
      const auth = requireAuth(request);
      await consumeByUser(RATE_LIMITS.uploadAttachment, auth.userId);

      const { chatId, mimeType } = z
        .object({
          chatId: z.string().min(1).max(64),
          mimeType: z.string().min(1).max(128),
        })
        .parse(request.query);

      const file = await request.file({
        limits: { fileSize: env.MAX_ATTACHMENT_BYTES },
      });
      if (!file) throw badRequest('No file was uploaded');

      const result = await uploadAttachment({
        uploaderId: auth.userId,
        chatId,
        mimeType,
        stream: file.file,
      });

      reply.status(201);
      return result;
    },
  );

  app.get<{ Params: { attachmentId: string } }>(
    '/api/attachments/:attachmentId',
    async (request, reply) => {
      const auth = requireAuth(request);
      const blob = await openAttachment(request.params.attachmentId, auth.userId);

      applyBlobSecurityHeaders(reply);
      // Always octet-stream: the real type is only known to the client that
      // holds the decryption key, and echoing the declared type back would
      // invite the browser to interpret attacker-chosen bytes.
      reply.header('Content-Type', 'application/octet-stream');
      reply.header('Content-Disposition', 'attachment');
      reply.header('Content-Length', String(blob.size));
      reply.header('Cache-Control', 'private, max-age=31536000, immutable');
      return reply.send(blob.stream);
    },
  );

  app.delete<{ Params: { attachmentId: string } }>(
    '/api/attachments/:attachmentId',
    async (request) => {
      const auth = requireAuth(request);
      await deleteAttachment(request.params.attachmentId, auth.userId);
      return { ok: true };
    },
  );

  /**
   * Avatars.
   *
   * Stored unencrypted because they are shown to other people, and gated by
   * the owner's `avatarVisibility` setting on every request — a leaked URL
   * alone does not grant access.
   */
  app.get<{ Params: { '*': string } }>(
    '/api/avatars/*',
    async (request, reply) => {
      const auth = requireAuth(request);
      const storageKey = request.params['*'];

      const owner = await prisma.user.findFirst({
        where: { avatarKey: storageKey },
        select: {
          id: true,
          settings: { select: { avatarVisibility: true } },
        },
      });

      if (owner) {
        if (await isBlockedEitherWay(auth.userId, owner.id)) {
          throw notFound('That image is not available');
        }
        const allowed = await audienceAllows(
          (owner.settings?.avatarVisibility ?? 'everyone') as
            | 'everyone'
            | 'contacts'
            | 'nobody',
          owner.id,
          auth.userId,
        );
        if (!allowed) throw notFound('That image is not available');
      } else {
        // Not a user avatar — check whether it is a group avatar the caller
        // is entitled to see.
        const chat = await prisma.chat.findFirst({
          where: { avatarKey: storageKey, members: { some: { userId: auth.userId } } },
          select: { id: true },
        });
        if (!chat) throw notFound('That image is not available');
      }

      applyBlobSecurityHeaders(reply);
      reply.header('Content-Type', 'application/octet-stream');
      reply.header('Content-Disposition', 'inline');
      reply.header('Cache-Control', 'private, max-age=86400');

      try {
        return reply.send(readBlobStream(storageKey));
      } catch {
        throw notFound('That image is not available');
      }
    },
  );
}
