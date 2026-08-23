/** Wire-format version. Bump on any breaking change to the envelope layout. */
export const PROTOCOL_VERSION = 1;

/** Domain-separation strings. Never reuse one context for two purposes. */
export const SIG_CONTEXT_PREKEY = 'wolffmsg:prekey:v1:';
export const SIG_CONTEXT_MESSAGE = 'wolffmsg:message:v1:';
export const HASH_CONTEXT_SAFETY = 'wolffmsg:safety-number:v1';

/** How many one-time prekeys a device publishes per batch. */
export const ONE_TIME_PREKEY_BATCH = 100;
/** Below this many remaining, the client uploads a fresh batch. */
export const ONE_TIME_PREKEY_LOW_WATER = 25;
/** Signed prekeys older than this are rotated on next launch. */
export const SIGNED_PREKEY_MAX_AGE_DAYS = 30;

/** Attachment chunking. 64 KiB plaintext per secretstream frame. */
export const ATTACHMENT_CHUNK_SIZE = 64 * 1024;

/** Field limits enforced identically on client and server. */
export const LIMITS = {
  usernameMin: 3,
  usernameMax: 24,
  passwordMin: 10,
  passwordMax: 256,
  displayNameMax: 48,
  bioMax: 280,
  chatTitleMax: 64,
  chatDescriptionMax: 512,
  messageBodyMax: 8_000,
  reactionMax: 16,
  groupMembersMax: 512,
  pinnedPerChatMax: 32,
  searchQueryMax: 128,
} as const;

/** `^[a-z0-9_]{3,24}$` — lowercase only, so usernames cannot be confused. */
export const USERNAME_PATTERN = /^[a-z0-9_]{3,24}$/;

export const MESSAGE_STATUS = ['sending', 'sent', 'delivered', 'read'] as const;
export type MessageStatus = (typeof MESSAGE_STATUS)[number];

export const CHAT_ROLES = ['owner', 'admin', 'member'] as const;
export type ChatRole = (typeof CHAT_ROLES)[number];

export const CHAT_TYPES = ['direct', 'group'] as const;
export type ChatType = (typeof CHAT_TYPES)[number];

export const PRIVACY_AUDIENCES = ['everyone', 'contacts', 'nobody'] as const;
export type PrivacyAudience = (typeof PRIVACY_AUDIENCES)[number];

export const CALL_KINDS = ['audio', 'video'] as const;
export type CallKind = (typeof CALL_KINDS)[number];

export const CALL_STATES = [
  'ringing',
  'accepted',
  'declined',
  'missed',
  'ended',
  'failed',
] as const;
export type CallState = (typeof CALL_STATES)[number];

/**
 * Attachment MIME types the server will store. Anything not on this list is
 * rejected — the server cannot inspect the (encrypted) bytes, so the declared
 * type is treated purely as a routing hint and is never used to build a
 * filesystem path or reflected as a `Content-Type` that a browser will run.
 */
export const ALLOWED_ATTACHMENT_MIME = new Set([
  'image/jpeg',
  'image/png',
  'image/gif',
  'image/webp',
  'image/avif',
  'video/mp4',
  'video/webm',
  'video/quicktime',
  'audio/webm',
  'audio/ogg',
  'audio/mpeg',
  'audio/mp4',
  'audio/wav',
  'application/pdf',
  'text/plain',
  'application/zip',
  'application/json',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'application/octet-stream',
]);

/** Avatars are stored unencrypted (they are shown to anyone allowed to see them). */
export const ALLOWED_AVATAR_MIME = new Set([
  'image/jpeg',
  'image/png',
  'image/webp',
]);
