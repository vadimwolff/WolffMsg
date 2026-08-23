import crypto from 'node:crypto';
import type { IncomingMessage, Server } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocketServer, type WebSocket } from 'ws';
import {
  WS_IDLE_TIMEOUT_MS,
  WS_PING_INTERVAL_MS,
  type ClientCommand,
  type ServerEvent,
} from '@wolffmsg/shared';
import { logger } from '../logger.js';
import { prisma } from '../db.js';
import { AppError } from '../errors.js';
import { isAllowedWebSocketOrigin } from '../security/csrf.js';
import { RATE_LIMITS, isOverLimit } from '../security/rateLimit.js';
import { resolveSession, sessionCookieName } from '../auth/session.js';
import {
  addConnection,
  localConnectionsFor,
  publishToChat,
  publishToUsers,
  removeConnection,
  sendTo,
  type Connection,
} from './hub.js';
import {
  clearTyping,
  markOffline,
  markOnline,
  refreshPresence,
  setTyping,
} from './presence.js';
import { flushPendingDeliveries, markDelivered, markRead } from '../services/messages.js';
import {
  acceptCall,
  assertSignalShape,
  declineCall,
  hangUp,
  requireCallAccess,
  startCall,
} from '../services/calls.js';
import { requireMembership } from '../services/access.js';
import { isLowOnPreKeys, preKeysRemaining, touchDevice } from '../services/devices.js';
import { ipHintFromAddress } from '../security/ipHint.js';

/**
 * The realtime endpoint.
 *
 * Authentication happens during the HTTP upgrade, using the same session
 * cookie as the REST API — there is no separate socket token to leak. The
 * upgrade is refused outright for an unknown `Origin`, because browsers do
 * not apply the same-origin policy to WebSockets and would otherwise let a
 * hostile page open an authenticated socket.
 *
 * Every inbound frame is re-authorized. A socket authenticated as user A can
 * emit `typing:start` for any chat id it likes; the handler checks membership
 * before acting on it, every time.
 */

const MAX_FRAME_BYTES = 128 * 1024;

let wss: WebSocketServer | null = null;
let heartbeat: NodeJS.Timeout | null = null;

export function attachWebSocketServer(server: Server): void {
  wss = new WebSocketServer({ noServer: true, maxPayload: MAX_FRAME_BYTES });

  server.on('upgrade', (request, socket, head) => {
    void handleUpgrade(request, socket, head);
  });

  heartbeat = setInterval(() => {
    if (!wss) return;
    for (const client of wss.clients) {
      const connection = (client as WebSocket & { wolff?: Connection }).wolff;
      if (!connection) continue;
      if (!connection.isAlive) {
        client.terminate();
        continue;
      }
      connection.isAlive = false;
      try {
        client.ping();
      } catch {
        client.terminate();
      }
      void refreshPresence(connection.userId, connection.id);
    }
  }, WS_PING_INTERVAL_MS);
  heartbeat.unref?.();
}

async function handleUpgrade(
  request: IncomingMessage,
  socket: Duplex,
  head: Buffer,
): Promise<void> {
  const reject = (status: number, message: string) => {
    socket.write(`HTTP/1.1 ${status} ${message}\r\nConnection: close\r\n\r\n`);
    socket.destroy();
  };

  try {
    const url = new URL(request.url ?? '/', 'http://localhost');
    if (url.pathname !== '/ws') return reject(404, 'Not Found');

    if (!isAllowedWebSocketOrigin(request.headers.origin)) {
      logger.warn({ origin: request.headers.origin }, 'rejected websocket origin');
      return reject(403, 'Forbidden');
    }

    const cookies = parseCookies(request.headers.cookie);
    const auth = await resolveSession(cookies[sessionCookieName()]);
    if (!auth) return reject(401, 'Unauthorized');

    if (!wss) return reject(503, 'Service Unavailable');

    wss.handleUpgrade(request, socket, head, (ws) => {
      void onConnected(ws, request, auth);
    });
  } catch (err) {
    logger.error({ err }, 'websocket upgrade failed');
    reject(500, 'Internal Server Error');
  }
}

function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq <= 0) continue;
    const name = part.slice(0, eq).trim();
    const value = part.slice(eq + 1).trim();
    if (name && !(name in out)) {
      try {
        out[name] = decodeURIComponent(value);
      } catch {
        out[name] = value;
      }
    }
  }
  return out;
}

async function onConnected(
  socket: WebSocket,
  request: IncomingMessage,
  auth: { userId: string; sessionId: string; deviceId: string | null },
): Promise<void> {
  const connection: Connection = {
    id: crypto.randomUUID(),
    userId: auth.userId,
    deviceId: auth.deviceId,
    sessionId: auth.sessionId,
    socket,
    presenceWatch: new Set([auth.userId]),
    isAlive: true,
  };
  (socket as WebSocket & { wolff?: Connection }).wolff = connection;

  addConnection(connection);
  await markOnline(connection.userId, connection.id);

  socket.on('pong', () => {
    connection.isAlive = true;
  });

  socket.on('message', (raw, isBinary) => {
    connection.isAlive = true;
    if (isBinary) {
      // The protocol is JSON only; binary frames are never expected.
      socket.close(1003, 'binary frames are not supported');
      return;
    }
    void handleFrame(connection, raw.toString());
  });

  socket.on('close', () => {
    void onDisconnected(connection);
  });
  socket.on('error', (err) => {
    logger.debug({ err, connectionId: connection.id }, 'socket error');
  });

  sendTo(connection, {
    t: 'ready',
    userId: connection.userId,
    deviceId: connection.deviceId ?? '',
    serverTime: Date.now(),
  });

  // Announce presence to everyone who shares a conversation with this user.
  await broadcastPresence(connection.userId, true);

  if (connection.deviceId) {
    await touchDevice(
      connection.deviceId,
      ipHintFromAddress(request.socket.remoteAddress),
    );
    const remaining = await preKeysRemaining(connection.deviceId);
    if (isLowOnPreKeys(remaining)) {
      sendTo(connection, { t: 'prekeys:low', remaining });
    }
  }

  // Catch up on anything that arrived while this device was away.
  await flushPendingDeliveries(connection.userId, connection.deviceId).catch((err) =>
    logger.debug({ err }, 'delivery flush failed'),
  );
}

async function onDisconnected(connection: Connection): Promise<void> {
  removeConnection(connection.id);
  const wentOffline = await markOffline(connection.userId, connection.id);
  if (wentOffline) await broadcastPresence(connection.userId, false);
}

/**
 * Tell everyone who shares a conversation with this user about a presence
 * change — but only if the user's privacy settings permit it.
 */
async function broadcastPresence(userId: string, online: boolean): Promise<void> {
  const settings = await prisma.userSettings.findUnique({
    where: { userId },
    select: { lastSeenVisibility: true },
  });
  if (settings?.lastSeenVisibility === 'nobody') return;

  const memberships = await prisma.chatMember.findMany({
    where: { userId },
    select: { chatId: true },
  });
  if (memberships.length === 0) return;

  const peers = await prisma.chatMember.findMany({
    where: { chatId: { in: memberships.map((m) => m.chatId) }, userId: { not: userId } },
    select: { userId: true },
    distinct: ['userId'],
  });
  if (peers.length === 0) return;

  let audience = peers.map((p) => p.userId);

  if (settings?.lastSeenVisibility === 'contacts') {
    const contacts = await prisma.contact.findMany({
      where: { ownerId: userId, targetId: { in: audience } },
      select: { targetId: true },
    });
    const allowed = new Set(contacts.map((c) => c.targetId));
    audience = audience.filter((id) => allowed.has(id));
  }

  // Never leak presence to someone on either side of a block.
  const blocks = await prisma.blockedUser.findMany({
    where: {
      OR: [
        { blockerId: userId, blockedId: { in: audience } },
        { blockedId: userId, blockerId: { in: audience } },
      ],
    },
    select: { blockerId: true, blockedId: true },
  });
  if (blocks.length > 0) {
    const excluded = new Set(
      blocks.map((b) => (b.blockerId === userId ? b.blockedId : b.blockerId)),
    );
    audience = audience.filter((id) => !excluded.has(id));
  }

  if (audience.length === 0) return;

  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { lastSeenAt: true },
  });

  await publishToUsers(audience, {
    t: 'presence:update',
    userId,
    online,
    lastSeenAt: online ? null : (user?.lastSeenAt.toISOString() ?? null),
  });
}

/* ─────────────────────────────── commands ──────────────────────────────── */

async function handleFrame(connection: Connection, raw: string): Promise<void> {
  if (raw.length > MAX_FRAME_BYTES) {
    connection.socket.close(1009, 'frame too large');
    return;
  }

  // Per-connection flood control. An abusive socket is closed rather than
  // answered, so it cannot keep paying a small cost to generate work.
  if (await isOverLimit(RATE_LIMITS.socketEvents, `ws:${connection.id}`)) {
    sendTo(connection, {
      t: 'error',
      code: 'rate_limited',
      message: 'Too many realtime events',
    });
    connection.socket.close(1008, 'rate limited');
    return;
  }

  let command: ClientCommand;
  try {
    command = JSON.parse(raw) as ClientCommand;
  } catch {
    sendTo(connection, {
      t: 'error',
      code: 'bad_frame',
      message: 'That frame could not be read',
    });
    return;
  }
  if (!command || typeof command !== 'object' || typeof command.t !== 'string') {
    sendTo(connection, { t: 'error', code: 'bad_frame', message: 'Malformed frame' });
    return;
  }

  try {
    await dispatch(connection, command);
  } catch (err) {
    if (err instanceof AppError) {
      sendTo(connection, { t: 'error', code: err.code, message: err.message });
      return;
    }
    const ref = crypto.randomBytes(4).toString('hex');
    logger.error({ err, ref, command: command.t }, 'websocket command failed');
    sendTo(connection, {
      t: 'error',
      code: 'internal_error',
      message: 'Something went wrong',
      ref,
    });
  }
}

async function dispatch(connection: Connection, command: ClientCommand): Promise<void> {
  switch (command.t) {
    case 'ping':
      sendTo(connection, { t: 'pong', ts: Date.now() });
      return;

    case 'typing:start':
    case 'typing:stop': {
      const chatId = requireString(command.chatId, 'chatId');
      // Re-check membership on every event: the socket's identity does not
      // imply access to whatever chat id it names.
      await requireMembership(chatId, connection.userId);

      const settings = await prisma.userSettings.findUnique({
        where: { userId: connection.userId },
        select: { typingIndicators: true },
      });
      if (settings?.typingIndicators === false) return;

      if (command.t === 'typing:start') {
        await setTyping(chatId, connection.userId);
      } else {
        await clearTyping(chatId, connection.userId);
      }
      await publishToChat(
        chatId,
        { t: command.t, chatId, userId: connection.userId },
        { exceptConnectionId: connection.id },
      );
      return;
    }

    case 'message:delivered': {
      const chatId = requireString(command.chatId, 'chatId');
      await markDelivered(
        chatId,
        connection.userId,
        connection.deviceId,
        requireIdList(command.messageIds),
      );
      return;
    }

    case 'message:read': {
      const chatId = requireString(command.chatId, 'chatId');
      await markRead(chatId, connection.userId, requireIdList(command.messageIds));
      return;
    }

    case 'presence:subscribe': {
      const ids = requireIdList(command.userIds).slice(0, 500);
      for (const id of ids) connection.presenceWatch.add(id);
      return;
    }

    case 'presence:unsubscribe': {
      for (const id of requireIdList(command.userIds)) {
        connection.presenceWatch.delete(id);
      }
      return;
    }

    case 'call:start': {
      const chatId = requireString(command.chatId, 'chatId');
      if (command.kind !== 'audio' && command.kind !== 'video') {
        throw new AppError(400, 'bad_request', 'Unknown call type');
      }
      if (await isOverLimit(RATE_LIMITS.startCall, `u:${connection.userId}`)) {
        throw new AppError(429, 'rate_limited', RATE_LIMITS.startCall.message);
      }

      const { call, targetUserIds } = await startCall({
        chatId,
        initiatorId: connection.userId,
        deviceId: connection.deviceId,
        kind: command.kind,
      });

      const from = await prisma.user.findUniqueOrThrow({
        where: { id: connection.userId },
        select: {
          id: true,
          username: true,
          displayName: true,
          avatarKey: true,
          bio: true,
          lastSeenAt: true,
        },
      });

      await publishToUsers(targetUserIds, {
        t: 'call:incoming',
        call,
        from: {
          id: from.id,
          username: from.username,
          displayName: from.displayName,
          avatarUrl: from.avatarKey ? `/api/avatars/${from.avatarKey}` : null,
          bio: null,
          online: true,
          lastSeenAt: null,
        },
      });
      // Echo back so the caller learns the call id.
      sendTo(connection, {
        t: 'call:incoming',
        call,
        from: {
          id: from.id,
          username: from.username,
          displayName: from.displayName,
          avatarUrl: from.avatarKey ? `/api/avatars/${from.avatarKey}` : null,
          bio: null,
          online: true,
          lastSeenAt: null,
        },
      });
      return;
    }

    case 'call:accept': {
      const callId = requireString(command.callId, 'callId');
      const call = await acceptCall(callId, connection.userId, connection.deviceId);
      const audience = await callAudience(call.chatId);
      await publishToUsers(audience, {
        t: 'call:accepted',
        callId,
        userId: connection.userId,
      });
      return;
    }

    case 'call:decline': {
      const callId = requireString(command.callId, 'callId');
      const call = await declineCall(callId, connection.userId);
      const audience = await callAudience(call.chatId);
      await publishToUsers(audience, {
        t: 'call:declined',
        callId,
        userId: connection.userId,
      });
      if (call.state !== 'ringing' && call.state !== 'accepted') {
        await publishToUsers(audience, {
          t: 'call:ended',
          callId,
          state: call.state,
          durationMs: 0,
        });
      }
      return;
    }

    case 'call:hangup': {
      const callId = requireString(command.callId, 'callId');
      const call = await hangUp(callId, connection.userId);
      const audience = await callAudience(call.chatId);
      if (call.state === 'ended' || call.state === 'declined' || call.state === 'missed') {
        const durationMs =
          call.answeredAt && call.endedAt
            ? new Date(call.endedAt).getTime() - new Date(call.answeredAt).getTime()
            : 0;
        await publishToUsers(audience, {
          t: 'call:ended',
          callId,
          state: call.state,
          durationMs,
        });
      }
      return;
    }

    case 'call:signal': {
      const callId = requireString(command.callId, 'callId');
      const toUserId = requireString(command.toUserId, 'toUserId');
      assertSignalShape(command.signal);

      // Both ends must be in the call's chat; a socket cannot use the relay to
      // reach an arbitrary user.
      const call = await requireCallAccess(callId, connection.userId);
      await requireMembership(call.chatId, toUserId);

      await publishToUsers(
        [toUserId],
        {
          t: 'call:signal',
          callId,
          fromUserId: connection.userId,
          fromDeviceId: connection.deviceId ?? '',
          signal: command.signal,
        },
        { deviceId: command.toDeviceId ?? null },
      );
      return;
    }

    default:
      sendTo(connection, {
        t: 'error',
        code: 'unknown_command',
        message: 'Unknown command',
      });
  }
}

async function callAudience(chatId: string): Promise<string[]> {
  const members = await prisma.chatMember.findMany({
    where: { chatId },
    select: { userId: true },
  });
  return members.map((m) => m.userId);
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 64) {
    throw new AppError(400, 'bad_request', `Missing or invalid ${field}`);
  }
  return value;
}

function requireIdList(value: unknown): string[] {
  if (!Array.isArray(value)) {
    throw new AppError(400, 'bad_request', 'Expected a list of ids');
  }
  return value
    .filter((v): v is string => typeof v === 'string' && v.length > 0 && v.length <= 64)
    .slice(0, 500);
}

/** Push an event to a specific user's live sockets from outside the hub. */
export function notifyUserSockets(userId: string, event: ServerEvent): void {
  for (const connection of localConnectionsFor(userId)) sendTo(connection, event);
}

export async function shutdownWebSockets(): Promise<void> {
  if (heartbeat) clearInterval(heartbeat);
  heartbeat = null;
  if (!wss) return;
  await new Promise<void>((resolve) => {
    wss?.close(() => resolve());
    for (const client of wss?.clients ?? []) {
      try {
        client.close(1001, 'server shutting down');
      } catch {
        /* ignore */
      }
    }
  });
  wss = null;
}

export { WS_IDLE_TIMEOUT_MS };
