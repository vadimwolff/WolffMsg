import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireAuth } from '../auth/session.js';
import { RATE_LIMITS, consumeByUser } from '../security/rateLimit.js';
import {
  deleteMessage,
  editMessage,
  listMessages,
  loadMessage,
  markRead,
  sendMessage,
  toRecord,
  toggleReaction,
} from '../services/messages.js';
import { deleteBlobs } from '../storage/local.js';

const wrappedKeySchema = z.object({
  deviceId: z.string().min(1).max(64),
  preKeyId: z.string().max(64).nullable(),
  wrapped: z.string().min(1).max(256),
});

const envelopeSchema = z.object({
  v: z.number().int().min(1).max(10),
  alg: z.literal('xchacha20poly1305-ietf'),
  ciphertext: z.string().min(1).max(120_000),
  nonce: z.string().min(1).max(64),
  signature: z.string().min(1).max(200),
  keys: z.array(wrappedKeySchema).min(1).max(1_024),
});

const sendSchema = z.object({
  id: z.string().min(16).max(32),
  clientId: z.string().min(8).max(64).nullable().default(null),
  createdAt: z.number().int(),
  envelope: envelopeSchema,
  replyToId: z.string().min(1).max(64).nullable().default(null),
  attachmentIds: z.array(z.string().min(1).max(64)).max(10).default([]),
});

export async function messageRoutes(app: FastifyInstance): Promise<void> {
  app.get<{
    Params: { chatId: string };
    Querystring: { before?: string; after?: string; limit?: string };
  }>('/api/chats/:chatId/messages', async (request) => {
    const auth = requireAuth(request);
    const limit = request.query.limit ? Number(request.query.limit) : undefined;
    return listMessages(request.params.chatId, auth.userId, auth.deviceId, {
      ...(request.query.before ? { before: request.query.before } : {}),
      ...(request.query.after ? { after: request.query.after } : {}),
      ...(Number.isFinite(limit) ? { limit } : {}),
    });
  });

  app.post<{ Params: { chatId: string } }>(
    '/api/chats/:chatId/messages',
    async (request, reply) => {
      const auth = requireAuth(request);
      await consumeByUser(RATE_LIMITS.sendMessage, auth.userId);

      const body = sendSchema.parse(request.body);
      const { message, deduplicated } = await sendMessage({
        chatId: request.params.chatId,
        senderId: auth.userId,
        // Taken from the session, never from the request body — otherwise a
        // client could attribute a message to another of the user's devices.
        senderDeviceId: auth.deviceId,
        id: body.id,
        clientId: body.clientId,
        createdAt: body.createdAt,
        envelope: body.envelope,
        replyToId: body.replyToId,
        attachmentIds: body.attachmentIds,
      });

      reply.status(deduplicated ? 200 : 201);
      return {
        message: toRecord(message, auth.deviceId),
        deduplicated,
      };
    },
  );

  app.get<{ Params: { messageId: string } }>(
    '/api/messages/:messageId',
    async (request) => {
      const auth = requireAuth(request);
      return {
        message: await loadMessage(
          request.params.messageId,
          auth.userId,
          auth.deviceId,
        ),
      };
    },
  );

  app.patch<{ Params: { messageId: string } }>(
    '/api/messages/:messageId',
    async (request) => {
      const auth = requireAuth(request);
      await consumeByUser(RATE_LIMITS.sendMessage, auth.userId);
      const { envelope } = z.object({ envelope: envelopeSchema }).parse(request.body);
      const message = await editMessage(
        request.params.messageId,
        auth.userId,
        envelope,
      );
      return { message: toRecord(message, auth.deviceId) };
    },
  );

  app.delete<{ Params: { messageId: string } }>(
    '/api/messages/:messageId',
    async (request) => {
      const auth = requireAuth(request);
      const result = await deleteMessage(request.params.messageId, auth.userId);
      // Remove the encrypted blobs from disk too, not just the rows.
      await deleteBlobs(result.storageKeys);
      return { ok: true, deletedAt: result.deletedAt.toISOString() };
    },
  );

  app.post<{ Params: { messageId: string } }>(
    '/api/messages/:messageId/reactions',
    async (request) => {
      const auth = requireAuth(request);
      await consumeByUser(RATE_LIMITS.reaction, auth.userId);
      const { emoji } = z
        .object({ emoji: z.string().min(1).max(16) })
        .parse(request.body);
      const result = await toggleReaction(
        request.params.messageId,
        auth.userId,
        emoji,
      );
      return { reactions: result.reactions };
    },
  );

  app.post<{ Params: { chatId: string } }>(
    '/api/chats/:chatId/read',
    async (request) => {
      const auth = requireAuth(request);
      const { messageIds } = z
        .object({ messageIds: z.array(z.string().min(1).max(64)).max(500) })
        .parse(request.body);
      await markRead(request.params.chatId, auth.userId, messageIds);
      return { ok: true };
    },
  );
}
