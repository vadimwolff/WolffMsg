import type {
  EncryptedEnvelope,
  MessageRecord,
  MessageReactionRecord,
  SystemEvent,
} from '@wolffmsg/shared';
import type { Prisma } from '@prisma/client';

/**
 * The single place a stored message becomes a wire record.
 *
 * Two rules this function exists to enforce:
 *  1. A client is only ever handed the wrapped content key addressed to *its
 *     own device*. Other devices' wrapped keys are not its business, and
 *     shipping them all would multiply payload size by the fan-out.
 *  2. A deleted message returns a tombstone with no ciphertext at all — the
 *     bytes are already gone from the row, and this keeps it that way even if
 *     a future migration reintroduces them.
 */

export const messageInclude = {
  keys: { select: { deviceId: true, preKeyId: true, wrapped: true } },
  reactions: { select: { emoji: true, userId: true } },
  reads: { select: { userId: true } },
  deliveries: { select: { userId: true } },
  attachments: {
    select: { id: true, mimeType: true, encryptedSize: true, createdAt: true },
  },
  pins: { select: { id: true } },
} satisfies Prisma.MessageInclude;

export type MessageWithRelations = Prisma.MessageGetPayload<{
  include: typeof messageInclude;
}>;

export function buildMessageRecord(
  message: MessageWithRelations,
  viewerDeviceId: string | null,
): MessageRecord {
  const deleted = message.deletedAt !== null;

  let envelope: EncryptedEnvelope | null = null;
  if (!deleted && message.ciphertext && message.nonce && message.signature) {
    const keys = message.keys
      .filter((k) => viewerDeviceId !== null && k.deviceId === viewerDeviceId)
      .map((k) => ({
        deviceId: k.deviceId,
        preKeyId: k.preKeyId,
        wrapped: Buffer.from(k.wrapped).toString('base64'),
      }));

    envelope = {
      v: message.envelopeVersion,
      alg: 'xchacha20poly1305-ietf',
      ciphertext: Buffer.from(message.ciphertext).toString('base64'),
      nonce: Buffer.from(message.nonce).toString('base64'),
      signature: Buffer.from(message.signature).toString('base64'),
      keys,
    };
  }

  const reactionMap = new Map<string, string[]>();
  for (const reaction of message.reactions) {
    const list = reactionMap.get(reaction.emoji) ?? [];
    list.push(reaction.userId);
    reactionMap.set(reaction.emoji, list);
  }
  const reactions: MessageReactionRecord[] = [...reactionMap.entries()].map(
    ([emoji, userIds]) => ({ emoji, userIds }),
  );

  return {
    id: message.id,
    chatId: message.chatId,
    senderId: message.senderId,
    senderDeviceId: message.senderDeviceId ?? '',
    createdAt: message.createdAt.toISOString(),
    editedAt: message.editedAt?.toISOString() ?? null,
    deletedAt: message.deletedAt?.toISOString() ?? null,
    envelope,
    system: (message.systemEvent as SystemEvent | null) ?? null,
    reactions,
    attachments: deleted
      ? []
      : message.attachments.map((a) => ({
          id: a.id,
          mimeType: a.mimeType,
          encryptedSize: a.encryptedSize,
          createdAt: a.createdAt.toISOString(),
        })),
    deliveredTo: message.deliveries.map((d) => d.userId),
    readBy: message.reads.map((r) => r.userId),
    pinned: message.pins.length > 0,
    clientId: message.clientId,
    replyToId: message.replyToId,
  };
}

/**
 * Build the record as each recipient device will see it.
 *
 * Realtime fan-out needs a per-device view, because each device gets a
 * different wrapped key. Returns a map from device id to record.
 */
export function buildPerDeviceRecords(
  message: MessageWithRelations,
): Map<string, MessageRecord> {
  const out = new Map<string, MessageRecord>();
  for (const key of message.keys) {
    out.set(key.deviceId, buildMessageRecord(message, key.deviceId));
  }
  return out;
}
