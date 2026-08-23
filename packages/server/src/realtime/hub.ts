import type { ServerEvent } from '@wolffmsg/shared';
import type { WebSocket } from 'ws';
import { bus } from '../redis.js';
import { logger } from '../logger.js';
import { prisma } from '../db.js';

/**
 * The realtime hub.
 *
 * Sockets attached to *this* process live in `local`. Anything published goes
 * out over the message bus first and is delivered by whichever node holds the
 * target socket, so a multi-node deployment behaves identically to a single
 * one. With Redis absent the bus is in-process and the round trip is a
 * microtask.
 */

export interface Connection {
  id: string;
  userId: string;
  deviceId: string | null;
  sessionId: string;
  socket: WebSocket;
  /** Users whose presence changes this connection wants to hear about. */
  presenceWatch: Set<string>;
  isAlive: boolean;
}

const BUS_CHANNEL = 'wolffmsg:events';

interface BusMessage {
  /** Deliver to every connection belonging to these users. */
  userIds: string[];
  /** Optional device filter — used for call signalling. */
  deviceId?: string | null;
  /** Connections to skip (usually the originator). */
  exceptConnectionId?: string;
  event: ServerEvent;
}

const local = new Map<string, Connection>();
const byUser = new Map<string, Set<string>>();

let subscribed = false;

export async function initHub(): Promise<void> {
  if (subscribed) return;
  subscribed = true;
  await bus.subscribe(BUS_CHANNEL, (payload) => {
    let message: BusMessage;
    try {
      message = JSON.parse(payload) as BusMessage;
    } catch (err) {
      logger.error({ err }, 'malformed bus payload');
      return;
    }
    deliverLocally(message);
  });
}

export function addConnection(connection: Connection): void {
  local.set(connection.id, connection);
  const set = byUser.get(connection.userId) ?? new Set();
  set.add(connection.id);
  byUser.set(connection.userId, set);
}

export function removeConnection(connectionId: string): Connection | undefined {
  const connection = local.get(connectionId);
  if (!connection) return undefined;
  local.delete(connectionId);
  const set = byUser.get(connection.userId);
  set?.delete(connectionId);
  if (set && set.size === 0) byUser.delete(connection.userId);
  return connection;
}

export function localConnectionsFor(userId: string): Connection[] {
  const ids = byUser.get(userId);
  if (!ids) return [];
  return [...ids].map((id) => local.get(id)).filter((c): c is Connection => !!c);
}

export function localConnectionCount(): number {
  return local.size;
}

/** Send to one socket, tolerating a socket that closed mid-flight. */
export function sendTo(connection: Connection, event: ServerEvent): void {
  if (connection.socket.readyState !== connection.socket.OPEN) return;
  try {
    connection.socket.send(JSON.stringify(event));
  } catch (err) {
    logger.debug({ err, connectionId: connection.id }, 'socket send failed');
  }
}

function deliverLocally(message: BusMessage): void {
  for (const userId of message.userIds) {
    for (const connection of localConnectionsFor(userId)) {
      if (message.exceptConnectionId === connection.id) continue;
      if (message.deviceId && connection.deviceId !== message.deviceId) continue;
      if (
        message.event.t === 'presence:update' &&
        !connection.presenceWatch.has(message.event.userId)
      ) {
        continue;
      }
      sendTo(connection, message.event);
    }
  }
}

/** Publish an event to a set of users, across every node. */
export async function publishToUsers(
  userIds: string[],
  event: ServerEvent,
  options: { exceptConnectionId?: string; deviceId?: string | null } = {},
): Promise<void> {
  if (userIds.length === 0) return;
  const payload: BusMessage = {
    userIds: [...new Set(userIds)],
    event,
    ...(options.exceptConnectionId
      ? { exceptConnectionId: options.exceptConnectionId }
      : {}),
    ...(options.deviceId ? { deviceId: options.deviceId } : {}),
  };
  await bus.publish(BUS_CHANNEL, JSON.stringify(payload));
}

/** Publish to every member of a chat. */
export async function publishToChat(
  chatId: string,
  event: ServerEvent,
  options: { exceptConnectionId?: string } = {},
): Promise<void> {
  const members = await prisma.chatMember.findMany({
    where: { chatId },
    select: { userId: true },
  });
  await publishToUsers(
    members.map((m) => m.userId),
    event,
    options,
  );
}

/** Close every socket bound to a revoked session. */
export async function disconnectSessions(
  sessionIds: string[],
  reason: string,
): Promise<void> {
  const targets = new Set(sessionIds);
  for (const connection of local.values()) {
    if (!targets.has(connection.sessionId)) continue;
    sendTo(connection, { t: 'session:revoked', reason });
    try {
      connection.socket.close(4001, 'session revoked');
    } catch {
      /* socket already gone */
    }
  }
  // Other nodes learn about it through the bus.
  await bus.publish(
    'wolffmsg:session-revoked',
    JSON.stringify({ sessionIds, reason }),
  );
}

export async function initSessionRevocationListener(): Promise<void> {
  await bus.subscribe('wolffmsg:session-revoked', (payload) => {
    try {
      const { sessionIds, reason } = JSON.parse(payload) as {
        sessionIds: string[];
        reason: string;
      };
      const targets = new Set(sessionIds);
      for (const connection of local.values()) {
        if (!targets.has(connection.sessionId)) continue;
        sendTo(connection, { t: 'session:revoked', reason });
        try {
          connection.socket.close(4001, 'session revoked');
        } catch {
          /* socket already gone */
        }
      }
    } catch (err) {
      logger.error({ err }, 'malformed session revocation payload');
    }
  });
}

export function closeAllConnections(): void {
  for (const connection of local.values()) {
    try {
      connection.socket.close(1001, 'server shutting down');
    } catch {
      /* ignore */
    }
  }
  local.clear();
  byUser.clear();
}
