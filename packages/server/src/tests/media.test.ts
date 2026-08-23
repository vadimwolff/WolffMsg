import fs from 'node:fs/promises';
import path from 'node:path';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import {
  decryptAttachment,
  encryptAttachment,
  encryptedSizeFor,
  initCrypto,
  randomBytes,
  randomId,
  encryptMessage,
} from '@wolffmsg/shared';
import {
  claimBundles,
  closeApp,
  createActor,
  createGroup,
  openDirect,
  prisma,
  request,
  resetDatabase,
  sendEncrypted,
  type TestActor,
} from './helpers.js';
import { env } from '../env.js';
import { newStorageKey } from '../storage/local.js';

beforeEach(async () => {
  await initCrypto();
  await resetDatabase();
});

afterAll(async () => {
  await closeApp();
});

/** Build a multipart body by hand — the suite has no browser FormData. */
function multipart(fieldName: string, filename: string, data: Buffer, mime: string) {
  const boundary = `----wolff${randomId(8).replace(/[^a-zA-Z0-9]/g, '')}`;
  const head = Buffer.from(
    `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="${fieldName}"; filename="${filename}"\r\n` +
      `Content-Type: ${mime}\r\n\r\n`,
    'utf8',
  );
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`, 'utf8');
  return {
    payload: Buffer.concat([head, data, tail]),
    headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
  };
}

async function uploadEncrypted(
  actor: TestActor,
  chatId: string,
  plaintext: Buffer,
  mime = 'image/png',
) {
  const cipher = encryptAttachment(new Uint8Array(plaintext));
  const body = multipart('file', 'anything.bin', Buffer.from(cipher.data), mime);
  const response = await request<{ id: string; encryptedSize: number }>({
    method: 'POST',
    url: `/api/attachments?chatId=${chatId}&mimeType=${encodeURIComponent(mime)}`,
    actor,
    payload: body.payload,
    headers: body.headers,
  });
  return { response, cipher };
}

describe('attachment encryption', () => {
  it('stores only ciphertext on disk', async () => {
    const alice = await createActor();
    const bob = await createActor();
    const chatId = await openDirect(alice, bob);

    const marker = Buffer.from('SECRET-FILE-CONTENT-4471');
    const plaintext = Buffer.concat([Buffer.alloc(2_048), marker, Buffer.alloc(2_048)]);
    const { response } = await uploadEncrypted(alice, chatId, plaintext);
    expect(response.status).toBe(201);

    const row = await prisma.attachment.findUniqueOrThrow({
      where: { id: response.body.id },
      select: { storageKey: true, encryptedSize: true },
    });

    const onDisk = await fs.readFile(path.join(env.storageRoot, row.storageKey));
    expect(onDisk.includes(marker)).toBe(false);
    expect(row.encryptedSize).toBe(encryptedSizeFor(plaintext.length));
  });

  it('round-trips through upload and download', async () => {
    const alice = await createActor();
    const bob = await createActor();
    const chatId = await openDirect(alice, bob);

    const plaintext = Buffer.from(randomBytes(50_000));
    const { response, cipher } = await uploadEncrypted(alice, chatId, plaintext);

    // Attach it to a message so Bob is allowed to fetch it.
    const bundles = await claimBundles(alice, chatId);
    const messageId = randomId(16);
    const createdAt = Date.now();
    const envelope = encryptMessage(
      {
        v: 1,
        body: '',
        attachments: [
          {
            id: response.body.id,
            name: 'photo.png',
            mimeType: 'image/png',
            size: plaintext.length,
            key: cipher.key,
            header: cipher.header,
          },
        ],
      },
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

    const posted = await request({
      method: 'POST',
      url: `/api/chats/${chatId}/messages`,
      actor: alice,
      payload: {
        id: messageId,
        clientId: randomId(12),
        createdAt,
        envelope,
        replyToId: null,
        attachmentIds: [response.body.id],
      },
    });
    expect(posted.status).toBe(201);

    const download = await request<string>({
      method: 'GET',
      url: `/api/attachments/${response.body.id}`,
      actor: bob,
    });
    expect(download.status).toBe(200);

    expect(download.rawBody.length).toBe(encryptedSizeFor(plaintext.length));
    const opened = decryptAttachment(
      new Uint8Array(download.rawBody),
      cipher.key,
      cipher.header,
    );
    expect(Buffer.from(opened).equals(plaintext)).toBe(true);
  });

  it('serves blobs with headers that stop the browser executing them', async () => {
    const alice = await createActor();
    const bob = await createActor();
    const chatId = await openDirect(alice, bob);
    const { response } = await uploadEncrypted(
      alice,
      chatId,
      Buffer.from('<script>alert(1)</script>'),
      'text/plain',
    );

    const download = await request({
      method: 'GET',
      url: `/api/attachments/${response.body.id}`,
      actor: alice,
    });

    expect(download.headers['content-type']).toBe('application/octet-stream');
    expect(download.headers['content-disposition']).toBe('attachment');
    expect(download.headers['x-content-type-options']).toBe('nosniff');
    expect(String(download.headers['content-security-policy'])).toContain('sandbox');
    void bob;
  });
});

describe('attachment access control', () => {
  it('refuses a download to someone outside the chat', async () => {
    const alice = await createActor();
    const bob = await createActor();
    const eve = await createActor();
    const chatId = await openDirect(alice, bob);
    const { response } = await uploadEncrypted(alice, chatId, Buffer.from('private'));

    const download = await request({
      method: 'GET',
      url: `/api/attachments/${response.body.id}`,
      actor: eve,
    });
    expect(download.status).toBe(404);
    void bob;
  });

  it('refuses an unauthenticated download', async () => {
    const alice = await createActor();
    const bob = await createActor();
    const chatId = await openDirect(alice, bob);
    const { response } = await uploadEncrypted(alice, chatId, Buffer.from('private'));

    const download = await request({
      method: 'GET',
      url: `/api/attachments/${response.body.id}`,
    });
    expect(download.status).toBe(401);
    void bob;
  });

  it('cuts off access the moment a member is removed from the group', async () => {
    const owner = await createActor();
    const member = await createActor();
    const groupId = await createGroup(owner, 'Media group', [member.userId]);

    const { response, cipher } = await uploadEncrypted(
      owner,
      groupId,
      Buffer.from(randomBytes(1_000)),
    );

    const bundles = await claimBundles(owner, groupId);
    const messageId = randomId(16);
    const createdAt = Date.now();
    const envelope = encryptMessage(
      {
        v: 1,
        body: '',
        attachments: [
          {
            id: response.body.id,
            name: 'f.bin',
            mimeType: 'image/png',
            size: 1_000,
            key: cipher.key,
            header: cipher.header,
          },
        ],
      },
      {
        messageId,
        chatId: groupId,
        senderUserId: owner.userId,
        senderDeviceId: owner.deviceId,
        createdAt,
      },
      owner.secrets.identityPrivateKey,
      bundles,
    );
    await request({
      method: 'POST',
      url: `/api/chats/${groupId}/messages`,
      actor: owner,
      payload: {
        id: messageId,
        clientId: randomId(12),
        createdAt,
        envelope,
        replyToId: null,
        attachmentIds: [response.body.id],
      },
    });

    expect(
      (
        await request({
          method: 'GET',
          url: `/api/attachments/${response.body.id}`,
          actor: member,
        })
      ).status,
    ).toBe(200);

    await request({
      method: 'DELETE',
      url: `/api/chats/${groupId}/members/${member.userId}`,
      actor: owner,
    });

    expect(
      (
        await request({
          method: 'GET',
          url: `/api/attachments/${response.body.id}`,
          actor: member,
        })
      ).status,
    ).toBe(404);
  });

  it('will not attach another user upload to your own message', async () => {
    const alice = await createActor();
    const bob = await createActor();
    const chatId = await openDirect(alice, bob);
    const { response } = await uploadEncrypted(alice, chatId, Buffer.from('mine'));

    const sent = await sendEncrypted(bob, chatId, 'stealing your file');
    expect(sent.status).toBe(201);

    // Bob tries to claim Alice's blob on a message of his own.
    const bundles = await claimBundles(bob, chatId);
    const messageId = randomId(16);
    const createdAt = Date.now();
    const envelope = encryptMessage(
      { v: 1, body: 'with your file' },
      {
        messageId,
        chatId,
        senderUserId: bob.userId,
        senderDeviceId: bob.deviceId,
        createdAt,
      },
      bob.secrets.identityPrivateKey,
      bundles,
    );
    const theft = await request({
      method: 'POST',
      url: `/api/chats/${chatId}/messages`,
      actor: bob,
      payload: {
        id: messageId,
        clientId: randomId(12),
        createdAt,
        envelope,
        replyToId: null,
        attachmentIds: [response.body.id],
      },
    });
    expect(theft.status).toBe(400);
  });

  it('will not accept an upload into a chat you are not in', async () => {
    const alice = await createActor();
    const bob = await createActor();
    const eve = await createActor();
    const chatId = await openDirect(alice, bob);

    const cipher = encryptAttachment(new Uint8Array(Buffer.from('intrusion')));
    const body = multipart('file', 'x.bin', Buffer.from(cipher.data), 'image/png');
    const response = await request({
      method: 'POST',
      url: `/api/attachments?chatId=${chatId}&mimeType=image%2Fpng`,
      actor: eve,
      payload: body.payload,
      headers: body.headers,
    });
    expect(response.status).toBe(404);
  });

  it('rejects a disallowed MIME type', async () => {
    const alice = await createActor();
    const bob = await createActor();
    const chatId = await openDirect(alice, bob);

    const cipher = encryptAttachment(new Uint8Array(Buffer.from('#!/bin/sh')));
    const body = multipart('file', 'x.sh', Buffer.from(cipher.data), 'application/x-sh');
    const response = await request({
      method: 'POST',
      url: '/api/attachments?chatId=' + chatId + '&mimeType=application%2Fx-sh',
      actor: alice,
      payload: body.payload,
      headers: body.headers,
    });
    expect(response.status).toBe(400);
    void bob;
  });

  it('rejects a MIME type carrying header-injection characters', async () => {
    const alice = await createActor();
    const bob = await createActor();
    const chatId = await openDirect(alice, bob);

    const cipher = encryptAttachment(new Uint8Array(Buffer.from('x')));
    const body = multipart('file', 'x.bin', Buffer.from(cipher.data), 'image/png');
    const response = await request({
      method: 'POST',
      url:
        `/api/attachments?chatId=${chatId}&mimeType=` +
        encodeURIComponent('image/png\r\nX-Injected: yes'),
      actor: alice,
      payload: body.payload,
      headers: body.headers,
    });
    expect(response.status).toBe(400);
    void bob;
  });

  it('deletes the blob from disk when its message is deleted', async () => {
    const alice = await createActor();
    const bob = await createActor();
    const chatId = await openDirect(alice, bob);
    const { response, cipher } = await uploadEncrypted(
      alice,
      chatId,
      Buffer.from(randomBytes(500)),
    );

    const row = await prisma.attachment.findUniqueOrThrow({
      where: { id: response.body.id },
      select: { storageKey: true },
    });
    const filePath = path.join(env.storageRoot, row.storageKey);
    await expect(fs.access(filePath)).resolves.toBeUndefined();

    const bundles = await claimBundles(alice, chatId);
    const messageId = randomId(16);
    const createdAt = Date.now();
    const envelope = encryptMessage(
      {
        v: 1,
        body: '',
        attachments: [
          {
            id: response.body.id,
            name: 'f.bin',
            mimeType: 'image/png',
            size: 500,
            key: cipher.key,
            header: cipher.header,
          },
        ],
      },
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
    await request({
      method: 'POST',
      url: `/api/chats/${chatId}/messages`,
      actor: alice,
      payload: {
        id: messageId,
        clientId: randomId(12),
        createdAt,
        envelope,
        replyToId: null,
        attachmentIds: [response.body.id],
      },
    });

    await request({ method: 'DELETE', url: `/api/messages/${messageId}`, actor: alice });

    await expect(fs.access(filePath)).rejects.toThrow();
    expect(await prisma.attachment.count({ where: { id: response.body.id } })).toBe(0);
    void bob;
  });
});

describe('storage keys', () => {
  it('are random, never derived from user input', () => {
    const keys = new Set(Array.from({ length: 500 }, () => newStorageKey()));
    expect(keys.size).toBe(500);
    for (const key of keys) {
      expect(key).toMatch(/^[0-9a-f]{2}\/[0-9a-f]{2}\/[0-9a-f]{56}$/);
      expect(key).not.toContain('..');
    }
  });

  it('never escape the storage root', async () => {
    const alice = await createActor();
    const bob = await createActor();
    const chatId = await openDirect(alice, bob);
    await uploadEncrypted(alice, chatId, Buffer.from('x'));

    const rows = await prisma.attachment.findMany({ select: { storageKey: true } });
    for (const row of rows) {
      const resolved = path.resolve(env.storageRoot, row.storageKey);
      expect(resolved.startsWith(env.storageRoot + path.sep)).toBe(true);
    }
    void bob;
  });
});

describe('avatars', () => {
  /** A one-pixel PNG, with a genuine PNG signature. */
  const PNG = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    'base64',
  );

  it('accepts a real PNG', async () => {
    const alice = await createActor();
    const body = multipart('file', 'me.png', PNG, 'image/png');
    const response = await request<{ user: { avatarUrl: string | null } }>({
      method: 'POST',
      url: '/api/me/avatar',
      actor: alice,
      payload: body.payload,
      headers: body.headers,
    });
    expect(response.status).toBe(200);
    expect(response.body.user.avatarUrl).toMatch(/^\/api\/avatars\//);
  });

  it('rejects a file whose bytes do not match the declared type', async () => {
    const alice = await createActor();
    const svg = Buffer.from('<svg onload="alert(1)" xmlns="http://www.w3.org/2000/svg"/>');
    const body = multipart('file', 'evil.png', svg, 'image/png');
    const response = await request({
      method: 'POST',
      url: '/api/me/avatar',
      actor: alice,
      payload: body.payload,
      headers: body.headers,
    });
    expect(response.status).toBe(400);
  });

  it('rejects an SVG outright', async () => {
    const alice = await createActor();
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>');
    const body = multipart('file', 'x.svg', svg, 'image/svg+xml');
    const response = await request({
      method: 'POST',
      url: '/api/me/avatar',
      actor: alice,
      payload: body.payload,
      headers: body.headers,
    });
    expect(response.status).toBe(400);
  });

  it('honours avatar visibility on every fetch', async () => {
    const shy = await createActor();
    const stranger = await createActor();

    const body = multipart('file', 'me.png', PNG, 'image/png');
    const upload = await request<{ user: { avatarUrl: string } }>({
      method: 'POST',
      url: '/api/me/avatar',
      actor: shy,
      payload: body.payload,
      headers: body.headers,
    });
    const url = upload.body.user.avatarUrl;

    expect((await request({ method: 'GET', url, actor: stranger })).status).toBe(200);

    await request({
      method: 'PATCH',
      url: '/api/me/privacy',
      actor: shy,
      payload: { avatarVisibility: 'nobody' },
    });

    expect((await request({ method: 'GET', url, actor: stranger })).status).toBe(404);
    // The owner can still see their own.
    expect((await request({ method: 'GET', url, actor: shy })).status).toBe(200);
  });

  it('refuses a path-traversal avatar key', async () => {
    const alice = await createActor();
    for (const key of [
      '../../../etc/passwd',
      '..%2f..%2fetc%2fpasswd',
      'aa/bb/../../../../etc/passwd',
    ]) {
      const response = await request({
        method: 'GET',
        url: `/api/avatars/${key}`,
        actor: alice,
      });
      expect(response.status).toBe(404);
    }
  });
});

describe('orphan sweeping', () => {
  it('removes uploads that were never attached to a message', async () => {
    const alice = await createActor();
    const bob = await createActor();
    const chatId = await openDirect(alice, bob);
    const { response } = await uploadEncrypted(alice, chatId, Buffer.from('orphan'));

    // Age it past the sweep threshold.
    await prisma.attachment.update({
      where: { id: response.body.id },
      data: { createdAt: new Date(Date.now() - 24 * 60 * 60 * 1000) },
    });

    const { sweepOrphanAttachments } = await import('../services/attachments.js');
    const removed = await sweepOrphanAttachments();
    expect(removed).toBe(1);
    expect(await prisma.attachment.count({ where: { id: response.body.id } })).toBe(0);
    void bob;
  });

  it('leaves attached uploads alone', async () => {
    const alice = await createActor();
    const bob = await createActor();
    const chatId = await openDirect(alice, bob);
    const sent = await sendEncrypted(alice, chatId, 'plain message');
    expect(sent.status).toBe(201);

    const { sweepOrphanAttachments } = await import('../services/attachments.js');
    expect(await sweepOrphanAttachments()).toBe(0);
    void bob;
  });
});
