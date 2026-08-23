import type { ChatRole, PrivacyAudience } from '@wolffmsg/shared';
import { prisma } from '../db.js';
import { forbidden, notFound } from '../errors.js';

/**
 * Every authorization decision in WolffMsg goes through this module.
 *
 * Nothing here ever reads a role, a chat id, or a user id from a request body
 * and trusts it. Ids arriving from a client are treated purely as lookup keys;
 * the *permission* is always re-derived from the database row.
 */

export interface Membership {
  chatId: string;
  userId: string;
  role: ChatRole;
  joinedAtSeq: bigint;
  chatType: 'direct' | 'group';
  readOnlyForMembers: boolean;
  ownerId: string | null;
}

const ROLE_RANK: Record<ChatRole, number> = { member: 0, admin: 1, owner: 2 };

/**
 * Confirm the caller is a member of the chat and return their real role.
 *
 * Answers 404 rather than 403 for a chat the caller is not in: telling an
 * outsider "that exists but you cannot see it" is itself a disclosure.
 */
export async function requireMembership(
  chatId: string,
  userId: string,
): Promise<Membership> {
  const member = await prisma.chatMember.findUnique({
    where: { chatId_userId: { chatId, userId } },
    select: {
      chatId: true,
      userId: true,
      role: true,
      joinedAtSeq: true,
      chat: {
        select: { type: true, readOnlyForMembers: true, ownerId: true },
      },
    },
  });
  if (!member) throw notFound('That conversation does not exist');

  return {
    chatId: member.chatId,
    userId: member.userId,
    role: member.role as ChatRole,
    joinedAtSeq: member.joinedAtSeq,
    chatType: member.chat.type as 'direct' | 'group',
    readOnlyForMembers: member.chat.readOnlyForMembers,
    ownerId: member.chat.ownerId,
  };
}

export function requireRole(membership: Membership, minimum: ChatRole): void {
  if (ROLE_RANK[membership.role] < ROLE_RANK[minimum]) {
    throw forbidden(
      minimum === 'owner'
        ? 'Only the group owner can do that'
        : 'Only group admins can do that',
    );
  }
}

export async function requireChatAdmin(
  chatId: string,
  userId: string,
): Promise<Membership> {
  const membership = await requireMembership(chatId, userId);
  if (membership.chatType === 'direct') {
    throw forbidden('That action does not apply to a direct conversation');
  }
  requireRole(membership, 'admin');
  return membership;
}

export async function requireChatOwner(
  chatId: string,
  userId: string,
): Promise<Membership> {
  const membership = await requireMembership(chatId, userId);
  if (membership.chatType === 'direct') {
    throw forbidden('That action does not apply to a direct conversation');
  }
  requireRole(membership, 'owner');
  return membership;
}

/** May this member post right now? */
export async function requireCanPost(
  chatId: string,
  userId: string,
): Promise<Membership> {
  const membership = await requireMembership(chatId, userId);

  if (membership.readOnlyForMembers && membership.role === 'member') {
    throw forbidden('Only admins can post in this group');
  }

  if (membership.chatType === 'direct') {
    const peer = await directPeerId(chatId, userId);
    if (peer) {
      const gate = await messagePermission(userId, peer);
      if (gate !== 'allowed') {
        throw forbidden(
          gate === 'blocked'
            ? 'You can no longer send messages in this conversation'
            : 'This person does not accept messages from you',
        );
      }
    }
  }

  return membership;
}

export async function directPeerId(
  chatId: string,
  userId: string,
): Promise<string | null> {
  const others = await prisma.chatMember.findMany({
    where: { chatId, userId: { not: userId } },
    select: { userId: true },
    take: 1,
  });
  return others[0]?.userId ?? null;
}

/* ─────────────────────────────── blocking ───────────────────────────────── */

/**
 * True when either side has blocked the other. Blocking is symmetric in
 * effect: neither party can reach the other, so a blocked user cannot tell
 * whether they were blocked or the account went quiet.
 */
export async function isBlockedEitherWay(
  a: string,
  b: string,
): Promise<boolean> {
  if (a === b) return false;
  const found = await prisma.blockedUser.findFirst({
    where: {
      OR: [
        { blockerId: a, blockedId: b },
        { blockerId: b, blockedId: a },
      ],
    },
    select: { id: true },
  });
  return found !== null;
}

export async function hasBlocked(
  blockerId: string,
  blockedId: string,
): Promise<boolean> {
  const found = await prisma.blockedUser.findUnique({
    where: { blockerId_blockedId: { blockerId, blockedId } },
    select: { id: true },
  });
  return found !== null;
}

/* ────────────────────────────── contact graph ───────────────────────────── */

export async function isContactOf(
  ownerId: string,
  targetId: string,
): Promise<boolean> {
  if (ownerId === targetId) return true;
  const found = await prisma.contact.findUnique({
    where: { ownerId_targetId: { ownerId, targetId } },
    select: { id: true },
  });
  return found !== null;
}

/**
 * Resolve a privacy audience against a specific viewer.
 *
 * `owner` is whose setting this is; `viewer` is who is asking. "contacts"
 * means *the owner's* contacts, not the viewer's — otherwise anyone could
 * grant themselves visibility by adding the owner.
 */
export async function audienceAllows(
  audience: PrivacyAudience,
  ownerId: string,
  viewerId: string,
): Promise<boolean> {
  if (ownerId === viewerId) return true;
  switch (audience) {
    case 'everyone':
      return true;
    case 'nobody':
      return false;
    case 'contacts':
      return isContactOf(ownerId, viewerId);
    default:
      return false;
  }
}

export type MessageGate = 'allowed' | 'blocked' | 'not-permitted';

/** Whether `senderId` is allowed to open or continue a DM with `targetId`. */
export async function messagePermission(
  senderId: string,
  targetId: string,
): Promise<MessageGate> {
  if (senderId === targetId) return 'allowed';
  if (await isBlockedEitherWay(senderId, targetId)) return 'blocked';

  const settings = await prisma.userSettings.findUnique({
    where: { userId: targetId },
    select: { whoCanMessage: true },
  });
  const audience = (settings?.whoCanMessage ?? 'everyone') as PrivacyAudience;
  return (await audienceAllows(audience, targetId, senderId))
    ? 'allowed'
    : 'not-permitted';
}

/** Whether `actorId` may add `targetId` to a group. */
export async function groupAddPermission(
  actorId: string,
  targetId: string,
): Promise<MessageGate> {
  if (await isBlockedEitherWay(actorId, targetId)) return 'blocked';
  const settings = await prisma.userSettings.findUnique({
    where: { userId: targetId },
    select: { whoCanAddToGroups: true },
  });
  const audience = (settings?.whoCanAddToGroups ?? 'contacts') as PrivacyAudience;
  return (await audienceAllows(audience, targetId, actorId))
    ? 'allowed'
    : 'not-permitted';
}

/**
 * Confirm the caller may read a specific message: they must be in the chat and
 * the message must not predate their joining.
 */
export async function requireMessageAccess(
  messageId: string,
  userId: string,
): Promise<{ chatId: string; senderId: string; seq: bigint; membership: Membership }> {
  const message = await prisma.message.findUnique({
    where: { id: messageId },
    select: { id: true, chatId: true, senderId: true, seq: true },
  });
  if (!message) throw notFound('That message does not exist');

  const membership = await requireMembership(message.chatId, userId);
  if (message.seq < membership.joinedAtSeq) {
    throw notFound('That message does not exist');
  }
  return {
    chatId: message.chatId,
    senderId: message.senderId,
    seq: message.seq,
    membership,
  };
}
