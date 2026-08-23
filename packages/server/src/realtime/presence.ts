import { counters } from '../redis.js';
import { prisma } from '../db.js';

/**
 * Presence is derived from live socket connections, not from client-reported
 * status, and it is stored with a TTL so a crashed node cannot leave a user
 * "online" forever.
 *
 * Each connected device adds itself to a per-user sorted set keyed by expiry.
 * A user is online while at least one non-expired device entry remains.
 */

const PRESENCE_TTL_SECONDS = 45;
const key = (userId: string) => `presence:${userId}`;

export async function markOnline(
  userId: string,
  connectionId: string,
): Promise<void> {
  await counters.sAdd(key(userId), connectionId, PRESENCE_TTL_SECONDS);
}

/** Refresh the TTL. Called from the socket heartbeat, not from user activity. */
export async function refreshPresence(
  userId: string,
  connectionId: string,
): Promise<void> {
  await counters.sAdd(key(userId), connectionId, PRESENCE_TTL_SECONDS);
}

/**
 * Drop one connection. Returns true when that was the user's last one, so the
 * caller knows whether to broadcast an "offline" transition.
 */
export async function markOffline(
  userId: string,
  connectionId: string,
): Promise<boolean> {
  await counters.sRem(key(userId), connectionId);
  const remaining = await counters.sMembers(key(userId));
  if (remaining.length === 0) {
    await prisma.user
      .update({ where: { id: userId }, data: { lastSeenAt: new Date() } })
      .catch(() => undefined);
    return true;
  }
  return false;
}

export async function isOnline(userId: string): Promise<boolean> {
  const members = await counters.sMembers(key(userId));
  return members.length > 0;
}

export async function onlineStatusFor(
  userIds: string[],
): Promise<Map<string, boolean>> {
  const entries = await Promise.all(
    userIds.map(async (id) => [id, await isOnline(id)] as const),
  );
  return new Map(entries);
}

/* ─────────────────────────────── typing ─────────────────────────────────── */

const TYPING_TTL_SECONDS = 7;
const typingKey = (chatId: string) => `typing:${chatId}`;

export async function setTyping(chatId: string, userId: string): Promise<void> {
  await counters.sAdd(typingKey(chatId), userId, TYPING_TTL_SECONDS);
}

export async function clearTyping(chatId: string, userId: string): Promise<void> {
  await counters.sRem(typingKey(chatId), userId);
}

export async function typingIn(chatId: string): Promise<string[]> {
  return counters.sMembers(typingKey(chatId));
}
