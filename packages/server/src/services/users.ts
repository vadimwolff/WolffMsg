import type {
  AppearanceSettings,
  NotificationSettings,
  PrivacySettings,
  PrivacyAudience,
  PublicUser,
  SelfUser,
} from '@wolffmsg/shared';
import { prisma } from '../db.js';
import { audienceAllows, isBlockedEitherWay } from './access.js';
import { isOnline } from '../realtime/presence.js';

/** Columns needed to build a `PublicUser`, in one place. */
export const publicUserSelect = {
  id: true,
  username: true,
  displayName: true,
  bio: true,
  avatarKey: true,
  lastSeenAt: true,
  settings: {
    select: {
      lastSeenVisibility: true,
      avatarVisibility: true,
      bioVisibility: true,
    },
  },
} as const;

export type UserRow = {
  id: string;
  username: string;
  displayName: string;
  bio: string | null;
  avatarKey: string | null;
  lastSeenAt: Date;
  settings: {
    lastSeenVisibility: string;
    avatarVisibility: string;
    bioVisibility: string;
  } | null;
};

/**
 * Project a user row for a specific viewer, applying that user's privacy
 * settings and the block list.
 *
 * This is the only function that should ever build a `PublicUser` — routes
 * must not hand-roll a projection, or a field will eventually leak.
 */
export async function projectUser(
  row: UserRow,
  viewerId: string,
): Promise<PublicUser> {
  const self = row.id === viewerId;
  const blocked = self ? false : await isBlockedEitherWay(viewerId, row.id);

  const lastSeenAudience = (row.settings?.lastSeenVisibility ??
    'everyone') as PrivacyAudience;
  const avatarAudience = (row.settings?.avatarVisibility ??
    'everyone') as PrivacyAudience;
  const bioAudience = (row.settings?.bioVisibility ?? 'everyone') as PrivacyAudience;

  const canSeePresence =
    !blocked && (await audienceAllows(lastSeenAudience, row.id, viewerId));
  const canSeeAvatar =
    !blocked && (await audienceAllows(avatarAudience, row.id, viewerId));
  const canSeeBio = !blocked && (await audienceAllows(bioAudience, row.id, viewerId));

  const online = canSeePresence ? await isOnline(row.id) : null;

  return {
    id: row.id,
    username: row.username,
    displayName: row.displayName,
    avatarUrl: canSeeAvatar && row.avatarKey ? `/api/avatars/${row.avatarKey}` : null,
    bio: canSeeBio ? row.bio : null,
    online,
    lastSeenAt: canSeePresence && !online ? row.lastSeenAt.toISOString() : null,
  };
}

/** Batch variant — avoids an N+1 of presence and privacy lookups per row. */
export async function projectUsers(
  rows: UserRow[],
  viewerId: string,
): Promise<PublicUser[]> {
  return Promise.all(rows.map((row) => projectUser(row, viewerId)));
}

export async function loadPublicUser(
  userId: string,
  viewerId: string,
): Promise<PublicUser | null> {
  const row = await prisma.user.findFirst({
    where: { id: userId, disabledAt: null },
    select: publicUserSelect,
  });
  return row ? projectUser(row, viewerId) : null;
}

export function defaultPrivacy(): PrivacySettings {
  return {
    lastSeenVisibility: 'everyone',
    avatarVisibility: 'everyone',
    bioVisibility: 'everyone',
    whoCanMessage: 'everyone',
    whoCanAddToGroups: 'everyone',
    readReceipts: true,
    typingIndicators: true,
  };
}

export async function loadSelf(userId: string): Promise<SelfUser | null> {
  const row = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      ...publicUserSelect,
      createdAt: true,
      settings: true,
    },
  });
  if (!row) return null;

  const s = row.settings;
  const privacy: PrivacySettings = s
    ? {
        lastSeenVisibility: s.lastSeenVisibility as PrivacyAudience,
        avatarVisibility: s.avatarVisibility as PrivacyAudience,
        bioVisibility: s.bioVisibility as PrivacyAudience,
        whoCanMessage: s.whoCanMessage as PrivacyAudience,
        whoCanAddToGroups: s.whoCanAddToGroups as PrivacyAudience,
        readReceipts: s.readReceipts,
        typingIndicators: s.typingIndicators,
      }
    : defaultPrivacy();

  const notifications: NotificationSettings = {
    enabled: s?.notificationsEnabled ?? true,
    showPreview: s?.notificationPreview ?? false,
    sound: s?.notificationSound ?? true,
    mutedUntil: s?.mutedUntil?.toISOString() ?? null,
  };

  const appearance: AppearanceSettings = {
    theme: (s?.theme ?? 'dark') as 'dark' | 'light' | 'system',
    accent: s?.accent ?? 'aurora',
    messageDensity: (s?.messageDensity ?? 'comfortable') as
      | 'comfortable'
      | 'compact',
    reducedMotion: s?.reducedMotion ?? false,
    fontScale: s?.fontScale ?? 1,
  };

  return {
    id: row.id,
    username: row.username,
    displayName: row.displayName,
    avatarUrl: row.avatarKey ? `/api/avatars/${row.avatarKey}` : null,
    bio: row.bio,
    online: true,
    lastSeenAt: row.lastSeenAt.toISOString(),
    createdAt: row.createdAt.toISOString(),
    privacy,
    notifications,
    appearance,
  };
}

/**
 * Username search.
 *
 * Deliberately prefix-only and capped: a substring search over every username
 * would turn the directory into a scrapeable user list. Blocked users and
 * disabled accounts are filtered out.
 */
export async function searchUsers(
  query: string,
  viewerId: string,
  limit = 20,
): Promise<PublicUser[]> {
  const normalized = query.trim().toLowerCase();
  if (normalized.length < 2) return [];

  const blocks = await prisma.blockedUser.findMany({
    where: { OR: [{ blockerId: viewerId }, { blockedId: viewerId }] },
    select: { blockerId: true, blockedId: true },
  });
  const excluded = new Set<string>();
  for (const b of blocks) {
    excluded.add(b.blockerId === viewerId ? b.blockedId : b.blockerId);
  }

  const rows = await prisma.user.findMany({
    where: {
      disabledAt: null,
      id: { notIn: [...excluded] },
      OR: [
        { username: { startsWith: normalized } },
        { displayName: { startsWith: query.trim(), mode: 'insensitive' } },
      ],
    },
    select: publicUserSelect,
    orderBy: { username: 'asc' },
    take: Math.min(limit, 25),
  });

  return projectUsers(rows, viewerId);
}
