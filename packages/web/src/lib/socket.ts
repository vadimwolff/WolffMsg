/**
 * The realtime client.
 *
 * Responsibilities beyond "open a WebSocket": survive a flaky network without
 * hammering the server, notice when the browser tells us the connection state
 * changed rather than waiting for a timeout, and keep a single connection per
 * tab no matter how many components subscribe.
 */
import {
  WS_PING_INTERVAL_MS,
  type ClientCommand,
  type ServerEvent,
} from '@wolffmsg/shared';

export type ConnectionState = 'connecting' | 'online' | 'offline' | 'reconnecting';

type EventListener = (event: ServerEvent) => void;
type StateListener = (state: ConnectionState) => void;

/** Backoff schedule, in ms. Jitter is added so reconnects do not synchronise. */
const BACKOFF = [500, 1_000, 2_000, 4_000, 8_000, 15_000, 30_000];

class RealtimeClient {
  private socket: WebSocket | null = null;
  private state: ConnectionState = 'offline';
  private attempt = 0;
  private reconnectTimer: number | null = null;
  private heartbeat: number | null = null;
  private lastPong = 0;
  private wantConnection = false;

  private readonly eventListeners = new Set<EventListener>();
  private readonly stateListeners = new Set<StateListener>();

  /** Commands issued while offline, replayed on reconnect. */
  private readonly pending: ClientCommand[] = [];

  constructor() {
    if (typeof window !== 'undefined') {
      window.addEventListener('online', () => this.onNetworkUp());
      window.addEventListener('offline', () => this.setState('offline'));
      document.addEventListener('visibilitychange', () => {
        // Waking from a background tab is the most common moment for a socket
        // to be silently dead, so re-check rather than trust it.
        if (document.visibilityState === 'visible') this.onNetworkUp();
      });
    }
  }

  connect(): void {
    this.wantConnection = true;
    this.open();
  }

  disconnect(): void {
    this.wantConnection = false;
    this.clearTimers();
    this.pending.length = 0;
    if (this.socket) {
      this.socket.onclose = null;
      this.socket.close(1000, 'client disconnect');
      this.socket = null;
    }
    this.setState('offline');
  }

  private open(): void {
    if (!this.wantConnection) return;
    if (
      this.socket &&
      (this.socket.readyState === WebSocket.OPEN ||
        this.socket.readyState === WebSocket.CONNECTING)
    ) {
      return;
    }

    this.setState(this.attempt === 0 ? 'connecting' : 'reconnecting');

    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const socket = new WebSocket(`${protocol}//${location.host}/ws`);
    this.socket = socket;

    socket.onopen = () => {
      this.attempt = 0;
      this.lastPong = Date.now();
      this.setState('online');
      this.startHeartbeat();
      // Replay anything queued while we were away.
      const queued = this.pending.splice(0, this.pending.length);
      for (const command of queued) this.send(command);
    };

    socket.onmessage = (message) => {
      let event: ServerEvent;
      try {
        event = JSON.parse(message.data as string) as ServerEvent;
      } catch {
        return;
      }
      if (event.t === 'pong') {
        this.lastPong = Date.now();
        return;
      }
      if (event.t === 'session:revoked') {
        // Nothing to reconnect to — the session is gone.
        this.wantConnection = false;
      }
      for (const listener of this.eventListeners) listener(event);
    };

    socket.onerror = () => {
      // `onclose` always follows; the reconnect is scheduled from there so it
      // cannot be scheduled twice.
    };

    socket.onclose = () => {
      this.clearTimers();
      this.socket = null;
      if (!this.wantConnection) {
        this.setState('offline');
        return;
      }
      this.scheduleReconnect();
    };
  }

  private scheduleReconnect(): void {
    this.setState('reconnecting');
    const base = BACKOFF[Math.min(this.attempt, BACKOFF.length - 1)] ?? 30_000;
    // ±25% jitter, so a server restart does not bring every client back at once.
    const delay = base * (0.75 + Math.random() * 0.5);
    this.attempt += 1;
    this.reconnectTimer = window.setTimeout(() => this.open(), delay);
  }

  /** Called on `online` / tab focus: try again immediately rather than waiting. */
  private onNetworkUp(): void {
    if (!this.wantConnection) return;
    if (this.socket?.readyState === WebSocket.OPEN) return;
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.attempt = 0;
    this.open();
  }

  private startHeartbeat(): void {
    this.heartbeat = window.setInterval(() => {
      if (this.socket?.readyState !== WebSocket.OPEN) return;
      // Two missed heartbeats means the socket is dead even though the browser
      // has not noticed — a common outcome on mobile networks.
      if (Date.now() - this.lastPong > WS_PING_INTERVAL_MS * 2.5) {
        this.socket.close(4000, 'heartbeat timeout');
        return;
      }
      this.send({ t: 'ping', ts: Date.now() });
    }, WS_PING_INTERVAL_MS);
  }

  private clearTimers(): void {
    if (this.heartbeat !== null) {
      clearInterval(this.heartbeat);
      this.heartbeat = null;
    }
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  private setState(state: ConnectionState): void {
    if (this.state === state) return;
    this.state = state;
    for (const listener of this.stateListeners) listener(state);
  }

  getState(): ConnectionState {
    return this.state;
  }

  /**
   * Send a command. Queued when offline — except for the ephemeral ones, where
   * replaying a stale "I am typing" seconds later would be wrong.
   */
  send(command: ClientCommand): void {
    if (this.socket?.readyState === WebSocket.OPEN) {
      this.socket.send(JSON.stringify(command));
      return;
    }
    const ephemeral =
      command.t === 'ping' ||
      command.t === 'typing:start' ||
      command.t === 'typing:stop';
    if (!ephemeral && this.pending.length < 200) this.pending.push(command);
  }

  on(listener: EventListener): () => void {
    this.eventListeners.add(listener);
    return () => this.eventListeners.delete(listener);
  }

  onStateChange(listener: StateListener): () => void {
    this.stateListeners.add(listener);
    return () => this.stateListeners.delete(listener);
  }
}

export const realtime = new RealtimeClient();

/**
 * Typing notifications, throttled.
 *
 * A key press must not become a network packet. `start` is sent at most once
 * per window and `stop` follows a short idle period, which is both kinder to
 * the server and less revealing than a live keystroke stream.
 */
export class TypingSignal {
  private lastSent = 0;
  private stopTimer: number | null = null;

  constructor(
    private readonly chatId: string,
    private readonly throttleMs = 3_000,
    private readonly idleMs = 4_000,
  ) {}

  keyPress(): void {
    const now = Date.now();
    if (now - this.lastSent > this.throttleMs) {
      this.lastSent = now;
      realtime.send({ t: 'typing:start', chatId: this.chatId });
    }
    if (this.stopTimer !== null) clearTimeout(this.stopTimer);
    this.stopTimer = window.setTimeout(() => this.stop(), this.idleMs);
  }

  stop(): void {
    if (this.stopTimer !== null) {
      clearTimeout(this.stopTimer);
      this.stopTimer = null;
    }
    if (this.lastSent === 0) return;
    this.lastSent = 0;
    realtime.send({ t: 'typing:stop', chatId: this.chatId });
  }
}
