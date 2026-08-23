/**
 * Voice and video calls.
 *
 * WebRTC connects the two devices directly wherever the network allows it, so
 * audio and video do not pass through this server at all. When NAT makes a
 * direct path impossible a TURN relay forwards the packets — and because
 * WebRTC mandates DTLS-SRTP, what the relay forwards is ciphertext it cannot
 * read either.
 *
 * The server's only role is to relay the offer, the answer and the ICE
 * candidates.
 */
import { create } from 'zustand';
import type { CallKind, CallRecord, IceServerConfig, PublicUser } from '@wolffmsg/shared';
import { api } from '../lib/api.ts';
import { realtime } from '../lib/socket.ts';
import { useSession } from './session.ts';

export type CallPhase =
  | 'idle'
  | 'ringing-out'
  | 'ringing-in'
  | 'connecting'
  | 'active'
  | 'ended';

interface CallState {
  phase: CallPhase;
  call: CallRecord | null;
  peer: PublicUser | null;
  kind: CallKind;
  localStream: MediaStream | null;
  remoteStream: MediaStream | null;
  micEnabled: boolean;
  cameraEnabled: boolean;
  error: string | null;
  startedAt: number | null;
  /** Reported by the browser: 'connected', 'checking', 'failed', … */
  connectionState: RTCPeerConnectionState | 'new';

  start: (chatId: string, kind: CallKind) => Promise<void>;
  accept: () => Promise<void>;
  decline: () => void;
  hangUp: () => void;
  toggleMic: () => void;
  toggleCamera: () => void;
  handleEvent: (event: unknown) => void;
}

let peerConnection: RTCPeerConnection | null = null;
let iceServers: IceServerConfig[] | null = null;
/** Candidates that arrive before the remote description is set. */
let pendingCandidates: RTCIceCandidateInit[] = [];
let remotePeerUserId: string | null = null;

async function loadIceServers(): Promise<IceServerConfig[]> {
  if (iceServers) return iceServers;
  try {
    const response = await api.get<{ iceServers: IceServerConfig[] }>(
      '/api/calls/ice-servers',
    );
    iceServers = response.iceServers;
  } catch {
    iceServers = [{ urls: ['stun:stun.l.google.com:19302'] }];
  }
  return iceServers;
}

function teardown(): void {
  peerConnection?.getSenders().forEach((sender) => sender.track?.stop());
  peerConnection?.close();
  peerConnection = null;
  pendingCandidates = [];
  remotePeerUserId = null;
}

export const useCalls = create<CallState>((set, get) => ({
  phase: 'idle',
  call: null,
  peer: null,
  kind: 'audio',
  localStream: null,
  remoteStream: null,
  micEnabled: true,
  cameraEnabled: true,
  error: null,
  startedAt: null,
  connectionState: 'new',

  start: async (chatId, kind) => {
    if (get().phase !== 'idle' && get().phase !== 'ended') return;

    set({ phase: 'ringing-out', kind, error: null, call: null });

    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: true,
        video: kind === 'video' ? { width: 1280, height: 720 } : false,
      });
      set({ localStream: stream, micEnabled: true, cameraEnabled: kind === 'video' });
      realtime.send({ t: 'call:start', chatId, kind, clientId: crypto.randomUUID() });
    } catch (err) {
      set({
        phase: 'idle',
        error:
          (err as Error).name === 'NotAllowedError'
            ? 'Microphone or camera access was denied.'
            : 'Could not access your microphone or camera.',
      });
    }
  },

  accept: async () => {
    const call = get().call;
    if (!call) return;

    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: true,
        video: call.kind === 'video' ? { width: 1280, height: 720 } : false,
      });
      set({
        localStream: stream,
        phase: 'connecting',
        micEnabled: true,
        cameraEnabled: call.kind === 'video',
      });
      realtime.send({ t: 'call:accept', callId: call.id });
    } catch {
      set({ error: 'Could not access your microphone or camera.' });
      realtime.send({ t: 'call:decline', callId: call.id });
      set({ phase: 'idle', call: null });
    }
  },

  decline: () => {
    const call = get().call;
    if (call) realtime.send({ t: 'call:decline', callId: call.id });
    get().localStream?.getTracks().forEach((track) => track.stop());
    teardown();
    set({
      phase: 'idle',
      call: null,
      peer: null,
      localStream: null,
      remoteStream: null,
    });
  },

  hangUp: () => {
    const call = get().call;
    if (call) realtime.send({ t: 'call:hangup', callId: call.id });
    get().localStream?.getTracks().forEach((track) => track.stop());
    teardown();
    set({
      phase: 'ended',
      localStream: null,
      remoteStream: null,
      connectionState: 'new',
    });
    window.setTimeout(() => {
      if (useCalls.getState().phase === 'ended') {
        useCalls.setState({ phase: 'idle', call: null, peer: null });
      }
    }, 1_500);
  },

  toggleMic: () => {
    const stream = get().localStream;
    const next = !get().micEnabled;
    stream?.getAudioTracks().forEach((track) => {
      track.enabled = next;
    });
    set({ micEnabled: next });
  },

  toggleCamera: () => {
    const stream = get().localStream;
    const next = !get().cameraEnabled;
    stream?.getVideoTracks().forEach((track) => {
      track.enabled = next;
    });
    set({ cameraEnabled: next });
  },

  handleEvent: (raw) => {
    void handleCallEvent(raw, set, get);
  },
}));

type Setter = (partial: Partial<CallState>) => void;
type Getter = () => CallState;

/** Build the peer connection and wire its callbacks. */
async function createPeerConnection(
  callId: string,
  toUserId: string,
  set: Setter,
): Promise<RTCPeerConnection> {
  const servers = await loadIceServers();
  const connection = new RTCPeerConnection({
    iceServers: servers.map((server) => ({
      urls: server.urls,
      ...(server.username ? { username: server.username } : {}),
      ...(server.credential ? { credential: server.credential } : {}),
    })),
    // Trickle ICE: send candidates as they are discovered rather than waiting
    // for gathering to finish, which shortens time-to-connect noticeably.
    iceCandidatePoolSize: 4,
  });

  connection.onicecandidate = (event) => {
    if (!event.candidate) return;
    realtime.send({
      t: 'call:signal',
      callId,
      toUserId,
      toDeviceId: null,
      signal: {
        kind: 'ice',
        candidate: event.candidate.candidate,
        sdpMid: event.candidate.sdpMid,
        sdpMLineIndex: event.candidate.sdpMLineIndex,
      },
    });
  };

  connection.ontrack = (event) => {
    const [stream] = event.streams;
    if (stream) set({ remoteStream: stream });
  };

  connection.onconnectionstatechange = () => {
    set({ connectionState: connection.connectionState });
    if (connection.connectionState === 'connected') {
      set({ phase: 'active', startedAt: useCalls.getState().startedAt ?? Date.now() });
    }
    if (
      connection.connectionState === 'failed' ||
      connection.connectionState === 'disconnected'
    ) {
      set({ error: 'The connection dropped.' });
    }
  };

  peerConnection = connection;
  return connection;
}

function attachLocalTracks(connection: RTCPeerConnection, stream: MediaStream): void {
  for (const track of stream.getTracks()) connection.addTrack(track, stream);
}

async function handleCallEvent(raw: unknown, set: Setter, get: Getter): Promise<void> {
  const event = raw as {
    t: string;
    call?: CallRecord;
    from?: PublicUser;
    callId?: string;
    userId?: string;
    fromUserId?: string;
    state?: string;
    signal?: {
      kind: string;
      sdp?: string;
      candidate?: string;
      sdpMid?: string | null;
      sdpMLineIndex?: number | null;
    };
  };

  const selfId = useSession.getState().user?.id;

  switch (event.t) {
    case 'call:incoming': {
      if (!event.call || !event.from) return;
      const mine = event.from.id === selfId;

      if (mine) {
        // Our own call, echoed back so we learn its id.
        set({ call: event.call, kind: event.call.kind });
        return;
      }

      // Already busy — decline rather than dropping the existing call.
      if (get().phase !== 'idle' && get().phase !== 'ended') {
        realtime.send({ t: 'call:decline', callId: event.call.id });
        return;
      }

      set({
        phase: 'ringing-in',
        call: event.call,
        peer: event.from,
        kind: event.call.kind,
        error: null,
      });
      return;
    }

    case 'call:accepted': {
      const call = get().call;
      if (!call || event.callId !== call.id) return;
      if (event.userId === selfId) return; // Our own acceptance.

      // The initiator makes the offer once the other side picks up.
      set({ phase: 'connecting', startedAt: Date.now() });
      remotePeerUserId = event.userId ?? null;
      if (!remotePeerUserId) return;

      const connection = await createPeerConnection(call.id, remotePeerUserId, set);
      const stream = get().localStream;
      if (stream) attachLocalTracks(connection, stream);

      const offer = await connection.createOffer();
      await connection.setLocalDescription(offer);

      realtime.send({
        t: 'call:signal',
        callId: call.id,
        toUserId: remotePeerUserId,
        toDeviceId: null,
        signal: { kind: 'offer', sdp: offer.sdp ?? '' },
      });
      return;
    }

    case 'call:declined': {
      if (event.userId === selfId) return;
      set({ error: 'Call declined' });
      get().hangUp();
      return;
    }

    case 'call:ended': {
      const call = get().call;
      if (!call || event.callId !== call.id) return;
      get().localStream?.getTracks().forEach((track) => track.stop());
      teardown();
      set({
        phase: 'ended',
        localStream: null,
        remoteStream: null,
        connectionState: 'new',
      });
      window.setTimeout(() => {
        if (useCalls.getState().phase === 'ended') {
          useCalls.setState({ phase: 'idle', call: null, peer: null, error: null });
        }
      }, 1_500);
      return;
    }

    case 'call:signal': {
      const call = get().call;
      if (!call || event.callId !== call.id || !event.signal) return;
      const fromUserId = event.fromUserId ?? null;

      if (event.signal.kind === 'offer') {
        remotePeerUserId = fromUserId;
        set({ phase: 'connecting', startedAt: get().startedAt ?? Date.now() });

        const connection =
          peerConnection ?? (await createPeerConnection(call.id, fromUserId ?? '', set));
        const stream = get().localStream;
        if (stream && connection.getSenders().length === 0) {
          attachLocalTracks(connection, stream);
        }

        await connection.setRemoteDescription({
          type: 'offer',
          sdp: event.signal.sdp ?? '',
        });
        await drainPendingCandidates(connection);

        const answer = await connection.createAnswer();
        await connection.setLocalDescription(answer);

        realtime.send({
          t: 'call:signal',
          callId: call.id,
          toUserId: fromUserId ?? '',
          toDeviceId: null,
          signal: { kind: 'answer', sdp: answer.sdp ?? '' },
        });
        return;
      }

      if (event.signal.kind === 'answer') {
        if (!peerConnection) return;
        await peerConnection.setRemoteDescription({
          type: 'answer',
          sdp: event.signal.sdp ?? '',
        });
        await drainPendingCandidates(peerConnection);
        return;
      }

      if (event.signal.kind === 'ice') {
        const candidate: RTCIceCandidateInit = {
          candidate: event.signal.candidate ?? '',
          sdpMid: event.signal.sdpMid ?? null,
          sdpMLineIndex: event.signal.sdpMLineIndex ?? null,
        };
        // A candidate can arrive before the description it belongs to; queue
        // it rather than throwing it away.
        if (!peerConnection?.remoteDescription) {
          pendingCandidates.push(candidate);
          return;
        }
        await peerConnection.addIceCandidate(candidate).catch(() => undefined);
      }
      return;
    }

    default:
      return;
  }
}

async function drainPendingCandidates(connection: RTCPeerConnection): Promise<void> {
  const queued = pendingCandidates.splice(0, pendingCandidates.length);
  for (const candidate of queued) {
    await connection.addIceCandidate(candidate).catch(() => undefined);
  }
}

/** Route call events from the socket into this store. */
export function connectCallEvents(): () => void {
  return realtime.on((event) => {
    if (event.t.startsWith('call:')) useCalls.getState().handleEvent(event);
  });
}
