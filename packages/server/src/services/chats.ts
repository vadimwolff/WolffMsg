import {
  LIMITS,
  normalizeDisplayText,
  validateChatTitle,
  type ChatRole,
  type ChatSummary,
  type SystemEvent,
} from '@wolffmsg/shared';
import type { Prisma } from '@prisma/client';
import { prisma } from '../db.js';
import { badRequest, conflict, forbidden, notFound } from '../errors.js';
import {
  directPeerId,
  groupAddPermission,
  messagePermission,
  requireChatAdmin,
  requireChatOwner,
  requireMembership,
  type Membership,
} from './access.js';
import { projectUser, publicUserSelect } from './users.js';
import { buildMessageRecord, messageInclude } from './messageProjection.js';
import { publishToChat, publishToUsers } from '../realtime/hub.js';

/**
 * Direct chats are keyed by the sorted pair of participant ids. The unique
 * constraint on that column is what makes "open a DM" idempotent even when two
 * people tap it simultaneously.
 */
function directKeyFor(a: string, b: string): string {
  return [a, b].sort().join(':');
}

const chatSelect = {
  id: true,
  type: true,
  title: true,
  description: true,
  avatarKey: true,
  ownerId: true,
  readOnlyForMembers: true,
  createdAt: true,
  updatedAt: true,
  lastMessageAt: true,
  members: {
    select: {
      userId: true,
      role: true,
      joinedAt: true,
      user: { select: publicUserSelect },
    },
    orderBy: { joinedAt: 'asc' },
  },
  pinned: { select: { messageId: true }, orderBy: { createdAt: 'desc' } },
} satisfies Prisma.ChatSelect;

type ChatRow = Prisma.ChatGetPayload<{ select: typeof chatSelect }>;

/** Turn a chat row into the shape the client renders, for one viewer. */
export async function buildChatSummary(
  chat: ChatRow,
  viewerId: string,
  viewerDeviceId: string | null,
): Promise<ChatSummary> {
  const membership = await prisma.chatMember.findUnique({
    where: { chatId_userId: { chatId: chat.id, userId: viewerId } },
    select: {
      role: true,
      pinned: true,
      archived: true,
      muted: true,
      mutedUntil: true,
      lastReadSeq: true,
      joinedAtSeq: true,
    },
  });
  if (!membership) throw notFound('That conversation does not exist');

  const members = await Promise.all(
    chat.members.map(async (m) => ({
      userId: m.userId,
      role: m.role as ChatRole,
      joinedAt: m.joinedAt.toISOString(),
      user: await projectUser(m.user, viewerId),
    })),
  );

  const peerMember =
    chat.type === 'direct'
      ? (chat.members.find((m) => m.userId !== viewerId) ?? null)
      : null;

  const [unreadCount, lastMessageRow] = await Promise.all([
    prisma.message.count({
      where: {
        chatId: chat.id,
        seq: { gt: membership.lastReadSeq, gte: membership.joinedAtSeq },
        senderId: { not: viewerId },
        deletedAt: null,
      },
    }),
    prisma.message.findFirst({
      where: { chatId: chat.id, seq: { gte: membership.joinedAtSeq } },
      orderBy: { seq: 'desc' },
      include: messageInclude,
    }),
  ]);

  const lastReadMessage = await prisma.message.findFirst({
    where: { chatId: chat.id, seq: membership.lastReadSeq },
    select: { id: true },
  });

  return {
    id: chat.id,
    type: chat.type as 'direct' | 'group',
    title: chat.title,
    description: chat.description,
    avatarUrl: chat.avatarKey ? `/api/avatars/${chat.avatarKey}` : null,
    createdAt: chat.createdAt.toISOString(),
    updatedAt: chat.lastMessageAt.toISOString(),
    peer: peerMember ? await projectUser(peerMember.user, viewerId) : null,
    members,
    myRole: membership.role as ChatRole,
    pinned: membership.pinned,
    muted: membership.muted,
    mutedUntil: membership.mutedUntil?.toISOString() ?? null,
    archived: membership.archived,
    unreadCount,
    lastMessage: lastMessageRow
      ? buildMessageRecord(lastMessageRow, viewerDeviceId)
      : null,
    lastReadMessageId: lastReadMessage?.id ?? null,
    readOnlyForMembers: chat.readOnlyForMembers,
    pinnedMessageIds: chat.pinned.map((p) => p.messageId),
  };
}

export async function loadChatSummary(
  chatId: string,
  viewerId: string,
  viewerDeviceId: string | null,
): Promise<ChatSummary> {
  await requireMembership(chatId, viewerId);
  const chat = await prisma.chat.findUnique({ where: { id: chatId }, select: chatSelect });
  if (!chat) throw notFound('That conversation does not exist');
  return buildChatSummary(chat, viewerId, viewerDeviceId);
}

export async function listChats(
  viewerId: string,
  viewerDeviceId: string | null,
): Promise<ChatSummary[]> {
  const memberships = await prisma.chatMember.findMany({
    where: { userId: viewerId },
    select: { chatId: true },
  });
  if (memberships.length === 0) return [];

  const chats = await prisma.chat.findMany({
    where: { id: { in: memberships.map((m) => m.chatId) } },
    select: chatSelect,
    orderBy: { lastMessageAt: 'desc' },
  });

  const summaries = await Promise.all(
    chats.map((chat) => buildChatSummary(chat, viewerId, viewerDeviceId)),
  );

  // Pinned first, then most recent activity.
  return summaries.sort((a, b) => {
    if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
    return b.updatedAt.localeCompare(a.updatedAt);
  });
}

/* ────────────────────────────── creation ────────────────────────────────── */

export async function openDirectChat(
  viewerId: string,
  peerId: string,
  viewerDeviceId: string | null,
): Promise<ChatSummary> {
  if (viewerId === peerId) {
    throw badRequest('You cannot start a conversation with yourself');
  }

  const peer = await prisma.user.findFirst({
    where: { id: peerId, disabledAt: null },
    select: { id: true },
  });
  // Same answer whether the account is missing or unreachable, so this cannot
  // be used to probe which user ids exist.
  if (!peer) throw notFound('That person could not be found');

  const gate = await messagePermission(viewerId, peerId);
  if (gate !== 'allowed') {
    throw forbidden('This person does not accept messages from you');
  }

  const key = directKeyFor(viewerId, peerId);
  const existing = await prisma.chat.findUnique({
    where: { directKey: key },
    select: { id: true },
  });
  if (existing) {
    // Re-add the viewer if they had previously left.
    await prisma.chatMember.upsert({
      where: { chatId_userId: { chatId: existing.id, userId: viewerId } },
      create: { chatId: existing.id, userId: viewerId, role: 'member' },
      update: {},
    });
    return loadChatSummary(existing.id, viewerId, viewerDeviceId);
  }

  let chatId: string;
  try {
    const chat = await prisma.chat.create({
      data: {
        type: 'direct',
        directKey: key,
        members: {
          create: [
            { userId: viewerId, role: 'member' },
            { userId: peerId, role: 'member' },
          ],
        },
      },
      select: { id: true },
    });
    chatId = chat.id;
  } catch (err) {
    // Lost the race — the other side created it microseconds earlier.
    const raced = await prisma.chat.findUnique({
      where: { directKey: key },
      select: { id: true },
    });
    if (!raced) throw err;
    chatId = raced.id;
  }

  const summary = await loadChatSummary(chatId, viewerId, viewerDeviceId);
  await notifyChatUpdate(chatId, [peerId]);
  return summary;
}

export async function createGroup(
  ownerId: string,
  input: { title: string; description?: string | null; memberIds: string[] },
  viewerDeviceId: string | null,
): Promise<ChatSummary> {
  const title = normalizeDisplayText(input.title);
  const problem = validateChatTitle(title);
  if (problem) throw badRequest(problem.message, { title: problem.message });

  const description = input.description
    ? normalizeDisplayText(input.description).slice(0, LIMITS.chatDescriptionMax)
    : null;

  const requested = [...new Set(input.memberIds)].filter((id) => id !== ownerId);
  if (requested.length + 1 > LIMITS.groupMembersMax) {
    throw badRequest(`A group can hold at most ${LIMITS.groupMembersMax} people`);
  }

  const { allowed } = await partitionAddableMembers(ownerId, requested);

  const chat = await prisma.chat.create({
    data: {
      type: 'group',
      title,
      description,
      ownerId,
      members: {
        create: [
          { userId: ownerId, role: 'owner' },
          ...allowed.map((userId) => ({ userId, role: 'member' })),
        ],
      },
    },
    select: { id: true },
  });

  await appendSystemMessage(chat.id, ownerId, { kind: 'chat.created', actorId: ownerId });
  if (allowed.length > 0) {
    await appendSystemMessage(chat.id, ownerId, {
      kind: 'member.added',
      actorId: ownerId,
      targetIds: allowed,
    });
  }

  const summary = await loadChatSummary(chat.id, ownerId, viewerDeviceId);
  await notifyChatUpdate(chat.id, allowed);
  return summary;
}

/**
 * Split candidates into those the actor may add and those they may not.
 *
 * Someone can be unaddable because they blocked the actor, because their
 * "who can add me to groups" setting excludes them, or because the account no
 * longer exists. The caller reports the skipped ids back to the client so the
 * UI can say who was left out instead of quietly losing them.
 */
async function partitionAddableMembers(
  actorId: string,
  candidateIds: string[],
): Promise<{ allowed: string[]; skipped: string[] }> {
  if (candidateIds.length === 0) return { allowed: [], skipped: [] };

  const existing = await prisma.user.findMany({
    where: { id: { in: candidateIds }, disabledAt: null },
    select: { id: true },
  });
  const existingIds = new Set(existing.map((u) => u.id));

  const allowed: string[] = [];
  const skipped = candidateIds.filter((id) => !existingIds.has(id));

  for (const user of existing) {
    if ((await groupAddPermission(actorId, user.id)) === 'allowed') {
      allowed.push(user.id);
    } else {
      skipped.push(user.id);
    }
  }
  return { allowed, skipped };
}

/* ──────────────────────────── group management ──────────────────────────── */

export async function updateGroupInfo(
  chatId: string,
  actorId: string,
  patch: { title?: string; description?: string | null },
): Promise<void> {
  await requireChatAdmin(chatId, actorId);

  const data: Prisma.ChatUpdateInput = {};
  const events: SystemEvent[] = [];

  if (patch.title !== undefined) {
    const title = normalizeDisplayText(patch.title);
    const problem = validateChatTitle(title);
    if (problem) throw badRequest(problem.message, { title: problem.message });
    data.title = title;
    events.push({ kind: 'chat.renamed', actorId, title });
  }

  if (patch.description !== undefined) {
    const description = patch.description
      ? normalizeDisplayText(patch.description).slice(0, LIMITS.chatDescriptionMax)
      : null;
    data.description = description;
    events.push({ kind: 'chat.description', actorId, description });
  }

  if (Object.keys(data).length === 0) return;

  await prisma.chat.update({ where: { id: chatId }, data });
  for (const event of events) await appendSystemMessage(chatId, actorId, event);
  await notifyChatUpdate(chatId);
}

export async function setGroupPermissions(
  chatId: string,
  actorId: string,
  readOnlyForMembers: boolean,
): Promise<void> {
  await requireChatAdmin(chatId, actorId);
  await prisma.chat.update({ where: { id: chatId }, data: { readOnlyForMembers } });
  await appendSystemMessage(chatId, actorId, {
    kind: 'chat.permissions',
    actorId,
    readOnlyForMembers,
  });
  await notifyChatUpdate(chatId);
}

export async function addMembers(
  chatId: string,
  actorId: string,
  userIds: string[],
): Promise<{ added: string[]; skipped: string[] }> {
  await requireChatAdmin(chatId, actorId);

  const current = await prisma.chatMember.findMany({
    where: { chatId },
    select: { userId: true },
  });
  const currentIds = new Set(current.map((m) => m.userId));
  const candidates = [...new Set(userIds)].filter((id) => !currentIds.has(id));

  if (currentIds.size + candidates.length > LIMITS.groupMembersMax) {
    throw badRequest(`A group can hold at most ${LIMITS.groupMembersMax} people`);
  }

  const { allowed, skipped } = await partitionAddableMembers(actorId, candidates);
  if (allowed.length === 0) return { added: [], skipped };

  // New members see history from this point on, never what came before.
  const latest = await prisma.message.findFirst({
    where: { chatId },
    orderBy: { seq: 'desc' },
    select: { seq: true },
  });
  const joinedAtSeq = latest?.seq ?? 0n;

  await prisma.chatMember.createMany({
    data: allowed.map((userId) => ({
      chatId,
      userId,
      role: 'member',
      joinedAtSeq,
      lastReadSeq: joinedAtSeq,
    })),
    skipDuplicates: true,
  });

  await appendSystemMessage(chatId, actorId, {
    kind: 'member.added',
    actorId,
    targetIds: allowed,
  });
  await notifyChatUpdate(chatId, allowed);
  return { added: allowed, skipped };
}

export async function removeMember(
  chatId: string,
  actorId: string,
  targetId: string,
): Promise<void> {
  const actor = await requireChatAdmin(chatId, actorId);
  if (targetId === actorId) {
    throw badRequest('Use "leave group" to remove yourself');
  }

  const target = await prisma.chatMember.findUnique({
    where: { chatId_userId: { chatId, userId: targetId } },
    select: { role: true },
  });
  if (!target) throw notFound('That person is not in this group');

  // An admin cannot remove the owner or another admin; only the owner can.
  if (target.role === 'owner') throw forbidden('The owner cannot be removed');
  if (target.role === 'admin' && actor.role !== 'owner') {
    throw forbidden('Only the owner can remove an admin');
  }

  await prisma.chatMember.delete({
    where: { chatId_userId: { chatId, userId: targetId } },
  });
  await appendSystemMessage(chatId, actorId, {
    kind: 'member.removed',
    actorId,
    targetIds: [targetId],
  });
  await publishToUsers([targetId], { t: 'chat:removed', chatId });
  await notifyChatUpdate(chatId);
}

export async function leaveChat(chatId: string, userId: string): Promise<void> {
  const membership = await requireMembership(chatId, userId);
  if (membership.chatType === 'direct') {
    // Leaving a DM just hides it; the conversation is not a group to exit.
    await prisma.chatMember.delete({
      where: { chatId_userId: { chatId, userId } },
    });
    return;
  }

  if (membership.role === 'owner') {
    const successor = await prisma.chatMember.findFirst({
      where: { chatId, userId: { not: userId } },
      orderBy: [{ role: 'asc' }, { joinedAt: 'asc' }],
      select: { userId: true },
    });
    if (!successor) {
      // Last person out deletes the group.
      await prisma.chat.delete({ where: { id: chatId } });
      return;
    }
    await prisma.$transaction([
      prisma.chatMember.update({
        where: { chatId_userId: { chatId, userId: successor.userId } },
        data: { role: 'owner' },
      }),
      prisma.chat.update({ where: { id: chatId }, data: { ownerId: successor.userId } }),
      prisma.chatMember.delete({ where: { chatId_userId: { chatId, userId } } }),
    ]);
    await appendSystemMessage(chatId, userId, {
      kind: 'ownership.transferred',
      actorId: userId,
      targetId: successor.userId,
    });
  } else {
    await prisma.chatMember.delete({ where: { chatId_userId: { chatId, userId } } });
  }

  await appendSystemMessage(chatId, userId, { kind: 'member.left', actorId: userId });
  await publishToUsers([userId], { t: 'chat:removed', chatId });
  await notifyChatUpdate(chatId);
}

export async function setMemberRole(
  chatId: string,
  actorId: string,
  targetId: string,
  role: ChatRole,
): Promise<void> {
  const owner = await requireChatOwner(chatId, actorId);
  if (targetId === actorId) throw badRequest('You already own this group');
  if (role === 'owner') {
    throw badRequest('Use "transfer ownership" to hand the group over');
  }

  const target = await prisma.chatMember.findUnique({
    where: { chatId_userId: { chatId, userId: targetId } },
    select: { role: true },
  });
  if (!target) throw notFound('That person is not in this group');

  await prisma.chatMember.update({
    where: { chatId_userId: { chatId, userId: targetId } },
    data: { role },
  });
  await appendSystemMessage(chatId, actorId, {
    kind: 'role.changed',
    actorId,
    targetId,
    role,
  });
  await notifyChatUpdate(owner.chatId);
}

export async function transferOwnership(
  chatId: string,
  actorId: string,
  targetId: string,
): Promise<void> {
  await requireChatOwner(chatId, actorId);
  const target = await prisma.chatMember.findUnique({
    where: { chatId_userId: { chatId, userId: targetId } },
    select: { userId: true },
  });
  if (!target) throw notFound('That person is not in this group');

  await prisma.$transaction([
    prisma.chatMember.update({
      where: { chatId_userId: { chatId, userId: targetId } },
      data: { role: 'owner' },
    }),
    prisma.chatMember.update({
      where: { chatId_userId: { chatId, userId: actorId } },
      data: { role: 'admin' },
    }),
    prisma.chat.update({ where: { id: chatId }, data: { ownerId: targetId } }),
  ]);

  await appendSystemMessage(chatId, actorId, {
    kind: 'ownership.transferred',
    actorId,
    targetId,
  });
  await notifyChatUpdate(chatId);
}

export async function deleteGroup(chatId: string, actorId: string): Promise<void> {
  await requireChatOwner(chatId, actorId);
  const members = await prisma.chatMember.findMany({
    where: { chatId },
    select: { userId: true },
  });
  await prisma.chat.delete({ where: { id: chatId } });
  await publishToUsers(
    members.map((m) => m.userId),
    { t: 'chat:removed', chatId },
  );
}

/* ─────────────────────────── per-member settings ────────────────────────── */

export async function updateMembership(
  chatId: string,
  userId: string,
  patch: {
    pinned?: boolean;
    archived?: boolean;
    muted?: boolean;
    mutedUntil?: string | null;
  },
): Promise<void> {
  await requireMembership(chatId, userId);
  await prisma.chatMember.update({
    where: { chatId_userId: { chatId, userId } },
    data: {
      ...(patch.pinned !== undefined ? { pinned: patch.pinned } : {}),
      ...(patch.archived !== undefined ? { archived: patch.archived } : {}),
      ...(patch.muted !== undefined ? { muted: patch.muted } : {}),
      ...(patch.mutedUntil !== undefined
        ? { mutedUntil: patch.mutedUntil ? new Date(patch.mutedUntil) : null }
        : {}),
    },
  });
}

/* ───────────────────────────── pinned messages ──────────────────────────── */

export async function pinMessage(
  chatId: string,
  actorId: string,
  messageId: string,
): Promise<string[]> {
  const membership = await requireMembership(chatId, actorId);
  if (membership.chatType === 'group' && membership.role === 'member') {
    throw forbidden('Only group admins can pin messages');
  }

  const message = await prisma.message.findFirst({
    where: { id: messageId, chatId, deletedAt: null },
    select: { id: true },
  });
  if (!message) throw notFound('That message does not exist');

  const count = await prisma.pinnedMessage.count({ where: { chatId } });
  if (count >= LIMITS.pinnedPerChatMax) {
    throw conflict(`You can pin at most ${LIMITS.pinnedPerChatMax} messages`);
  }

  await prisma.pinnedMessage.upsert({
    where: { chatId_messageId: { chatId, messageId } },
    create: { chatId, messageId, pinnedById: actorId },
    update: {},
  });

  return broadcastPins(chatId);
}

export async function unpinMessage(
  chatId: string,
  actorId: string,
  messageId: string,
): Promise<string[]> {
  const membership = await requireMembership(chatId, actorId);
  if (membership.chatType === 'group' && membership.role === 'member') {
    throw forbidden('Only group admins can unpin messages');
  }
  await prisma.pinnedMessage
    .delete({ where: { chatId_messageId: { chatId, messageId } } })
    .catch(() => undefined);
  return broadcastPins(chatId);
}

async function broadcastPins(chatId: string): Promise<string[]> {
  const pins = await prisma.pinnedMessage.findMany({
    where: { chatId },
    orderBy: { createdAt: 'desc' },
    select: { messageId: true },
  });
  const messageIds = pins.map((p) => p.messageId);
  await publishToChat(chatId, { t: 'chat:pinned', chatId, messageIds });
  return messageIds;
}

/* ──────────────────────────── system messages ───────────────────────────── */

/**
 * System messages describe membership and settings changes. They carry no
 * user-authored text, so they are stored in the clear — a group's member list
 * is metadata the server necessarily knows in order to route messages.
 */
export async function appendSystemMessage(
  chatId: string,
  actorId: string,
  event: SystemEvent,
): Promise<void> {
  const message = await prisma.message.create({
    data: {
      chatId,
      senderId: actorId,
      systemEvent: event as unknown as Prisma.InputJsonValue,
    },
    include: messageInclude,
  });
  await prisma.chat.update({
    where: { id: chatId },
    data: { lastMessageAt: message.createdAt },
  });
  await publishToChat(chatId, {
    t: 'message:new',
    message: buildMessageRecord(message, null),
  });
}

/** Push a refreshed chat summary to everyone who can see it. */
export async function notifyChatUpdate(
  chatId: string,
  extraUserIds: string[] = [],
): Promise<void> {
  const chat = await prisma.chat.findUnique({ where: { id: chatId }, select: chatSelect });
  if (!chat) return;

  const recipients = new Set([...chat.members.map((m) => m.userId), ...extraUserIds]);
  for (const userId of recipients) {
    // Each member's summary differs (role, unread count, privacy-filtered
    // peers), so it has to be built per recipient.
    const summary = await buildChatSummary(chat, userId, null).catch(() => null);
    if (summary) await publishToUsers([userId], { t: 'chat:update', chat: summary });
  }
}

export async function memberIdsOf(chatId: string): Promise<string[]> {
  const members = await prisma.chatMember.findMany({
    where: { chatId },
    select: { userId: true },
  });
  return members.map((m) => m.userId);
}

export type { Membership };
export { directPeerId };
