/** Domain objects as they cross the REST/WebSocket boundary. */
import type {
  CallKind,
  CallState,
  ChatRole,
  ChatType,
  PrivacyAudience,
} from './constants.js';
import type { EncryptedEnvelope } from './crypto/envelope.js';

export interface PublicUser {
  id: string;
  username: string;
  displayName: string;
  avatarUrl: string | null;
  bio: string | null;
  /** `null` when the viewer is not permitted to see presence. */
  online: boolean | null;
  lastSeenAt: string | null;
  /** True once the viewer has verified this user's safety number. */
  verified?: boolean;
}

export interface SelfUser extends PublicUser {
  createdAt: string;
  privacy: PrivacySettings;
  notifications: NotificationSettings;
  appearance: AppearanceSettings;
}

export interface PrivacySettings {
  lastSeenVisibility: PrivacyAudience;
  avatarVisibility: PrivacyAudience;
  bioVisibility: PrivacyAudience;
  whoCanMessage: PrivacyAudience;
  whoCanAddToGroups: PrivacyAudience;
  readReceipts: boolean;
  typingIndicators: boolean;
}

export interface NotificationSettings {
  enabled: boolean;
  showPreview: boolean;
  sound: boolean;
  mutedUntil: string | null;
}

export interface AppearanceSettings {
  theme: 'dark' | 'light' | 'system';
  accent: string;
  messageDensity: 'comfortable' | 'compact';
  reducedMotion: boolean;
  fontScale: number;
}

export interface DeviceSummary {
  id: string;
  name: string;
  platform: string;
  identityPublicKey: string;
  createdAt: string;
  lastActiveAt: string;
  /** Coarse location hint derived from IP; never the raw address. */
  lastIpHint: string | null;
  current: boolean;
  oneTimePreKeysRemaining: number;
}

export interface SessionSummary {
  id: string;
  deviceName: string;
  platform: string;
  createdAt: string;
  lastActiveAt: string;
  expiresAt: string;
  ipHint: string | null;
  current: boolean;
}

export interface ChatMemberSummary {
  userId: string;
  role: ChatRole;
  joinedAt: string;
  user: PublicUser;
}

export interface ChatSummary {
  id: string;
  type: ChatType;
  title: string | null;
  description: string | null;
  avatarUrl: string | null;
  createdAt: string;
  updatedAt: string;
  /** Present for direct chats: the other participant. */
  peer: PublicUser | null;
  members: ChatMemberSummary[];
  myRole: ChatRole;
  pinned: boolean;
  muted: boolean;
  mutedUntil: string | null;
  archived: boolean;
  unreadCount: number;
  lastMessage: MessageRecord | null;
  lastReadMessageId: string | null;
  /** Group setting: when true only admins and the owner may post. */
  readOnlyForMembers: boolean;
  pinnedMessageIds: string[];
}

export interface MessageReactionRecord {
  emoji: string;
  userIds: string[];
}

export interface AttachmentRecord {
  id: string;
  /** Encrypted byte length as stored. */
  encryptedSize: number;
  mimeType: string;
  createdAt: string;
}

export interface MessageRecord {
  id: string;
  chatId: string;
  senderId: string;
  senderDeviceId: string;
  createdAt: string;
  editedAt: string | null;
  deletedAt: string | null;
  /**
   * The end-to-end encrypted payload. `null` for tombstoned (deleted)
   * messages and for system events, which carry `system` instead.
   */
  envelope: EncryptedEnvelope | null;
  /** Non-encrypted system events (member joined, title changed, call ended…). */
  system: SystemEvent | null;
  reactions: MessageReactionRecord[];
  attachments: AttachmentRecord[];
  /** Ids of members who have received / read the message. */
  deliveredTo: string[];
  readBy: string[];
  pinned: boolean;
  /** Sender-supplied idempotency key; lets clients de-duplicate retries. */
  clientId: string | null;
  replyToId: string | null;
}

export type SystemEvent =
  | { kind: 'chat.created'; actorId: string }
  | { kind: 'member.added'; actorId: string; targetIds: string[] }
  | { kind: 'member.removed'; actorId: string; targetIds: string[] }
  | { kind: 'member.left'; actorId: string }
  | { kind: 'role.changed'; actorId: string; targetId: string; role: ChatRole }
  | { kind: 'ownership.transferred'; actorId: string; targetId: string }
  | { kind: 'chat.renamed'; actorId: string; title: string }
  | { kind: 'chat.description'; actorId: string; description: string | null }
  | { kind: 'chat.avatar'; actorId: string }
  | { kind: 'chat.permissions'; actorId: string; readOnlyForMembers: boolean }
  | {
      kind: 'call.ended';
      actorId: string;
      callKind: CallKind;
      state: CallState;
      durationMs: number;
    };

export interface CallRecord {
  id: string;
  chatId: string;
  initiatorId: string;
  kind: CallKind;
  state: CallState;
  startedAt: string;
  answeredAt: string | null;
  endedAt: string | null;
  participants: { userId: string; joinedAt: string; leftAt: string | null }[];
}

export interface ContactRecord {
  user: PublicUser;
  createdAt: string;
  /** Locally chosen nickname, encrypted at rest is unnecessary — it is yours. */
  alias: string | null;
  verifiedAt: string | null;
  /** Set when the peer's identity key changed after you verified it. */
  identityChangedAt: string | null;
}

export interface SecurityEventRecord {
  id: string;
  kind:
    | 'session.created'
    | 'session.revoked'
    | 'device.registered'
    | 'device.removed'
    | 'password.changed'
    | 'identity.changed'
    | 'login.failed'
    | 'prekeys.replenished';
  createdAt: string;
  detail: string;
  ipHint: string | null;
}

export interface Paginated<T> {
  items: T[];
  /** Opaque cursor for the next page; `null` when the end is reached. */
  nextCursor: string | null;
}

export interface ApiErrorBody {
  error: {
    code: string;
    message: string;
    /** Field-level validation problems, keyed by dotted path. */
    fields?: Record<string, string>;
  };
}

export interface IceServerConfig {
  urls: string[];
  username?: string;
  credential?: string;
}
