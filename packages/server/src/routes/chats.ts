import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { LIMITS } from '@wolffmsg/shared';
import { requireAuth } from '../auth/session.js';
import { RATE_LIMITS, consumeByUser } from '../security/rateLimit.js';
import {
  addMembers,
  createGroup,
  deleteGroup,
  leaveChat,
  listChats,
  loadChatSummary,
  openDirectChat,
  pinMessage,
  removeMember,
  setGroupPermissions,
  setMemberRole,
  transferOwnership,
  unpinMessage,
  updateGroupInfo,
  updateMembership,
} from '../services/chats.js';
import { callHistory, iceServers } from '../services/calls.js';

const idSchema = z.string().min(1).max(64);

const createGroupSchema = z.object({
  title: z.string().min(1).max(200),
  description: z.string().max(2_000).nullable().optional(),
  memberIds: z.array(idSchema).max(LIMITS.groupMembersMax).default([]),
});

const updateGroupSchema = z.object({
  title: z.string().min(1).max(200).optional(),
  description: z.string().max(2_000).nullable().optional(),
});

const membershipSchema = z.object({
  pinned: z.boolean().optional(),
  archived: z.boolean().optional(),
  muted: z.boolean().optional(),
  mutedUntil: z.string().datetime().nullable().optional(),
});

export async function chatRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/chats', async (request) => {
    const auth = requireAuth(request);
    return { chats: await listChats(auth.userId, auth.deviceId) };
  });

  app.get<{ Params: { chatId: string } }>('/api/chats/:chatId', async (request) => {
    const auth = requireAuth(request);
    return {
      chat: await loadChatSummary(request.params.chatId, auth.userId, auth.deviceId),
    };
  });

  /** Open (or reopen) a direct conversation. Idempotent. */
  app.post('/api/chats/direct', async (request, reply) => {
    const auth = requireAuth(request);
    await consumeByUser(RATE_LIMITS.createChat, auth.userId);
    const { userId } = z.object({ userId: idSchema }).parse(request.body);
    const chat = await openDirectChat(auth.userId, userId, auth.deviceId);
    reply.status(201);
    return { chat };
  });

  app.post('/api/chats/group', async (request, reply) => {
    const auth = requireAuth(request);
    await consumeByUser(RATE_LIMITS.createChat, auth.userId);
    const body = createGroupSchema.parse(request.body);
    const chat = await createGroup(
      auth.userId,
      {
        title: body.title,
        description: body.description ?? null,
        memberIds: body.memberIds,
      },
      auth.deviceId,
    );
    reply.status(201);
    return { chat };
  });

  app.patch<{ Params: { chatId: string } }>(
    '/api/chats/:chatId',
    async (request) => {
      const auth = requireAuth(request);
      const body = updateGroupSchema.parse(request.body);
      await updateGroupInfo(request.params.chatId, auth.userId, body);
      return {
        chat: await loadChatSummary(request.params.chatId, auth.userId, auth.deviceId),
      };
    },
  );

  app.patch<{ Params: { chatId: string } }>(
    '/api/chats/:chatId/permissions',
    async (request) => {
      const auth = requireAuth(request);
      const { readOnlyForMembers } = z
        .object({ readOnlyForMembers: z.boolean() })
        .parse(request.body);
      await setGroupPermissions(
        request.params.chatId,
        auth.userId,
        readOnlyForMembers,
      );
      return {
        chat: await loadChatSummary(request.params.chatId, auth.userId, auth.deviceId),
      };
    },
  );

  /** Per-user chat preferences: pin, mute, archive. */
  app.patch<{ Params: { chatId: string } }>(
    '/api/chats/:chatId/membership',
    async (request) => {
      const auth = requireAuth(request);
      const body = membershipSchema.parse(request.body);
      await updateMembership(request.params.chatId, auth.userId, body);
      return {
        chat: await loadChatSummary(request.params.chatId, auth.userId, auth.deviceId),
      };
    },
  );

  app.post<{ Params: { chatId: string } }>(
    '/api/chats/:chatId/members',
    async (request) => {
      const auth = requireAuth(request);
      const { userIds } = z
        .object({ userIds: z.array(idSchema).min(1).max(LIMITS.groupMembersMax) })
        .parse(request.body);
      const result = await addMembers(request.params.chatId, auth.userId, userIds);
      return {
        added: result.added,
        // People who could not be added — blocked, or whose privacy settings
        // exclude the caller. The UI names them rather than losing them.
        skipped: result.skipped,
        chat: await loadChatSummary(request.params.chatId, auth.userId, auth.deviceId),
      };
    },
  );

  app.delete<{ Params: { chatId: string; userId: string } }>(
    '/api/chats/:chatId/members/:userId',
    async (request) => {
      const auth = requireAuth(request);
      await removeMember(request.params.chatId, auth.userId, request.params.userId);
      return { ok: true };
    },
  );

  app.patch<{ Params: { chatId: string; userId: string } }>(
    '/api/chats/:chatId/members/:userId/role',
    async (request) => {
      const auth = requireAuth(request);
      const { role } = z
        .object({ role: z.enum(['admin', 'member']) })
        .parse(request.body);
      await setMemberRole(
        request.params.chatId,
        auth.userId,
        request.params.userId,
        role,
      );
      return {
        chat: await loadChatSummary(request.params.chatId, auth.userId, auth.deviceId),
      };
    },
  );

  app.post<{ Params: { chatId: string } }>(
    '/api/chats/:chatId/transfer-ownership',
    async (request) => {
      const auth = requireAuth(request);
      const { userId } = z.object({ userId: idSchema }).parse(request.body);
      await transferOwnership(request.params.chatId, auth.userId, userId);
      return {
        chat: await loadChatSummary(request.params.chatId, auth.userId, auth.deviceId),
      };
    },
  );

  app.post<{ Params: { chatId: string } }>(
    '/api/chats/:chatId/leave',
    async (request) => {
      const auth = requireAuth(request);
      await leaveChat(request.params.chatId, auth.userId);
      return { ok: true };
    },
  );

  app.delete<{ Params: { chatId: string } }>(
    '/api/chats/:chatId',
    async (request) => {
      const auth = requireAuth(request);
      await deleteGroup(request.params.chatId, auth.userId);
      return { ok: true };
    },
  );

  app.post<{ Params: { chatId: string; messageId: string } }>(
    '/api/chats/:chatId/pins/:messageId',
    async (request) => {
      const auth = requireAuth(request);
      const messageIds = await pinMessage(
        request.params.chatId,
        auth.userId,
        request.params.messageId,
      );
      return { pinnedMessageIds: messageIds };
    },
  );

  app.delete<{ Params: { chatId: string; messageId: string } }>(
    '/api/chats/:chatId/pins/:messageId',
    async (request) => {
      const auth = requireAuth(request);
      const messageIds = await unpinMessage(
        request.params.chatId,
        auth.userId,
        request.params.messageId,
      );
      return { pinnedMessageIds: messageIds };
    },
  );

  app.get<{ Params: { chatId: string } }>(
    '/api/chats/:chatId/calls',
    async (request) => {
      const auth = requireAuth(request);
      return { calls: await callHistory(request.params.chatId, auth.userId) };
    },
  );

  /**
   * ICE configuration for WebRTC. Requires a session, so an anonymous visitor
   * cannot harvest TURN credentials.
   */
  app.get('/api/calls/ice-servers', async (request) => {
    requireAuth(request);
    return { iceServers: iceServers() };
  });
}
