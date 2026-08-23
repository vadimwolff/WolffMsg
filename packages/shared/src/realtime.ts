/** WebSocket wire protocol — every frame is a JSON object with a `t` tag. */
import type { CallKind, CallState } from './constants.js';
import type {
  CallRecord,
  ChatSummary,
  MessageRecord,
  MessageReactionRecord,
  PublicUser,
} from './types.js';

/* ───────────────────────────── server → client ──────────────────────────── */

export type ServerEvent =
  | { t: 'ready'; userId: string; deviceId: string; serverTime: number }
  | { t: 'pong'; ts: number }
  | { t: 'error'; code: string; message: string; ref?: string }
  | { t: 'message:new'; message: MessageRecord }
  | { t: 'message:updated'; message: MessageRecord }
  | { t: 'message:deleted'; chatId: string; messageId: string; deletedAt: string }
  | {
      t: 'message:reaction';
      chatId: string;
      messageId: string;
      reactions: MessageReactionRecord[];
    }
  | {
      t: 'message:delivered';
      chatId: string;
      messageIds: string[];
      userId: string;
      at: string;
    }
  | {
      t: 'message:read';
      chatId: string;
      messageIds: string[];
      userId: string;
      at: string;
    }
  | { t: 'typing:start'; chatId: string; userId: string }
  | { t: 'typing:stop'; chatId: string; userId: string }
  | {
      t: 'presence:update';
      userId: string;
      online: boolean;
      lastSeenAt: string | null;
    }
  | { t: 'chat:update'; chat: ChatSummary }
  | { t: 'chat:removed'; chatId: string }
  | { t: 'chat:pinned'; chatId: string; messageIds: string[] }
  | { t: 'contact:update'; contactUserId: string }
  | {
      t: 'identity:changed';
      userId: string;
      deviceId: string;
      identityPublicKey: string;
    }
  | { t: 'prekeys:low'; remaining: number }
  | { t: 'session:revoked'; reason: string }
  | { t: 'call:incoming'; call: CallRecord; from: PublicUser }
  | { t: 'call:accepted'; callId: string; userId: string }
  | { t: 'call:declined'; callId: string; userId: string }
  | { t: 'call:ended'; callId: string; state: CallState; durationMs: number }
  | {
      t: 'call:signal';
      callId: string;
      fromUserId: string;
      fromDeviceId: string;
      signal: CallSignal;
    };

/** Opaque WebRTC signalling payloads. The server relays without inspecting. */
export type CallSignal =
  | { kind: 'offer'; sdp: string }
  | { kind: 'answer'; sdp: string }
  | {
      kind: 'ice';
      candidate: string;
      sdpMid: string | null;
      sdpMLineIndex: number | null;
    }
  | { kind: 'renegotiate' };

/* ───────────────────────────── client → server ──────────────────────────── */

export type ClientCommand =
  | { t: 'ping'; ts: number }
  | { t: 'typing:start'; chatId: string }
  | { t: 'typing:stop'; chatId: string }
  | { t: 'message:delivered'; chatId: string; messageIds: string[] }
  | { t: 'message:read'; chatId: string; messageIds: string[] }
  | { t: 'presence:subscribe'; userIds: string[] }
  | { t: 'presence:unsubscribe'; userIds: string[] }
  | { t: 'call:start'; chatId: string; kind: CallKind; clientId: string }
  | { t: 'call:accept'; callId: string }
  | { t: 'call:decline'; callId: string }
  | { t: 'call:hangup'; callId: string }
  | {
      t: 'call:signal';
      callId: string;
      toUserId: string;
      toDeviceId: string | null;
      signal: CallSignal;
    };

/** Heartbeat cadence. The server closes sockets that go quiet for 2 misses. */
export const WS_PING_INTERVAL_MS = 25_000;
export const WS_IDLE_TIMEOUT_MS = 60_000;

/** Typing events are throttled to at most one per this window. */
export const TYPING_THROTTLE_MS = 3_000;
/** A typing indicator auto-expires after this long without a refresh. */
export const TYPING_TTL_MS = 6_000;
