import fs from 'node:fs/promises';
import type { FastifyInstance } from 'fastify';
import {
  createDeviceSecrets,
  encryptMessage,
  decryptMessage,
  findPrivatePreKey,
  initCrypto,
  randomId,
  toB64,
  type DeviceSecrets,
  type EncryptedEnvelope,
  type EnvelopeContext,
  type MessagePlaintext,
  type PreKeyBundle,
} from '@wolffmsg/shared';
import sodium from 'libsodium-wrappers-sumo';
import { buildApp } from '../app.js';
import { prisma } from '../db.js';
import { env } from '../env.js';
import { resetCountersForTests } from '../redis.js';

/**
 * Test harness.
 *
 * Every actor here holds real device keys and performs real encryption — the
 * suite exercises the same code path a browser does, so a break in the
 * protocol shows up as a failing test rather than a passing mock.
 */

let app: FastifyInstance | null = null;

export async function getApp(): Promise<FastifyInstance> {
  if (!app) {
    await initCrypto();
    app = await buildApp();
    await app.ready();
  }
  return app;
}

export async function closeApp(): Promise<void> {
  await app?.close();
  app = null;
}

/** Wipe every table between tests, preserving the schema. */
export async function resetDatabase(): Promise<void> {
  // `users` and `chats` cascade to almost everything else.
  await prisma.$executeRawUnsafe(`
    TRUNCATE TABLE
      "message_keys", "message_reactions", "message_reads", "message_deliveries",
      "pinned_messages", "attachments", "messages", "chat_members", "chats",
      "call_participants", "calls", "notifications", "push_subscriptions",
      "security_events", "login_attempts", "sessions", "prekeys", "devices",
      "contacts", "blocked_users", "user_settings", "users"
    RESTART IDENTITY CASCADE
  `);
  await fs.rm(env.storageRoot, { recursive: true, force: true }).catch(() => undefined);
  await fs.mkdir(env.storageRoot, { recursive: true }).catch(() => undefined);
  // Rate-limit and presence counters live outside the database.
  await resetCountersForTests();
}

export interface TestActor {
  userId: string;
  username: string;
  displayName: string;
  deviceId: string;
  secrets: DeviceSecrets;
  cookie: string;
  csrfToken: string;
}

interface InjectOptions {
  method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
  url: string;
  payload?: unknown;
  actor?: TestActor | null;
  headers?: Record<string, string>;
}

export interface TestResponse<T = unknown> {
  status: number;
  body: T;
  headers: Record<string, unknown>;
  cookies: { name: string; value: string }[];
}

/**
 * Issue a request the way a browser would: session cookie plus the CSRF
 * header, and an `Origin` matching the configured web origin.
 */
export async function request<T = unknown>(
  options: InjectOptions,
): Promise<TestResponse<T>> {
  const instance = await getApp();
  const headers: Record<string, string> = {
    origin: env.webOrigins[0] ?? 'http://localhost:5173',
    ...options.headers,
  };

  if (options.actor) {
    headers.cookie = options.actor.cookie;
    headers['x-wolff-csrf'] = options.actor.csrfToken;
  }

  const response = await instance.inject({
    method: options.method,
    url: options.url,
    headers,
    ...(options.payload !== undefined ? { payload: options.payload as object } : {}),
  });

  let body: T;
  try {
    body = response.json() as T;
  } catch {
    body = response.body as unknown as T;
  }

  return {
    status: response.statusCode,
    body,
    headers: response.headers as Record<string, unknown>,
    cookies: response.cookies.map((c) => ({ name: c.name, value: c.value })),
  };
}

function cookieHeaderFrom(response: TestResponse): {
  cookie: string;
  csrf: string;
} {
  const session = response.cookies.find((c) => c.name.includes('session'));
  const csrf = response.cookies.find((c) => c.name.includes('csrf'));
  return {
    cookie: [
      session ? `${session.name}=${session.value}` : '',
      csrf ? `${csrf.name}=${csrf.value}` : '',
    ]
      .filter(Boolean)
      .join('; '),
    csrf: csrf?.value ?? '',
  };
}

let actorCounter = 0;

/** Register a new account with a real device identity. */
export async function createActor(
  username?: string,
  password = 'a-strong-test-password-9271',
): Promise<TestActor> {
  actorCounter += 1;
  const name = username ?? `tester_${actorCounter}_${Date.now() % 100_000}`;
  const { secrets, bundle } = createDeviceSecrets('pending', 12);

  const response = await request<{ user: { id: string }; deviceId: string }>({
    method: 'POST',
    url: '/api/auth/register',
    payload: {
      username: name,
      password,
      displayName: `Test ${name}`,
      device: {
        name: 'Vitest',
        platform: 'Linux',
        identityPublicKey: bundle.identityPublicKey,
        signedPreKey: bundle.signedPreKey,
        oneTimePreKeys: bundle.oneTimePreKeys,
      },
    },
  });

  if (response.status !== 201) {
    throw new Error(
      `Registration failed (${response.status}): ${JSON.stringify(response.body)}`,
    );
  }

  const { cookie, csrf } = cookieHeaderFrom(response);
  return {
    userId: response.body.user.id,
    username: name,
    displayName: `Test ${name}`,
    deviceId: response.body.deviceId,
    secrets: { ...secrets, deviceId: response.body.deviceId },
    cookie,
    csrfToken: csrf,
  };
}

/** Sign in an existing account on a brand-new device. */
export async function loginNewDevice(
  username: string,
  password = 'a-strong-test-password-9271',
): Promise<TestActor> {
  const { secrets, bundle } = createDeviceSecrets('pending', 8);
  const response = await request<{ user: { id: string }; deviceId: string }>({
    method: 'POST',
    url: '/api/auth/login',
    payload: {
      username,
      password,
      device: {
        name: 'Vitest second device',
        platform: 'Android',
        identityPublicKey: bundle.identityPublicKey,
        signedPreKey: bundle.signedPreKey,
        oneTimePreKeys: bundle.oneTimePreKeys,
      },
    },
  });
  if (response.status !== 200) {
    throw new Error(
      `Login failed (${response.status}): ${JSON.stringify(response.body)}`,
    );
  }
  const { cookie, csrf } = cookieHeaderFrom(response);
  return {
    userId: response.body.user.id,
    username,
    displayName: username,
    deviceId: response.body.deviceId,
    secrets: { ...secrets, deviceId: response.body.deviceId },
    cookie,
    csrfToken: csrf,
  };
}

/** Open a direct chat between two actors. */
export async function openDirect(a: TestActor, b: TestActor): Promise<string> {
  const response = await request<{ chat: { id: string } }>({
    method: 'POST',
    url: '/api/chats/direct',
    actor: a,
    payload: { userId: b.userId },
  });
  if (response.status !== 201) {
    throw new Error(
      `Could not open chat (${response.status}): ${JSON.stringify(response.body)}`,
    );
  }
  return response.body.chat.id;
}

export async function createGroup(
  owner: TestActor,
  title: string,
  memberIds: string[] = [],
): Promise<string> {
  const response = await request<{ chat: { id: string } }>({
    method: 'POST',
    url: '/api/chats/group',
    actor: owner,
    payload: { title, memberIds },
  });
  if (response.status !== 201) {
    throw new Error(
      `Could not create group (${response.status}): ${JSON.stringify(response.body)}`,
    );
  }
  return response.body.chat.id;
}

/** Claim recipient prekey bundles for a chat, the way a real client does. */
export async function claimBundles(
  actor: TestActor,
  chatId: string,
): Promise<PreKeyBundle[]> {
  const response = await request<{ bundles: PreKeyBundle[] }>({
    method: 'POST',
    url: '/api/keys/claim',
    actor,
    payload: { chatId },
  });
  if (response.status !== 200) {
    throw new Error(
      `Could not claim keys (${response.status}): ${JSON.stringify(response.body)}`,
    );
  }
  return response.body.bundles;
}

export interface SentMessage {
  id: string;
  envelope: EncryptedEnvelope;
  context: EnvelopeContext;
  status: number;
  body: unknown;
}

/** Encrypt and post a message exactly as the web client would. */
export async function sendEncrypted(
  sender: TestActor,
  chatId: string,
  body: string,
  extra: Partial<MessagePlaintext> = {},
): Promise<SentMessage> {
  const bundles = await claimBundles(sender, chatId);
  const messageId = randomId(16);
  const createdAt = Date.now();

  const context: EnvelopeContext = {
    messageId,
    chatId,
    senderUserId: sender.userId,
    senderDeviceId: sender.deviceId,
    createdAt,
  };

  const envelope = encryptMessage(
    { v: 1, body, ...extra },
    context,
    sender.secrets.identityPrivateKey,
    bundles,
  );

  const response = await request({
    method: 'POST',
    url: `/api/chats/${chatId}/messages`,
    actor: sender,
    payload: {
      id: messageId,
      clientId: randomId(12),
      createdAt,
      envelope,
      replyToId: extra.replyToId ?? null,
      attachmentIds: [],
    },
  });

  return {
    id: messageId,
    envelope,
    context,
    status: response.status,
    body: response.body,
  };
}

/** Fetch and decrypt a chat's history from one actor's point of view. */
export async function readDecrypted(
  reader: TestActor,
  chatId: string,
  senderIdentityKeys: Record<string, string>,
): Promise<{ id: string; body: string | null; error?: string }[]> {
  const response = await request<{
    items: {
      id: string;
      senderId: string;
      chatId: string;
      senderDeviceId: string;
      createdAt: string;
      envelope: EncryptedEnvelope | null;
    }[];
  }>({
    method: 'GET',
    url: `/api/chats/${chatId}/messages`,
    actor: reader,
  });

  if (response.status !== 200) {
    throw new Error(
      `Could not read messages (${response.status}): ${JSON.stringify(response.body)}`,
    );
  }

  return response.body.items.map((item) => {
    if (!item.envelope) return { id: item.id, body: null };
    try {
      const { plaintext } = decryptMessage(
        item.envelope,
        {
          messageId: item.id,
          chatId: item.chatId,
          senderUserId: item.senderId,
          senderDeviceId: item.senderDeviceId,
          createdAt: new Date(item.createdAt).getTime(),
        },
        reader.deviceId,
        (preKeyId) => findPrivatePreKey(reader.secrets, preKeyId),
        senderIdentityKeys[item.senderId] ?? '',
      );
      return { id: item.id, body: plaintext.body };
    } catch (err) {
      return { id: item.id, body: null, error: (err as Error).message };
    }
  });
}

/** Map of userId → identity public key, for signature verification in tests. */
export function identityMap(...actors: TestActor[]): Record<string, string> {
  return Object.fromEntries(
    actors.map((a) => [a.userId, a.secrets.identityPublicKey]),
  );
}

/** Sign a device-auth challenge, as a returning client does. */
export async function signChallenge(
  secrets: DeviceSecrets,
  nonce: string,
): Promise<string> {
  await sodium.ready;
  return toB64(
    sodium.crypto_sign_detached(
      Buffer.from(`wolffmsg:device-auth:v1:${nonce}`, 'utf8'),
      Buffer.from(secrets.identityPrivateKey, 'base64'),
    ),
  );
}

export { prisma };
