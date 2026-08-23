import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import type { ClientCommand, ServerEvent } from '@wolffmsg/shared';
import {
  closeApp,
  createActor,
  createGroup,
  getApp,
  openDirect,
  request,
  resetDatabase,
  sendEncrypted,
  type TestActor,
} from './helpers.js';
import { attachWebSocketServer, shutdownWebSockets } from '../realtime/socket.js';
import { initHub } from '../realtime/hub.js';
import { env } from '../env.js';

/**
 * Realtime tests run against a genuinely listening server with real WebSocket
 * clients — `inject()` cannot exercise an upgrade.
 */

let port = 0;

beforeAll(async () => {
  await initHub();
  const app = await getApp();
  await app.listen({ port: 0, host: '127.0.0.1' });
  attachWebSocketServer(app.server);
  const address = app.server.address();
  port = typeof address === 'object' && address ? address.port : 0;
});

afterAll(async () => {
  await shutdownWebSockets();
  await closeApp();
});

beforeEach(async () => {
  await resetDatabase();
});

/** A WebSocket client that records every event it receives. */
class TestSocket {
  readonly events: ServerEvent[] = [];
  /** Captured at close time — reading it afterwards must not race. */
  private closeCode: number | null = null;
  private constructor(private readonly socket: WebSocket) {
    socket.once('close', (code) => {
      this.closeCode = code;
    });
  }

  static async connect(
    actor: TestActor,
    options: { origin?: string | null } = {},
  ): Promise<TestSocket> {
    const headers: Record<string, string> = { cookie: actor.cookie };
    const origin = options.origin === undefined
      ? (env.webOrigins[0] ?? 'http://localhost:5173')
      : options.origin;
    if (origin) headers.origin = origin;

    const socket = new WebSocket(`ws://127.0.0.1:${port}/ws`, { headers });
    const client = new TestSocket(socket);

    socket.on('message', (raw) => {
      try {
        client.events.push(JSON.parse(raw.toString()) as ServerEvent);
      } catch {
        /* ignore malformed frames */
      }
    });

    await new Promise<void>((resolve, reject) => {
      socket.once('open', () => resolve());
      socket.once('error', (err) => reject(err));
      socket.once('unexpected-response', (_req, res) =>
        reject(new Error(`upgrade rejected with ${res.statusCode}`)),
      );
    });

    await client.waitFor((e) => e.t === 'ready');
    return client;
  }

  send(command: ClientCommand): void {
    this.socket.send(JSON.stringify(command));
  }

  /** Resolve once an event matching the predicate arrives. */
  async waitFor<T extends ServerEvent>(
    predicate: (event: ServerEvent) => boolean,
    timeoutMs = 5_000,
  ): Promise<T> {
    const existing = this.events.find(predicate);
    if (existing) return existing as T;

    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.socket.off('message', onMessage);
        reject(
          new Error(
            `Timed out waiting for event. Saw: ${this.events.map((e) => e.t).join(', ')}`,
          ),
        );
      }, timeoutMs);

      const onMessage = (raw: Buffer) => {
        let event: ServerEvent;
        try {
          event = JSON.parse(raw.toString()) as ServerEvent;
        } catch {
          return;
        }
        if (predicate(event)) {
          clearTimeout(timer);
          this.socket.off('message', onMessage);
          resolve(event as T);
        }
      };
      this.socket.on('message', onMessage as never);
    });
  }

  /** Give the server a moment, then assert nothing matching arrived. */
  async expectNothing(
    predicate: (event: ServerEvent) => boolean,
    windowMs = 600,
  ): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, windowMs));
    expect(this.events.find(predicate)).toBeUndefined();
  }

  get closed(): boolean {
    return (
      this.socket.readyState === WebSocket.CLOSED ||
      this.socket.readyState === WebSocket.CLOSING
    );
  }

  async waitForClose(timeoutMs = 5_000): Promise<number> {
    if (this.closeCode !== null) return this.closeCode;
    return new Promise<number>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('socket did not close')), timeoutMs);
      this.socket.once('close', (code) => {
        clearTimeout(timer);
        resolve(code);
      });
    });
  }

  close(): void {
    this.socket.close();
  }
}

describe('socket authentication', () => {
  it('accepts a request carrying a valid session cookie', async () => {
    const alice = await createActor();
    const socket = await TestSocket.connect(alice);
    const ready = socket.events.find((e) => e.t === 'ready');
    expect(ready).toBeTruthy();
    socket.close();
  });

  it('refuses an unauthenticated upgrade', async () => {
    const socket = new WebSocket(`ws://127.0.0.1:${port}/ws`, {
      headers: { origin: env.webOrigins[0] ?? 'http://localhost:5173' },
    });
    const failure = await new Promise<string>((resolve) => {
      socket.once('error', () => resolve('error'));
      socket.once('unexpected-response', (_r, res) => resolve(String(res.statusCode)));
      socket.once('open', () => resolve('opened'));
    });
    expect(failure).not.toBe('opened');
    socket.close();
  });

  it('refuses an upgrade from a hostile origin', async () => {
    const alice = await createActor();
    await expect(
      TestSocket.connect(alice, { origin: 'https://evil.example' }),
    ).rejects.toThrow();
  });

  it('closes the socket when its session is revoked', async () => {
    const alice = await createActor();
    const socket = await TestSocket.connect(alice);

    await request({ method: 'POST', url: '/api/auth/logout', actor: alice });

    const revoked = await socket.waitFor((e) => e.t === 'session:revoked');
    expect(revoked.t).toBe('session:revoked');
    expect(await socket.waitForClose()).toBe(4001);
  });
});

describe('message delivery', () => {
  it('pushes a new message to the recipient in realtime', async () => {
    const alice = await createActor();
    const bob = await createActor();
    const chatId = await openDirect(alice, bob);

    const bobSocket = await TestSocket.connect(bob);
    await sendEncrypted(alice, chatId, 'realtime hello');

    const event = await bobSocket.waitFor(
      (e) => e.t === 'message:new' && e.message.chatId === chatId,
    );
    expect(event.t).toBe('message:new');
    if (event.t === 'message:new') {
      // Bob's device gets its own wrapped key and nothing else.
      expect(event.message.envelope?.keys).toHaveLength(1);
      expect(event.message.envelope?.keys[0]!.deviceId).toBe(bob.deviceId);
    }
    bobSocket.close();
  });

  it('does not push a chat message to an outsider', async () => {
    const alice = await createActor();
    const bob = await createActor();
    const eve = await createActor();
    const chatId = await openDirect(alice, bob);

    const eveSocket = await TestSocket.connect(eve);
    await sendEncrypted(alice, chatId, 'not for eve');
    await eveSocket.expectNothing((e) => e.t === 'message:new');
    eveSocket.close();
  });

  it('reports delivery and read back to the sender', async () => {
    const alice = await createActor();
    const bob = await createActor();
    const chatId = await openDirect(alice, bob);

    const aliceSocket = await TestSocket.connect(alice);
    const bobSocket = await TestSocket.connect(bob);

    const sent = await sendEncrypted(alice, chatId, 'did this arrive?');

    bobSocket.send({ t: 'message:delivered', chatId, messageIds: [sent.id] });
    const delivered = await aliceSocket.waitFor((e) => e.t === 'message:delivered');
    expect(delivered.t).toBe('message:delivered');

    bobSocket.send({ t: 'message:read', chatId, messageIds: [sent.id] });
    const read = await aliceSocket.waitFor((e) => e.t === 'message:read');
    expect(read.t).toBe('message:read');
    if (read.t === 'message:read') expect(read.userId).toBe(bob.userId);

    aliceSocket.close();
    bobSocket.close();
  });

  it('broadcasts an edit and a deletion', async () => {
    const alice = await createActor();
    const bob = await createActor();
    const chatId = await openDirect(alice, bob);
    const bobSocket = await TestSocket.connect(bob);

    const sent = await sendEncrypted(alice, chatId, 'first draft');
    await bobSocket.waitFor((e) => e.t === 'message:new');

    await request({ method: 'DELETE', url: `/api/messages/${sent.id}`, actor: alice });
    const deleted = await bobSocket.waitFor((e) => e.t === 'message:deleted');
    expect(deleted.t).toBe('message:deleted');
    bobSocket.close();
  });

  it('broadcasts a reaction', async () => {
    const alice = await createActor();
    const bob = await createActor();
    const chatId = await openDirect(alice, bob);
    const aliceSocket = await TestSocket.connect(alice);
    const sent = await sendEncrypted(alice, chatId, 'react please');

    await request({
      method: 'POST',
      url: `/api/messages/${sent.id}/reactions`,
      actor: bob,
      payload: { emoji: '🐺' },
    });

    const event = await aliceSocket.waitFor((e) => e.t === 'message:reaction');
    expect(event.t).toBe('message:reaction');
    if (event.t === 'message:reaction') {
      expect(event.reactions[0]!.emoji).toBe('🐺');
    }
    aliceSocket.close();
  });
});

describe('typing indicators', () => {
  it('relays typing to the other party but not back to the sender', async () => {
    const alice = await createActor();
    const bob = await createActor();
    const chatId = await openDirect(alice, bob);

    const aliceSocket = await TestSocket.connect(alice);
    const bobSocket = await TestSocket.connect(bob);

    aliceSocket.send({ t: 'typing:start', chatId });

    const seen = await bobSocket.waitFor((e) => e.t === 'typing:start');
    expect(seen.t).toBe('typing:start');
    if (seen.t === 'typing:start') expect(seen.userId).toBe(alice.userId);

    await aliceSocket.expectNothing((e) => e.t === 'typing:start');

    aliceSocket.close();
    bobSocket.close();
  });

  it('refuses a typing event for a chat the socket is not in', async () => {
    const alice = await createActor();
    const bob = await createActor();
    const eve = await createActor();
    const chatId = await openDirect(alice, bob);

    const eveSocket = await TestSocket.connect(eve);
    const bobSocket = await TestSocket.connect(bob);

    eveSocket.send({ t: 'typing:start', chatId });

    const error = await eveSocket.waitFor((e) => e.t === 'error');
    expect(error.t).toBe('error');
    await bobSocket.expectNothing((e) => e.t === 'typing:start');

    eveSocket.close();
    bobSocket.close();
  });

  it('respects a user who turned typing indicators off', async () => {
    const alice = await createActor();
    const bob = await createActor();
    const chatId = await openDirect(alice, bob);

    await request({
      method: 'PATCH',
      url: '/api/me/privacy',
      actor: alice,
      payload: { typingIndicators: false },
    });

    const aliceSocket = await TestSocket.connect(alice);
    const bobSocket = await TestSocket.connect(bob);
    aliceSocket.send({ t: 'typing:start', chatId });

    await bobSocket.expectNothing((e) => e.t === 'typing:start');
    aliceSocket.close();
    bobSocket.close();
  });
});

describe('presence', () => {
  it('announces a user coming online to people who share a chat', async () => {
    const alice = await createActor();
    const bob = await createActor();
    await openDirect(alice, bob);

    const bobSocket = await TestSocket.connect(bob);
    bobSocket.send({ t: 'presence:subscribe', userIds: [alice.userId] });
    await new Promise((resolve) => setTimeout(resolve, 100));

    const aliceSocket = await TestSocket.connect(alice);
    const event = await bobSocket.waitFor(
      (e) => e.t === 'presence:update' && e.userId === alice.userId,
    );
    expect(event.t).toBe('presence:update');
    if (event.t === 'presence:update') expect(event.online).toBe(true);

    aliceSocket.close();
    bobSocket.close();
  });

  it('does not announce presence to a stranger', async () => {
    const alice = await createActor();
    const stranger = await createActor();

    const strangerSocket = await TestSocket.connect(stranger);
    strangerSocket.send({ t: 'presence:subscribe', userIds: [alice.userId] });
    await new Promise((resolve) => setTimeout(resolve, 100));

    const aliceSocket = await TestSocket.connect(alice);
    await strangerSocket.expectNothing((e) => e.t === 'presence:update');

    aliceSocket.close();
    strangerSocket.close();
  });

  it('does not announce presence to a blocked user', async () => {
    const alice = await createActor();
    const blocked = await createActor();
    await openDirect(alice, blocked);
    await request({
      method: 'POST',
      url: '/api/blocked',
      actor: alice,
      payload: { userId: blocked.userId },
    });

    const blockedSocket = await TestSocket.connect(blocked);
    blockedSocket.send({ t: 'presence:subscribe', userIds: [alice.userId] });
    await new Promise((resolve) => setTimeout(resolve, 100));

    const aliceSocket = await TestSocket.connect(alice);
    await blockedSocket.expectNothing((e) => e.t === 'presence:update');

    aliceSocket.close();
    blockedSocket.close();
  });
});

describe('calls', () => {
  it('rings the other party and relays signalling', async () => {
    const alice = await createActor();
    const bob = await createActor();
    const chatId = await openDirect(alice, bob);

    const aliceSocket = await TestSocket.connect(alice);
    const bobSocket = await TestSocket.connect(bob);

    aliceSocket.send({ t: 'call:start', chatId, kind: 'audio', clientId: 'c1' });

    const incoming = await bobSocket.waitFor((e) => e.t === 'call:incoming');
    expect(incoming.t).toBe('call:incoming');
    const callId = incoming.t === 'call:incoming' ? incoming.call.id : '';

    bobSocket.send({ t: 'call:accept', callId });
    const accepted = await aliceSocket.waitFor((e) => e.t === 'call:accepted');
    expect(accepted.t).toBe('call:accepted');

    aliceSocket.send({
      t: 'call:signal',
      callId,
      toUserId: bob.userId,
      toDeviceId: null,
      signal: { kind: 'offer', sdp: 'v=0\r\no=- 0 0 IN IP4 127.0.0.1\r\n' },
    });
    const signal = await bobSocket.waitFor((e) => e.t === 'call:signal');
    expect(signal.t).toBe('call:signal');

    aliceSocket.send({ t: 'call:hangup', callId });
    const ended = await bobSocket.waitFor((e) => e.t === 'call:ended');
    expect(ended.t).toBe('call:ended');

    aliceSocket.close();
    bobSocket.close();
  });

  it('will not relay signalling to someone outside the call chat', async () => {
    const alice = await createActor();
    const bob = await createActor();
    const eve = await createActor();
    const chatId = await openDirect(alice, bob);

    const aliceSocket = await TestSocket.connect(alice);
    const bobSocket = await TestSocket.connect(bob);
    const eveSocket = await TestSocket.connect(eve);

    aliceSocket.send({ t: 'call:start', chatId, kind: 'audio', clientId: 'c1' });
    const incoming = await bobSocket.waitFor((e) => e.t === 'call:incoming');
    const callId = incoming.t === 'call:incoming' ? incoming.call.id : '';

    aliceSocket.send({
      t: 'call:signal',
      callId,
      toUserId: eve.userId,
      toDeviceId: null,
      signal: { kind: 'offer', sdp: 'v=0\r\n' },
    });

    await eveSocket.expectNothing((e) => e.t === 'call:signal');
    const error = await aliceSocket.waitFor((e) => e.t === 'error');
    expect(error.t).toBe('error');

    aliceSocket.close();
    bobSocket.close();
    eveSocket.close();
  });

  it('will not let an outsider start a call in a chat', async () => {
    const alice = await createActor();
    const bob = await createActor();
    const eve = await createActor();
    const chatId = await openDirect(alice, bob);

    const eveSocket = await TestSocket.connect(eve);
    eveSocket.send({ t: 'call:start', chatId, kind: 'video', clientId: 'c1' });

    const error = await eveSocket.waitFor((e) => e.t === 'error');
    expect(error.t).toBe('error');
    eveSocket.close();
  });

  it('rejects an oversized SDP payload', async () => {
    const alice = await createActor();
    const bob = await createActor();
    const chatId = await openDirect(alice, bob);

    const aliceSocket = await TestSocket.connect(alice);
    const bobSocket = await TestSocket.connect(bob);
    aliceSocket.send({ t: 'call:start', chatId, kind: 'audio', clientId: 'c1' });
    const incoming = await bobSocket.waitFor((e) => e.t === 'call:incoming');
    const callId = incoming.t === 'call:incoming' ? incoming.call.id : '';

    aliceSocket.send({
      t: 'call:signal',
      callId,
      toUserId: bob.userId,
      toDeviceId: null,
      signal: { kind: 'offer', sdp: 'x'.repeat(100_000) },
    });

    const error = await aliceSocket.waitFor((e) => e.t === 'error');
    expect(error.t).toBe('error');
    aliceSocket.close();
    bobSocket.close();
  });
});

describe('socket abuse', () => {
  it('answers a malformed frame with an error rather than crashing', async () => {
    const alice = await createActor();
    const socket = await TestSocket.connect(alice);
    socket.send('not json at all' as unknown as ClientCommand);
    const error = await socket.waitFor((e) => e.t === 'error');
    expect(error.t).toBe('error');
    socket.close();
  });

  it('closes a socket that floods the server with events', async () => {
    const alice = await createActor();
    const bob = await createActor();
    const chatId = await openDirect(alice, bob);
    const socket = await TestSocket.connect(alice);

    for (let i = 0; i < 700; i += 1) {
      socket.send({ t: 'typing:start', chatId });
    }

    const code = await socket.waitForClose(8_000);
    expect(code).toBe(1008);
  });

  it('rejects an unknown command', async () => {
    const alice = await createActor();
    const socket = await TestSocket.connect(alice);
    socket.send({ t: 'delete:everything' } as unknown as ClientCommand);
    const error = await socket.waitFor(
      (e) => e.t === 'error' && e.code === 'unknown_command',
    );
    expect(error.t).toBe('error');
    socket.close();
  });
});

describe('group realtime', () => {
  it('notifies every member when someone is added', async () => {
    const owner = await createActor();
    const member = await createActor();
    const newcomer = await createActor();
    const groupId = await createGroup(owner, 'Realtime pack', [member.userId]);

    const memberSocket = await TestSocket.connect(member);
    const newcomerSocket = await TestSocket.connect(newcomer);

    await request({
      method: 'POST',
      url: `/api/chats/${groupId}/members`,
      actor: owner,
      payload: { userIds: [newcomer.userId] },
    });

    const update = await memberSocket.waitFor(
      (e) => e.t === 'chat:update' && e.chat.id === groupId,
    );
    expect(update.t).toBe('chat:update');

    const joined = await newcomerSocket.waitFor(
      (e) => e.t === 'chat:update' && e.chat.id === groupId,
    );
    expect(joined.t).toBe('chat:update');

    memberSocket.close();
    newcomerSocket.close();
  });

  it('tells a removed member the chat is gone', async () => {
    const owner = await createActor();
    const member = await createActor();
    const groupId = await createGroup(owner, 'Realtime pack', [member.userId]);
    const memberSocket = await TestSocket.connect(member);

    await request({
      method: 'DELETE',
      url: `/api/chats/${groupId}/members/${member.userId}`,
      actor: owner,
    });

    const removed = await memberSocket.waitFor(
      (e) => e.t === 'chat:removed' && e.chatId === groupId,
    );
    expect(removed.t).toBe('chat:removed');
    memberSocket.close();
  });
});
