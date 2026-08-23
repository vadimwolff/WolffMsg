import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import {
  decryptMessage,
  encryptMessage,
  findPrivatePreKey,
  randomId,
  type EncryptedEnvelope,
  type PreKeyBundle,
} from '@wolffmsg/shared';
import {
  claimBundles,
  closeApp,
  createActor,
  identityMap,
  loginNewDevice,
  openDirect,
  prisma,
  readDecrypted,
  request,
  resetDatabase,
  sendEncrypted,
} from './helpers.js';

/**
 * The end-to-end encryption contract, tested against the real database.
 *
 * These are the tests that matter most: if any of them starts passing for the
 * wrong reason, the product's central claim is false.
 */

beforeEach(async () => {
  await resetDatabase();
});

afterAll(async () => {
  await closeApp();
});

describe('the server cannot read messages', () => {
  it('stores ciphertext, never plaintext', async () => {
    const alice = await createActor();
    const bob = await createActor();
    const chatId = await openDirect(alice, bob);

    const secret = 'CANARY-PLAINTEXT-b81f2e-встреча в полночь';
    const sent = await sendEncrypted(alice, chatId, secret);
    expect(sent.status).toBe(201);

    const row = await prisma.message.findUniqueOrThrow({
      where: { id: sent.id },
      include: { keys: true },
    });

    expect(row.ciphertext).not.toBeNull();
    const stored = Buffer.from(row.ciphertext!);
    expect(stored.includes(Buffer.from(secret, 'utf8'))).toBe(false);
    expect(stored.toString('utf8')).not.toContain('CANARY');
    expect(stored.toString('base64')).not.toContain(
      Buffer.from(secret, 'utf8').toString('base64'),
    );
  });

  it('has no plaintext column anywhere in the messages table', async () => {
    const columns = await prisma.$queryRaw<{ column_name: string }[]>`
      SELECT column_name FROM information_schema.columns
       WHERE table_name = 'messages'
    `;
    const names = columns.map((c) => c.column_name.toLowerCase());
    for (const forbidden of ['body', 'text', 'content', 'plaintext', 'message']) {
      expect(names).not.toContain(forbidden);
    }
    expect(names).toContain('ciphertext');
  });

  it('leaves no trace of the plaintext anywhere in the database', async () => {
    const alice = await createActor();
    const bob = await createActor();
    const chatId = await openDirect(alice, bob);
    const secret = 'ZEBRA-QUARTZ-CANARY-77213';
    await sendEncrypted(alice, chatId, secret);

    // Sweep every text-ish column of every table for the marker.
    const textColumns = await prisma.$queryRaw<
      { table_name: string; column_name: string }[]
    >`
      SELECT table_name, column_name
        FROM information_schema.columns
       WHERE table_schema = 'public'
         AND data_type IN ('text', 'character varying', 'jsonb')
    `;

    for (const column of textColumns) {
      const hits = await prisma.$queryRawUnsafe<{ n: bigint }[]>(
        `SELECT COUNT(*)::bigint AS n FROM "${column.table_name}" ` +
          `WHERE "${column.column_name}"::text LIKE $1`,
        `%${secret}%`,
      );
      expect(
        Number(hits[0]?.n ?? 0),
        `${column.table_name}.${column.column_name} contains the plaintext`,
      ).toBe(0);
    }
  });

  it('never stores a private key', async () => {
    const alice = await createActor();
    const bob = await createActor();
    const chatId = await openDirect(alice, bob);
    await sendEncrypted(alice, chatId, 'hello');

    const priv = alice.secrets.identityPrivateKey;
    const preKeyPriv = alice.secrets.signedPreKey.privateKey;

    const devices = await prisma.device.findMany();
    const preKeys = await prisma.preKey.findMany();
    const dump = JSON.stringify([devices, preKeys]);

    expect(dump).not.toContain(priv);
    expect(dump).not.toContain(preKeyPriv);
    // Only the 32-byte public half is stored.
    for (const device of devices) expect(device.identityPublicKey.length).toBe(32);
    for (const key of preKeys) expect(key.publicKey.length).toBe(32);
  });
});

describe('round trip', () => {
  it('delivers a message the recipient can decrypt', async () => {
    const alice = await createActor();
    const bob = await createActor();
    const chatId = await openDirect(alice, bob);

    await sendEncrypted(alice, chatId, 'Ночью выдвигаемся. 🐺');

    const read = await readDecrypted(bob, chatId, identityMap(alice, bob));
    expect(read).toHaveLength(1);
    expect(read[0]!.body).toBe('Ночью выдвигаемся. 🐺');
  });

  it('reaches every device the sender owns as well as the recipient', async () => {
    const alice = await createActor('wolf_multi_sender');
    const bob = await createActor();
    const chatId = await openDirect(alice, bob);

    // Alice signs in on a second device *before* sending.
    const aliceLaptop = await loginNewDevice('wolf_multi_sender');

    await sendEncrypted(alice, chatId, 'Sent from my phone');

    const onLaptop = await readDecrypted(aliceLaptop, chatId, identityMap(alice, bob));
    expect(onLaptop[0]!.body).toBe('Sent from my phone');

    const onBob = await readDecrypted(bob, chatId, identityMap(alice, bob));
    expect(onBob[0]!.body).toBe('Sent from my phone');
  });

  it('hands each device only its own wrapped key', async () => {
    const alice = await createActor();
    const bob = await createActor();
    const chatId = await openDirect(alice, bob);
    await sendEncrypted(alice, chatId, 'one key each');

    const response = await request<{
      items: { envelope: EncryptedEnvelope | null }[];
    }>({ method: 'GET', url: `/api/chats/${chatId}/messages`, actor: bob });

    const envelope = response.body.items[0]!.envelope!;
    expect(envelope.keys).toHaveLength(1);
    expect(envelope.keys[0]!.deviceId).toBe(bob.deviceId);
  });

  it('carries structured content such as replies intact', async () => {
    const alice = await createActor();
    const bob = await createActor();
    const chatId = await openDirect(alice, bob);

    const first = await sendEncrypted(alice, chatId, 'Original');
    const reply = await sendEncrypted(bob, chatId, 'A reply', {
      replyToId: first.id,
    });
    expect(reply.status).toBe(201);

    const stored = await prisma.message.findUniqueOrThrow({
      where: { id: reply.id },
      select: { replyToId: true },
    });
    expect(stored.replyToId).toBe(first.id);
  });
});

describe('forward secrecy', () => {
  it('consumes a one-time prekey, never issuing it twice', async () => {
    const alice = await createActor();
    const bob = await createActor();
    const chatId = await openDirect(alice, bob);

    const first = await claimBundles(alice, chatId);
    const second = await claimBundles(alice, chatId);

    const firstKey = first.find((b) => b.deviceId === bob.deviceId)?.oneTimePreKey;
    const secondKey = second.find((b) => b.deviceId === bob.deviceId)?.oneTimePreKey;

    expect(firstKey).toBeTruthy();
    expect(secondKey).toBeTruthy();
    expect(firstKey!.id).not.toBe(secondKey!.id);
  });

  it('never issues the same one-time prekey under concurrent claims', async () => {
    const alice = await createActor();
    const bob = await createActor();
    const chatId = await openDirect(alice, bob);

    // Ten senders racing for Bob's keys at once.
    const results = await Promise.all(
      Array.from({ length: 10 }, () => claimBundles(alice, chatId)),
    );

    const issued = results
      .flat()
      .filter((b) => b.deviceId === bob.deviceId)
      .map((b) => b.oneTimePreKey?.id)
      .filter((id): id is string => Boolean(id));

    expect(issued.length).toBeGreaterThan(0);
    expect(new Set(issued).size).toBe(issued.length);
  });

  it('falls back to the signed prekey once one-time keys run out', async () => {
    const alice = await createActor();
    const bob = await createActor();
    const chatId = await openDirect(alice, bob);

    // Drain Bob's supply.
    await prisma.preKey.updateMany({
      where: { deviceId: bob.deviceId, kind: 'onetime' },
      data: { claimedAt: new Date() },
    });

    const bundles = await claimBundles(alice, chatId);
    const bobBundle = bundles.find((b) => b.deviceId === bob.deviceId)!;
    expect(bobBundle.oneTimePreKey).toBeNull();

    // Communication continues, using the signed prekey.
    await sendEncrypted(alice, chatId, 'still reaches you');
    const read = await readDecrypted(bob, chatId, identityMap(alice, bob));
    expect(read[0]!.body).toBe('still reaches you');
  });

  it('lets a device top up its one-time prekeys', async () => {
    const bob = await createActor();
    const { replenishOneTimePreKeys } = await import('@wolffmsg/shared');
    const { published } = replenishOneTimePreKeys(bob.secrets, 5);

    const response = await request<{ stored: number; total: number }>({
      method: 'POST',
      url: '/api/keys/one-time',
      actor: bob,
      payload: { preKeys: published },
    });
    expect(response.status).toBe(200);
    expect(response.body.stored).toBe(5);
    expect(response.body.total).toBe(17);
  });

  it('refuses a top-up signed by a different identity', async () => {
    const bob = await createActor();
    const impostor = await createActor();
    const { replenishOneTimePreKeys } = await import('@wolffmsg/shared');
    const { published } = replenishOneTimePreKeys(impostor.secrets, 3);

    const response = await request({
      method: 'POST',
      url: '/api/keys/one-time',
      actor: bob,
      payload: { preKeys: published },
    });
    expect(response.status).toBe(400);
  });
});

describe('envelope integrity', () => {
  it('rejects a wrapped key addressed to a device outside the chat', async () => {
    const alice = await createActor();
    const bob = await createActor();
    const eve = await createActor();
    const chatId = await openDirect(alice, bob);

    const bundles = await claimBundles(alice, chatId);
    // Claim Eve's bundle through a separate conversation, then try to smuggle
    // it into Alice and Bob's chat.
    const eveChat = await openDirect(alice, eve);
    const eveBundles = await claimBundles(alice, eveChat);
    const eveBundle = eveBundles.find((b) => b.deviceId === eve.deviceId)!;

    const messageId = randomId(16);
    const createdAt = Date.now();
    const envelope = encryptMessage(
      { v: 1, body: 'not for eve' },
      {
        messageId,
        chatId,
        senderUserId: alice.userId,
        senderDeviceId: alice.deviceId,
        createdAt,
      },
      alice.secrets.identityPrivateKey,
      [...bundles, eveBundle],
    );

    const response = await request({
      method: 'POST',
      url: `/api/chats/${chatId}/messages`,
      actor: alice,
      payload: {
        id: messageId,
        clientId: randomId(12),
        createdAt,
        envelope,
        replyToId: null,
        attachmentIds: [],
      },
    });
    expect(response.status).toBe(201);

    // Eve's key was dropped on the way in.
    const keys = await prisma.messageKey.findMany({ where: { messageId } });
    expect(keys.map((k) => k.deviceId)).not.toContain(eve.deviceId);
  });

  it('rejects a malformed wrapped key', async () => {
    const alice = await createActor();
    const bob = await createActor();
    const chatId = await openDirect(alice, bob);
    const bundles = await claimBundles(alice, chatId);

    const messageId = randomId(16);
    const createdAt = Date.now();
    const envelope = encryptMessage(
      { v: 1, body: 'x' },
      {
        messageId,
        chatId,
        senderUserId: alice.userId,
        senderDeviceId: alice.deviceId,
        createdAt,
      },
      alice.secrets.identityPrivateKey,
      bundles,
    );
    envelope.keys[0]!.wrapped = Buffer.from('too short').toString('base64');

    const response = await request({
      method: 'POST',
      url: `/api/chats/${chatId}/messages`,
      actor: alice,
      payload: {
        id: messageId,
        clientId: randomId(12),
        createdAt,
        envelope,
        replyToId: null,
        attachmentIds: [],
      },
    });
    expect(response.status).toBe(400);
  });

  it('rejects a message dated far in the past or future', async () => {
    const alice = await createActor();
    const bob = await createActor();
    const chatId = await openDirect(alice, bob);
    const bundles = await claimBundles(alice, chatId);

    for (const offset of [-86_400_000, 86_400_000]) {
      const messageId = randomId(16);
      const createdAt = Date.now() + offset;
      const envelope = encryptMessage(
        { v: 1, body: 'time travel' },
        {
          messageId,
          chatId,
          senderUserId: alice.userId,
          senderDeviceId: alice.deviceId,
          createdAt,
        },
        alice.secrets.identityPrivateKey,
        bundles,
      );
      const response = await request({
        method: 'POST',
        url: `/api/chats/${chatId}/messages`,
        actor: alice,
        payload: {
          id: messageId,
          clientId: randomId(12),
          createdAt,
          envelope,
          replyToId: null,
          attachmentIds: [],
        },
      });
      expect(response.status).toBe(400);
    }
  });

  it('detects a server that tampers with stored ciphertext', async () => {
    const alice = await createActor();
    const bob = await createActor();
    const chatId = await openDirect(alice, bob);
    const sent = await sendEncrypted(alice, chatId, 'original text');

    // Simulate a hostile operator editing the row directly.
    const row = await prisma.message.findUniqueOrThrow({
      where: { id: sent.id },
      select: { ciphertext: true },
    });
    const tampered = Buffer.from(row.ciphertext!);
    tampered[5] = (tampered[5]! ^ 0xff) & 0xff;
    await prisma.message.update({
      where: { id: sent.id },
      data: { ciphertext: Uint8Array.from(tampered) },
    });

    const read = await readDecrypted(bob, chatId, identityMap(alice, bob));
    expect(read[0]!.body).toBeNull();
    expect(read[0]!.error).toMatch(/signature|altered/i);
  });

  it('detects a server that moves a ciphertext into another chat', async () => {
    const alice = await createActor();
    const bob = await createActor();
    const chatId = await openDirect(alice, bob);
    const otherChat = await openDirect(bob, alice); // same chat, idempotent
    expect(otherChat).toBe(chatId);

    const sent = await sendEncrypted(alice, chatId, 'context bound');

    // Decrypting with a forged context must fail.
    const envelope = sent.envelope;
    expect(() =>
      decryptMessage(
        envelope,
        { ...sent.context, chatId: 'some-other-chat' },
        bob.deviceId,
        (id) => findPrivatePreKey(bob.secrets, id),
        alice.secrets.identityPublicKey,
      ),
    ).toThrowError();
  });
});

describe('idempotency', () => {
  it('does not duplicate a retried send', async () => {
    const alice = await createActor();
    const bob = await createActor();
    const chatId = await openDirect(alice, bob);

    const bundles = await claimBundles(alice, chatId);
    const messageId = randomId(16);
    const clientId = randomId(12);
    const createdAt = Date.now();
    const envelope = encryptMessage(
      { v: 1, body: 'sent once' },
      {
        messageId,
        chatId,
        senderUserId: alice.userId,
        senderDeviceId: alice.deviceId,
        createdAt,
      },
      alice.secrets.identityPrivateKey,
      bundles,
    );
    const payload = {
      id: messageId,
      clientId,
      createdAt,
      envelope,
      replyToId: null,
      attachmentIds: [],
    };
    const url = `/api/chats/${chatId}/messages`;

    const first = await request<{ deduplicated: boolean }>({
      method: 'POST',
      url,
      actor: alice,
      payload,
    });
    const retry = await request<{ deduplicated: boolean }>({
      method: 'POST',
      url,
      actor: alice,
      payload,
    });

    expect(first.status).toBe(201);
    expect(retry.status).toBe(200);
    expect(retry.body.deduplicated).toBe(true);
    expect(await prisma.message.count({ where: { chatId } })).toBe(1);
  });

  it('does not duplicate under a concurrent double-submit', async () => {
    const alice = await createActor();
    const bob = await createActor();
    const chatId = await openDirect(alice, bob);
    const bundles = await claimBundles(alice, chatId);

    const messageId = randomId(16);
    const clientId = randomId(12);
    const createdAt = Date.now();
    const envelope = encryptMessage(
      { v: 1, body: 'raced' },
      {
        messageId,
        chatId,
        senderUserId: alice.userId,
        senderDeviceId: alice.deviceId,
        createdAt,
      },
      alice.secrets.identityPrivateKey,
      bundles,
    );
    const payload = {
      id: messageId,
      clientId,
      createdAt,
      envelope,
      replyToId: null,
      attachmentIds: [],
    };

    const results = await Promise.all([
      request({ method: 'POST', url: `/api/chats/${chatId}/messages`, actor: alice, payload }),
      request({ method: 'POST', url: `/api/chats/${chatId}/messages`, actor: alice, payload }),
    ]);

    for (const result of results) {
      expect([200, 201, 409]).toContain(result.status);
    }
    expect(await prisma.message.count({ where: { chatId } })).toBe(1);
  });
});

describe('key verification', () => {
  it('exposes only public identity keys', async () => {
    const alice = await createActor();
    const bob = await createActor();
    await openDirect(alice, bob);

    const response = await request<{
      devices: { deviceId: string; identityPublicKey: string }[];
    }>({ method: 'GET', url: `/api/users/${bob.userId}/identity`, actor: alice });

    expect(response.status).toBe(200);
    expect(response.body.devices[0]!.identityPublicKey).toBe(
      bob.secrets.identityPublicKey,
    );
    expect(JSON.stringify(response.body)).not.toContain(
      bob.secrets.identityPrivateKey,
    );
  });

  it('records a verification only for a key the peer really published', async () => {
    const alice = await createActor();
    const bob = await createActor();
    await openDirect(alice, bob);
    await request({
      method: 'POST',
      url: '/api/contacts',
      actor: alice,
      payload: { userId: bob.userId },
    });

    const good = await request({
      method: 'POST',
      url: `/api/contacts/${bob.userId}/verify`,
      actor: alice,
      payload: { identityPublicKey: bob.secrets.identityPublicKey },
    });
    expect(good.status).toBe(200);

    const impostor = await createActor();
    const bad = await request({
      method: 'POST',
      url: `/api/contacts/${bob.userId}/verify`,
      actor: alice,
      payload: { identityPublicKey: impostor.secrets.identityPublicKey },
    });
    expect(bad.status).toBe(400);
  });

  it('flags a contact whose identity key changed after verification', async () => {
    const alice = await createActor();
    const bob = await createActor('wolf_keychange');
    await openDirect(alice, bob);
    await request({
      method: 'POST',
      url: '/api/contacts',
      actor: alice,
      payload: { userId: bob.userId },
    });
    await request({
      method: 'POST',
      url: `/api/contacts/${bob.userId}/verify`,
      actor: alice,
      payload: { identityPublicKey: bob.secrets.identityPublicKey },
    });

    // Bob's device is replaced — a new identity key appears.
    await prisma.device.update({
      where: { id: bob.deviceId },
      data: { removedAt: new Date() },
    });
    await loginNewDevice('wolf_keychange');

    const contacts = await request<{
      contacts: { identityChangedAt: string | null }[];
    }>({ method: 'GET', url: '/api/contacts', actor: alice });

    expect(contacts.body.contacts[0]!.identityChangedAt).not.toBeNull();
  });
});

describe('prekey access control', () => {
  it('will not hand out keys for a chat you are not in', async () => {
    const alice = await createActor();
    const bob = await createActor();
    const eve = await createActor();
    const chatId = await openDirect(alice, bob);

    const response = await request({
      method: 'POST',
      url: '/api/keys/claim',
      actor: eve,
      payload: { chatId },
    });
    expect(response.status).toBe(404);
  });

  it('will not let a stranger drain another user prekeys', async () => {
    const eve = await createActor();
    const bob = await createActor();

    const response = await request({
      method: 'POST',
      url: '/api/keys/claim-user',
      actor: eve,
      payload: { userId: bob.userId },
    });
    expect(response.status).toBe(403);

    const remaining = await prisma.preKey.count({
      where: { deviceId: bob.deviceId, kind: 'onetime', claimedAt: null },
    });
    expect(remaining).toBe(12);
  });

  it('signs every bundle it hands out', async () => {
    const alice = await createActor();
    const bob = await createActor();
    const chatId = await openDirect(alice, bob);

    const bundles: PreKeyBundle[] = await claimBundles(alice, chatId);
    const { verifyPreKeyBundle } = await import('@wolffmsg/shared');
    for (const bundle of bundles) {
      expect(verifyPreKeyBundle(bundle)).toBe(true);
    }
  });
});
