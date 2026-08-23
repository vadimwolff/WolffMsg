import { prisma } from '../db.js';
import { logger } from '../logger.js';
import type { MessageWithRelations } from './messageProjection.js';
import { sendPushToUser } from './push.js';
import { localConnectionsFor } from '../realtime/hub.js';

/**
 * Notifications.
 *
 * The server cannot read a message, so a notification never claims to. What
 * it records — and what it pushes — is "someone sent you something in this
 * conversation". The client decrypts locally and rewrites the notification
 * body with real content if the user allows previews.
 */

export async function queueMessageNotifications(
  message: MessageWithRelations,
): Promise<void> {
  try {
    const members = await prisma.chatMember.findMany({
      where: {
        chatId: message.chatId,
        userId: { not: message.senderId },
        joinedAtSeq: { lte: message.seq },
      },
      select: {
        userId: true,
        muted: true,
        mutedUntil: true,
        chat: { select: { type: true, title: true } },
      },
    });
    if (members.length === 0) return;

    const sender = await prisma.user.findUnique({
      where: { id: message.senderId },
      select: { displayName: true },
    });

    const now = Date.now();
    const targets = members.filter((m) => {
      if (m.mutedUntil && m.mutedUntil.getTime() > now) return false;
      return !m.muted;
    });
    if (targets.length === 0) return;

    // The summary deliberately carries no message content.
    const summary =
      members[0]?.chat.type === 'group'
        ? `New message in ${members[0]?.chat.title ?? 'a group'}`
        : 'New message';

    await prisma.notification.createMany({
      data: targets.map((m) => ({
        userId: m.userId,
        chatId: message.chatId,
        messageId: message.id,
        kind: 'message',
        summary,
      })),
    });

    // Only push to people who are not already watching on a live socket.
    await Promise.all(
      targets.map(async (m) => {
        if (localConnectionsFor(m.userId).length > 0) return;
        await sendPushToUser(m.userId, {
          title: sender?.displayName ?? 'WolffMsg',
          body: summary,
          chatId: message.chatId,
          messageId: message.id,
        });
      }),
    );
  } catch (err) {
    // A notification failure must never fail the send it accompanies.
    logger.error({ err, messageId: message.id }, 'failed to queue notifications');
  }
}

export async function unreadNotificationCount(userId: string): Promise<number> {
  return prisma.notification.count({ where: { userId, readAt: null } });
}

export async function markNotificationsRead(
  userId: string,
  chatId?: string,
): Promise<void> {
  await prisma.notification.updateMany({
    where: { userId, readAt: null, ...(chatId ? { chatId } : {}) },
    data: { readAt: new Date() },
  });
}

export async function recordCallNotification(params: {
  userId: string;
  chatId: string;
  callerName: string;
}): Promise<void> {
  await prisma.notification.create({
    data: {
      userId: params.userId,
      chatId: params.chatId,
      kind: 'call',
      summary: 'Incoming call',
    },
  });
  await sendPushToUser(params.userId, {
    title: params.callerName,
    body: 'Incoming call',
    chatId: params.chatId,
    messageId: null,
    urgent: true,
  });
}
