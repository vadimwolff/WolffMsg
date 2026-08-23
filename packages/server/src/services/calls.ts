import type { Prisma } from '@prisma/client';
import type { CallKind, CallRecord, CallState, IceServerConfig } from '@wolffmsg/shared';
import { prisma } from '../db.js';
import { env } from '../env.js';
import { badRequest, conflict, forbidden, notFound } from '../errors.js';
import { requireMembership, isBlockedEitherWay, directPeerId } from './access.js';
import { appendSystemMessage } from './chats.js';
import { recordCallNotification } from './notifications.js';

/**
 * Calls.
 *
 * The server is a signalling relay and a call log — nothing more. SDP offers,
 * answers and ICE candidates pass through opaquely, and media never touches
 * it: WebRTC connects the peers directly, falling back to a TURN relay only
 * when NAT makes a direct path impossible.
 *
 * WebRTC media is encrypted end-to-end by DTLS-SRTP, which is mandatory in
 * the spec. A TURN relay therefore forwards ciphertext it cannot read.
 */

const RING_TIMEOUT_MS = 45_000;

export function iceServers(): IceServerConfig[] {
  const servers: IceServerConfig[] = [{ urls: env.stunServers }];
  if (env.TURN_SERVER) {
    servers.push({
      urls: [env.TURN_SERVER],
      username: env.TURN_USERNAME,
      credential: env.TURN_PASSWORD,
    });
  }
  return servers;
}

export async function startCall(params: {
  chatId: string;
  initiatorId: string;
  deviceId: string | null;
  kind: CallKind;
}): Promise<{ call: CallRecord; targetUserIds: string[] }> {
  const membership = await requireMembership(params.chatId, params.initiatorId);

  if (membership.chatType === 'direct') {
    const peer = await directPeerId(params.chatId, params.initiatorId);
    if (!peer) throw notFound('There is no one to call in this conversation');
    if (await isBlockedEitherWay(params.initiatorId, peer)) {
      throw forbidden('You cannot call this person');
    }
  } else if (membership.readOnlyForMembers && membership.role === 'member') {
    throw forbidden('Only admins can start a call in this group');
  }

  // One live call per chat.
  const active = await prisma.call.findFirst({
    where: { chatId: params.chatId, state: { in: ['ringing', 'accepted'] } },
    select: { id: true },
  });
  if (active) throw conflict('A call is already in progress here', 'call_in_progress');

  const call = await prisma.call.create({
    data: {
      chatId: params.chatId,
      initiatorId: params.initiatorId,
      kind: params.kind,
      state: 'ringing',
      participants: {
        create: [{ userId: params.initiatorId, deviceId: params.deviceId }],
      },
    },
    include: { participants: true },
  });

  const members = await prisma.chatMember.findMany({
    where: { chatId: params.chatId, userId: { not: params.initiatorId } },
    select: { userId: true },
  });
  const targetUserIds = members.map((m) => m.userId);

  const initiator = await prisma.user.findUnique({
    where: { id: params.initiatorId },
    select: { displayName: true },
  });
  for (const userId of targetUserIds) {
    await recordCallNotification({
      userId,
      chatId: params.chatId,
      callerName: initiator?.displayName ?? 'WolffMsg',
    }).catch(() => undefined);
  }

  // If nobody picks up, the call closes itself rather than ringing forever.
  setTimeout(() => {
    void expireIfUnanswered(call.id);
  }, RING_TIMEOUT_MS).unref?.();

  return { call: toCallRecord(call), targetUserIds };
}

async function expireIfUnanswered(callId: string): Promise<void> {
  const call = await prisma.call.findUnique({
    where: { id: callId },
    select: { state: true },
  });
  if (call?.state !== 'ringing') return;
  await endCall(callId, 'missed').catch(() => undefined);
}

export async function acceptCall(
  callId: string,
  userId: string,
  deviceId: string | null,
): Promise<CallRecord> {
  const call = await requireCallAccess(callId, userId);
  if (call.state !== 'ringing') {
    throw conflict('That call is no longer ringing', 'call_not_ringing');
  }

  const updated = await prisma.call.update({
    where: { id: callId },
    data: {
      state: 'accepted',
      answeredAt: new Date(),
      participants: {
        upsert: {
          where: { callId_userId: { callId, userId } },
          create: { userId, deviceId },
          update: { joinedAt: new Date(), leftAt: null, deviceId },
        },
      },
    },
    include: { participants: true },
  });
  return toCallRecord(updated);
}

export async function declineCall(
  callId: string,
  userId: string,
): Promise<CallRecord> {
  const call = await requireCallAccess(callId, userId);
  if (call.state !== 'ringing') return toCallRecord(call);

  const members = await prisma.chatMember.count({ where: { chatId: call.chatId } });
  // In a one-to-one call a decline ends it. In a group it just means one
  // person is not joining.
  if (members <= 2) return endCall(callId, 'declined');

  await prisma.callParticipant.upsert({
    where: { callId_userId: { callId, userId } },
    create: { userId, callId, leftAt: new Date() },
    update: { leftAt: new Date() },
  });
  const refreshed = await prisma.call.findUniqueOrThrow({
    where: { id: callId },
    include: { participants: true },
  });
  return toCallRecord(refreshed);
}

export async function hangUp(callId: string, userId: string): Promise<CallRecord> {
  const call = await requireCallAccess(callId, userId);
  if (call.state === 'ended' || call.state === 'missed' || call.state === 'declined') {
    return toCallRecord(call);
  }

  await prisma.callParticipant.upsert({
    where: { callId_userId: { callId, userId } },
    create: { callId, userId, leftAt: new Date() },
    update: { leftAt: new Date() },
  });

  const stillIn = await prisma.callParticipant.count({
    where: { callId, leftAt: null },
  });
  if (stillIn <= 1) return endCall(callId, 'ended');

  const refreshed = await prisma.call.findUniqueOrThrow({
    where: { id: callId },
    include: { participants: true },
  });
  return toCallRecord(refreshed);
}

export async function endCall(
  callId: string,
  state: CallState,
): Promise<CallRecord> {
  const endedAt = new Date();
  const call = await prisma.call.update({
    where: { id: callId },
    data: {
      state,
      endedAt,
      participants: { updateMany: { where: { leftAt: null }, data: { leftAt: endedAt } } },
    },
    include: { participants: true },
  });

  const durationMs = call.answeredAt
    ? endedAt.getTime() - call.answeredAt.getTime()
    : 0;

  await appendSystemMessage(call.chatId, call.initiatorId, {
    kind: 'call.ended',
    actorId: call.initiatorId,
    callKind: call.kind as CallKind,
    state,
    durationMs,
  }).catch(() => undefined);

  return toCallRecord(call);
}

/**
 * Confirm the caller is entitled to act on this call: they must be a member of
 * the chat it belongs to.
 */
export async function requireCallAccess(callId: string, userId: string) {
  const call = await prisma.call.findUnique({
    where: { id: callId },
    include: { participants: true },
  });
  if (!call) throw notFound('That call does not exist');
  await requireMembership(call.chatId, userId);
  return call;
}

/**
 * Validate a signalling payload before relaying it.
 *
 * The server does not parse SDP, but it does bound its size and confirm the
 * shape, so a socket cannot be used to blast arbitrary megabytes at another
 * user through the relay.
 */
const MAX_SDP_BYTES = 64 * 1024;
const MAX_CANDIDATE_BYTES = 2 * 1024;

export function assertSignalShape(signal: unknown): void {
  if (!signal || typeof signal !== 'object') throw badRequest('Malformed signal');
  const s = signal as Record<string, unknown>;
  switch (s.kind) {
    case 'offer':
    case 'answer':
      if (typeof s.sdp !== 'string' || s.sdp.length > MAX_SDP_BYTES) {
        throw badRequest('Malformed session description');
      }
      return;
    case 'ice':
      if (typeof s.candidate !== 'string' || s.candidate.length > MAX_CANDIDATE_BYTES) {
        throw badRequest('Malformed ICE candidate');
      }
      if (s.sdpMid !== null && typeof s.sdpMid !== 'string') {
        throw badRequest('Malformed ICE candidate');
      }
      if (s.sdpMLineIndex !== null && typeof s.sdpMLineIndex !== 'number') {
        throw badRequest('Malformed ICE candidate');
      }
      return;
    case 'renegotiate':
      return;
    default:
      throw badRequest('Unknown signal type');
  }
}

type CallWithParticipants = Prisma.CallGetPayload<{
  include: { participants: true };
}>;

export function toCallRecord(call: CallWithParticipants): CallRecord {
  return {
    id: call.id,
    chatId: call.chatId,
    initiatorId: call.initiatorId,
    kind: call.kind as CallKind,
    state: call.state as CallState,
    startedAt: call.startedAt.toISOString(),
    answeredAt: call.answeredAt?.toISOString() ?? null,
    endedAt: call.endedAt?.toISOString() ?? null,
    participants: call.participants.map((p) => ({
      userId: p.userId,
      joinedAt: p.joinedAt.toISOString(),
      leftAt: p.leftAt?.toISOString() ?? null,
    })),
  };
}

export async function callHistory(
  chatId: string,
  userId: string,
  limit = 30,
): Promise<CallRecord[]> {
  await requireMembership(chatId, userId);
  const calls = await prisma.call.findMany({
    where: { chatId },
    include: { participants: true },
    orderBy: { startedAt: 'desc' },
    take: Math.min(limit, 100),
  });
  return calls.map(toCallRecord);
}
