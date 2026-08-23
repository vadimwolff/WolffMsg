import {
  validateReaction,
  type EncryptedEnvelope,
  type MessageRecord,
  type Paginated,
} from '@wolffmsg/shared';
import type { Prisma } from '@prisma/client';
import { prisma, isUniqueViolation } from '../db.js';
import { badRequest, conflict, forbidden } from '../errors.js';
import { logger } from '../logger.js';
import {
  requireCanPost,
  requireMembership,
  requireMessageAccess,
} from './access.js';
import {
  buildMessageRecord,
  messageInclude,
  type MessageWithRelations,
} from './messageProjection.js';
import { publishToChat, publishToUsers } from '../realtime/hub.js';
import { queueMessageNotifications } from './notifications.js';

/**
 * Message ids and timestamps are chosen by the sending client, because both
 * are inputs to the AEAD's associated data — the ciphertext is bound to them
 * before it ever reaches the server. The server therefore validates rather
 * than assigns: the id must look like 128 bits of randomness, and the
 * timestamp must be close to now, so a client cannot silently backdate or
 * post-date a message.
 *
 * Ordering never depends on the client's timestamp. That comes from `seq`, a
 * server-assigned monotonic ordinal.
 */
const MESSAGE_ID_PATTERN = /^[A-Za-z0-9_-]{16,32}$/;
const CLIENT_ID_PATTERN = /^[A-Za-z0-9_-]{8,64}$/;
const MAX_CLOCK_SKEW_MS = 5 * 60 * 1000;

/** Exact byte lengths produced by the protocol's primitives. */
const NONCE_BYTES = 24;
const SIGNATURE_BYTES = 64;
/** crypto_box_seal(32-byte key) = 32 ephemeral pk + 32 key + 16 MAC. */
const SEALED_KEY_BYTES = 80;
const MAX_CIPHERTEXT_BYTES = 64 * 1024;
const MAX_RECIPIENT_DEVICES = 1_024;

export interface SendMessageInput {
  chatId: string;
  senderId: string;
  senderDeviceId: string | null;
  id: string;
  clientId: string | null;
  createdAt: number;
  envelope: EncryptedEnvelope;
  replyToId: string | null;
  attachmentIds: string[];
}

function decodeExact(
  value: string,
  expected: number,
  field: string,
): Uint8Array<ArrayBuffer> {
  let buf: Buffer;
  try {
    buf = Buffer.from(value, 'base64');
  } catch {
    throw badRequest(`${field} is not valid base64`);
  }
  if (buf.length !== expected) {
    throw badRequest(`${field} must be exactly ${expected} bytes`);
  }
  return Uint8Array.from(buf);
}

function validateEnvelope(envelope: EncryptedEnvelope): {
  ciphertext: Uint8Array<ArrayBuffer>;
  nonce: Uint8Array<ArrayBuffer>;
  signature: Uint8Array<ArrayBuffer>;
} {
  if (!envelope || typeof envelope !== 'object') {
    throw badRequest('Missing message envelope');
  }
  if (envelope.alg !== 'xchacha20poly1305-ietf') {
    throw badRequest('Unsupported encryption algorithm');
  }
  if (!Array.isArray(envelope.keys) || envelope.keys.length === 0) {
    throw badRequest('A message must be addressed to at least one device');
  }
  if (envelope.keys.length > MAX_RECIPIENT_DEVICES) {
    throw badRequest('Too many recipient devices');
  }

  const ciphertext = Uint8Array.from(Buffer.from(envelope.ciphertext ?? '', 'base64'));
  if (ciphertext.length === 0) throw badRequest('Message ciphertext is empty');
  if (ciphertext.length > MAX_CIPHERTEXT_BYTES) {
    throw badRequest('That message is too large');
  }

  return {
    ciphertext,
    nonce: decodeExact(envelope.nonce ?? '', NONCE_BYTES, 'Nonce'),
    signature: decodeExact(envelope.signature ?? '', SIGNATURE_BYTES, 'Signature'),
  };
}

/**
 * Confirm every wrapped key is addressed to a device that actually belongs to
 * a member of this chat.
 *
 * Without this check a client could attach a key for an arbitrary device id
 * and use the messages table as a covert mailbox to a non-member.
 */
async function resolveRecipientDevices(
  chatId: string,
  envelope: EncryptedEnvelope,
): Promise<
  { deviceId: string; preKeyId: string | null; wrapped: Uint8Array<ArrayBuffer> }[]
> {
  const requested = [...new Set(envelope.keys.map((k) => k.deviceId))];
  const members = await prisma.chatMember.findMany({
    where: { chatId },
    select: { userId: true },
  });
  const memberIds = members.map((m) => m.userId);

  const validDevices = await prisma.device.findMany({
    where: { id: { in: requested }, userId: { in: memberIds }, removedAt: null },
    select: { id: true },
  });
  const valid = new Set(validDevices.map((d) => d.id));

  const rows: {
    deviceId: string;
    preKeyId: string | null;
    wrapped: Uint8Array<ArrayBuffer>;
  }[] = [];
  const seen = new Set<string>();

  for (const key of envelope.keys) {
    if (!valid.has(key.deviceId)) {
      // Silently drop rather than fail the send: a device may have been
      // removed between the sender fetching bundles and posting.
      continue;
    }
    if (seen.has(key.deviceId)) continue;
    seen.add(key.deviceId);

    if (key.preKeyId !== null && typeof key.preKeyId !== 'string') {
      throw badRequest('Malformed prekey reference');
    }
    if (typeof key.preKeyId === 'string' && key.preKeyId.length > 64) {
      throw badRequest('Malformed prekey reference');
    }

    rows.push({
      deviceId: key.deviceId,
      preKeyId: key.preKeyId,
      wrapped: decodeExact(key.wrapped ?? '', SEALED_KEY_BYTES, 'Wrapped key'),
    });
  }

  if (rows.length === 0) {
    throw badRequest('None of the addressed devices are in this conversation');
  }
  return rows;
}

export async function sendMessage(
  input: SendMessageInput,
): Promise<{ message: MessageWithRelations; deduplicated: boolean }> {
  if (!MESSAGE_ID_PATTERN.test(input.id)) {
    throw badRequest('Malformed message id');
  }
  if (input.clientId !== null && !CLIENT_ID_PATTERN.test(input.clientId)) {
    throw badRequest('Malformed client id');
  }

  const skew = Math.abs(Date.now() - input.createdAt);
  if (!Number.isFinite(input.createdAt) || skew > MAX_CLOCK_SKEW_MS) {
    throw badRequest(
      'Your device clock is too far from the server. Check your time settings.',
    );
  }

  await requireCanPost(input.chatId, input.senderId);

  // Idempotency: a retry after a dropped response must not duplicate.
  if (input.clientId) {
    const existing = await prisma.message.findUnique({
      where: {
        senderId_clientId: { senderId: input.senderId, clientId: input.clientId },
      },
      include: messageInclude,
    });
    if (existing) return { message: existing, deduplicated: true };
  }

  const { ciphertext, nonce, signature } = validateEnvelope(input.envelope);
  const keyRows = await resolveRecipientDevices(input.chatId, input.envelope);

  if (input.replyToId) {
    const parent = await prisma.message.findFirst({
      where: { id: input.replyToId, chatId: input.chatId },
      select: { id: true },
    });
    // A reply pointing outside this chat would leak a cross-chat reference.
    if (!parent) throw badRequest('You cannot reply to that message');
  }

  const attachments = await claimAttachments(
    input.attachmentIds,
    input.senderId,
    input.chatId,
  );

  let created: MessageWithRelations;
  try {
    created = await prisma.$transaction(async (tx) => {
      const message = await tx.message.create({
        data: {
          id: input.id,
          chatId: input.chatId,
          senderId: input.senderId,
          senderDeviceId: input.senderDeviceId,
          clientId: input.clientId,
          createdAt: new Date(input.createdAt),
          ciphertext,
          nonce,
          signature,
          envelopeVersion: input.envelope.v,
          replyToId: input.replyToId,
          keys: { createMany: { data: keyRows } },
        },
        include: messageInclude,
      });

      if (attachments.length > 0) {
        await tx.attachment.updateMany({
          where: { id: { in: attachments } },
          data: { messageId: message.id },
        });
      }

      await tx.chat.update({
        where: { id: input.chatId },
        data: { lastMessageAt: message.createdAt },
      });

      // The sender has by definition read their own message.
      await tx.chatMember.update({
        where: { chatId_userId: { chatId: input.chatId, userId: input.senderId } },
        data: { lastReadSeq: message.seq, lastReadAt: new Date() },
      });

      return message;
    });
  } catch (err) {
    if (isUniqueViolation(err, 'clientId')) {
      const existing = await prisma.message.findUnique({
        where: {
          senderId_clientId: {
            senderId: input.senderId,
            clientId: input.clientId ?? '',
          },
        },
        include: messageInclude,
      });
      if (existing) return { message: existing, deduplicated: true };
    }
    if (isUniqueViolation(err)) {
      throw conflict('That message has already been sent', 'duplicate_message');
    }
    throw err;
  }

  // Re-read with attachments now linked.
  const full = await prisma.message.findUniqueOrThrow({
    where: { id: created.id },
    include: messageInclude,
  });

  await fanOutMessage(full);
  await queueMessageNotifications(full);

  return { message: full, deduplicated: false };
}

/**
 * Deliver a new message to every connected device.
 *
 * Each device receives a record containing only its own wrapped key, so the
 * fan-out is per-connection rather than a single broadcast payload.
 */
export async function fanOutMessage(message: MessageWithRelations): Promise<void> {
  const members = await prisma.chatMember.findMany({
    where: { chatId: message.chatId, joinedAtSeq: { lte: message.seq } },
    select: { userId: true },
  });

  const deviceOwners = await prisma.device.findMany({
    where: { id: { in: message.keys.map((k) => k.deviceId) } },
    select: { id: true, userId: true },
  });
  const ownerByDevice = new Map(deviceOwners.map((d) => [d.id, d.userId]));

  // Each addressed device gets an envelope containing only its own wrapped
  // key, so the payload is built per device rather than broadcast whole.
  const served = new Set<string>();
  for (const key of message.keys) {
    const userId = ownerByDevice.get(key.deviceId);
    if (!userId) continue;
    served.add(userId);
    await publishToUsers(
      [userId],
      { t: 'message:new', message: buildMessageRecord(message, key.deviceId) },
      { deviceId: key.deviceId },
    );
  }

  // Members whose devices were not addressed still need their chat list to
  // move — they get a record with no envelope and will re-sync.
  const unserved = members.map((m) => m.userId).filter((id) => !served.has(id));
  if (unserved.length > 0) {
    await publishToUsers(unserved, {
      t: 'message:new',
      message: buildMessageRecord(message, null),
    });
  }
}

/* ─────────────────────────────── attachments ────────────────────────────── */

/**
 * Verify the caller actually uploaded these blobs, into this chat, and that
 * they are not already attached to another message.
 */
async function claimAttachments(
  attachmentIds: string[],
  uploaderId: string,
  chatId: string,
): Promise<string[]> {
  const ids = [...new Set(attachmentIds)];
  if (ids.length === 0) return [];
  if (ids.length > 10) throw badRequest('At most 10 attachments per message');

  const rows = await prisma.attachment.findMany({
    where: { id: { in: ids }, uploaderId, chatId, messageId: null },
    select: { id: true },
  });
  if (rows.length !== ids.length) {
    throw badRequest('One or more attachments are not available');
  }
  return rows.map((r) => r.id);
}

/* ──────────────────────────────── history ───────────────────────────────── */

export async function listMessages(
  chatId: string,
  viewerId: string,
  viewerDeviceId: string | null,
  options: { before?: string; after?: string; limit?: number } = {},
): Promise<Paginated<MessageRecord>> {
  const membership = await requireMembership(chatId, viewerId);
  const limit = Math.min(Math.max(options.limit ?? 50, 1), 100);

  const where: Prisma.MessageWhereInput = {
    chatId,
    seq: { gte: membership.joinedAtSeq },
  };

  if (options.before) {
    const cursor = parseCursor(options.before);
    where.seq = { gte: membership.joinedAtSeq, lt: cursor };
  } else if (options.after) {
    const cursor = parseCursor(options.after);
    where.seq = { gte: membership.joinedAtSeq > cursor ? membership.joinedAtSeq : cursor + 1n };
  }

  const rows = await prisma.message.findMany({
    where,
    include: messageInclude,
    orderBy: { seq: options.after ? 'asc' : 'desc' },
    take: limit + 1,
  });

  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  const ordered = options.after ? page : [...page].reverse();

  return {
    items: ordered.map((m) => buildMessageRecord(m, viewerDeviceId)),
    nextCursor:
      hasMore && ordered.length > 0
        ? String(options.after ? ordered[ordered.length - 1]!.id : page[page.length - 1]!.seq)
        : null,
  };
}

function parseCursor(value: string): bigint {
  try {
    const parsed = BigInt(value);
    if (parsed < 0n) throw new Error('negative');
    return parsed;
  } catch {
    throw badRequest('Invalid pagination cursor');
  }
}

export async function loadMessage(
  messageId: string,
  viewerId: string,
  viewerDeviceId: string | null,
): Promise<MessageRecord> {
  await requireMessageAccess(messageId, viewerId);
  const message = await prisma.message.findUniqueOrThrow({
    where: { id: messageId },
    include: messageInclude,
  });
  return buildMessageRecord(message, viewerDeviceId);
}

/* ───────────────────────────────── edit ─────────────────────────────────── */

export async function editMessage(
  messageId: string,
  editorId: string,
  envelope: EncryptedEnvelope,
): Promise<MessageWithRelations> {
  const access = await requireMessageAccess(messageId, editorId);
  // Only the author may edit. An admin can delete, never rewrite.
  if (access.senderId !== editorId) {
    throw forbidden('You can only edit your own messages');
  }

  const existing = await prisma.message.findUniqueOrThrow({
    where: { id: messageId },
    select: { deletedAt: true, systemEvent: true },
  });
  if (existing.deletedAt) throw badRequest('That message was deleted');
  if (existing.systemEvent) throw badRequest('System messages cannot be edited');

  const { ciphertext, nonce, signature } = validateEnvelope(envelope);
  const keyRows = await resolveRecipientDevices(access.chatId, envelope);

  const updated = await prisma.$transaction(async (tx) => {
    await tx.messageKey.deleteMany({ where: { messageId } });
    return tx.message.update({
      where: { id: messageId },
      data: {
        ciphertext,
        nonce,
        signature,
        envelopeVersion: envelope.v,
        editedAt: new Date(),
        keys: { createMany: { data: keyRows } },
      },
      include: messageInclude,
    });
  });

  for (const key of updated.keys) {
    const owner = await prisma.device.findUnique({
      where: { id: key.deviceId },
      select: { userId: true },
    });
    if (!owner) continue;
    await publishToUsers(
      [owner.userId],
      { t: 'message:updated', message: buildMessageRecord(updated, key.deviceId) },
      { deviceId: key.deviceId },
    );
  }

  return updated;
}

/* ──────────────────────────────── delete ────────────────────────────────── */

/**
 * Delete a message.
 *
 * The ciphertext, nonce, signature, wrapped keys and attachment rows are all
 * removed — the row survives only as a tombstone so clients can render "this
 * message was deleted" in the right place. A group admin may delete anyone's
 * message; everyone else may delete only their own.
 */
export async function deleteMessage(
  messageId: string,
  actorId: string,
): Promise<{ chatId: string; deletedAt: Date; storageKeys: string[] }> {
  const access = await requireMessageAccess(messageId, actorId);

  const isAuthor = access.senderId === actorId;
  const isGroupAdmin =
    access.membership.chatType === 'group' &&
    (access.membership.role === 'admin' || access.membership.role === 'owner');

  if (!isAuthor && !isGroupAdmin) {
    throw forbidden('You can only delete your own messages');
  }

  const attachments = await prisma.attachment.findMany({
    where: { messageId },
    select: { storageKey: true },
  });

  const deletedAt = new Date();
  await prisma.$transaction(async (tx) => {
    await tx.messageKey.deleteMany({ where: { messageId } });
    await tx.attachment.deleteMany({ where: { messageId } });
    await tx.pinnedMessage.deleteMany({ where: { messageId } });
    await tx.message.update({
      where: { id: messageId },
      data: {
        deletedAt,
        ciphertext: null,
        nonce: null,
        signature: null,
      },
    });
  });

  await publishToChat(access.chatId, {
    t: 'message:deleted',
    chatId: access.chatId,
    messageId,
    deletedAt: deletedAt.toISOString(),
  });

  return {
    chatId: access.chatId,
    deletedAt,
    storageKeys: attachments.map((a) => a.storageKey),
  };
}

/* ─────────────────────────────── reactions ──────────────────────────────── */

export async function toggleReaction(
  messageId: string,
  userId: string,
  emoji: string,
): Promise<{ chatId: string; reactions: { emoji: string; userIds: string[] }[] }> {
  const problem = validateReaction(emoji);
  if (problem) throw badRequest(problem.message, { emoji: problem.message });

  const access = await requireMessageAccess(messageId, userId);

  const existing = await prisma.messageReaction.findUnique({
    where: { messageId_userId_emoji: { messageId, userId, emoji } },
    select: { id: true },
  });

  if (existing) {
    await prisma.messageReaction.delete({ where: { id: existing.id } });
  } else {
    const mine = await prisma.messageReaction.count({ where: { messageId, userId } });
    if (mine >= 6) throw conflict('That is enough reactions on one message');
    await prisma.messageReaction
      .create({ data: { messageId, userId, emoji } })
      .catch((err) => {
        if (!isUniqueViolation(err)) throw err;
      });
  }

  const rows = await prisma.messageReaction.findMany({
    where: { messageId },
    select: { emoji: true, userId: true },
  });
  const grouped = new Map<string, string[]>();
  for (const row of rows) {
    const list = grouped.get(row.emoji) ?? [];
    list.push(row.userId);
    grouped.set(row.emoji, list);
  }
  const reactions = [...grouped.entries()].map(([e, userIds]) => ({
    emoji: e,
    userIds,
  }));

  await publishToChat(access.chatId, {
    t: 'message:reaction',
    chatId: access.chatId,
    messageId,
    reactions,
  });

  return { chatId: access.chatId, reactions };
}

/* ────────────────────────── delivery & read state ───────────────────────── */

export async function markDelivered(
  chatId: string,
  userId: string,
  deviceId: string | null,
  messageIds: string[],
): Promise<void> {
  if (messageIds.length === 0) return;
  const membership = await requireMembership(chatId, userId);

  const messages = await prisma.message.findMany({
    where: {
      id: { in: messageIds.slice(0, 200) },
      chatId,
      seq: { gte: membership.joinedAtSeq },
      senderId: { not: userId },
      deletedAt: null,
    },
    select: { id: true },
  });
  if (messages.length === 0) return;

  await prisma.messageDelivery.createMany({
    data: messages.map((m) => ({
      messageId: m.id,
      userId,
      deviceId,
    })),
    skipDuplicates: true,
  });

  await publishToChat(chatId, {
    t: 'message:delivered',
    chatId,
    messageIds: messages.map((m) => m.id),
    userId,
    at: new Date().toISOString(),
  });
}

export async function markRead(
  chatId: string,
  userId: string,
  messageIds: string[],
): Promise<void> {
  if (messageIds.length === 0) return;
  const membership = await requireMembership(chatId, userId);

  const messages = await prisma.message.findMany({
    where: {
      id: { in: messageIds.slice(0, 500) },
      chatId,
      seq: { gte: membership.joinedAtSeq },
      deletedAt: null,
    },
    select: { id: true, seq: true, senderId: true },
  });
  if (messages.length === 0) return;

  const highestSeq = messages.reduce((max, m) => (m.seq > max ? m.seq : max), 0n);
  const fromOthers = messages.filter((m) => m.senderId !== userId);

  await prisma.$transaction(async (tx) => {
    if (fromOthers.length > 0) {
      await tx.messageRead.createMany({
        data: fromOthers.map((m) => ({ messageId: m.id, userId })),
        skipDuplicates: true,
      });
    }
    await tx.chatMember.updateMany({
      where: { chatId, userId, lastReadSeq: { lt: highestSeq } },
      data: { lastReadSeq: highestSeq, lastReadAt: new Date() },
    });
    await tx.notification.updateMany({
      where: { userId, chatId, readAt: null },
      data: { readAt: new Date() },
    });
  });

  // Honour the reader's own privacy setting: with read receipts off, others
  // are not told. The reader's own unread badge still clears.
  const settings = await prisma.userSettings.findUnique({
    where: { userId },
    select: { readReceipts: true },
  });
  if (settings?.readReceipts === false || fromOthers.length === 0) return;

  await publishToChat(chatId, {
    t: 'message:read',
    chatId,
    messageIds: fromOthers.map((m) => m.id),
    userId,
    at: new Date().toISOString(),
  });
}

/**
 * Mark everything a device missed while offline as delivered, and tell the
 * senders. Called right after a socket authenticates.
 */
export async function flushPendingDeliveries(
  userId: string,
  deviceId: string | null,
): Promise<void> {
  const pending = await prisma.message.findMany({
    where: {
      deletedAt: null,
      senderId: { not: userId },
      chat: { members: { some: { userId } } },
      deliveries: { none: { userId } },
    },
    select: { id: true, chatId: true },
    orderBy: { seq: 'desc' },
    take: 500,
  });
  if (pending.length === 0) return;

  await prisma.messageDelivery.createMany({
    data: pending.map((m) => ({ messageId: m.id, userId, deviceId })),
    skipDuplicates: true,
  });

  const byChat = new Map<string, string[]>();
  for (const message of pending) {
    const list = byChat.get(message.chatId) ?? [];
    list.push(message.id);
    byChat.set(message.chatId, list);
  }

  const at = new Date().toISOString();
  for (const [chatId, messageIds] of byChat) {
    await publishToChat(chatId, {
      t: 'message:delivered',
      chatId,
      messageIds,
      userId,
      at,
    }).catch((err) => logger.debug({ err }, 'delivery broadcast failed'));
  }
}

export function toRecord(
  message: MessageWithRelations,
  viewerDeviceId: string | null,
): MessageRecord {
  return buildMessageRecord(message, viewerDeviceId);
}
