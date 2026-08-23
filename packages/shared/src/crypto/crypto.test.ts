import { beforeAll, describe, expect, it } from 'vitest';
import { fromB64, initCrypto, randomBytes, toB64, utf8 } from './sodium.js';
import {
  createDeviceSecrets,
  consumeOneTimePreKey,
  findPrivatePreKey,
  newDeviceId,
  replenishOneTimePreKeys,
  rotateSignedPreKey,
  verifyPreKey,
  verifyPreKeyBundle,
  type PreKeyBundle,
} from './identity.js';
import {
  DecryptionError,
  RecipientKeyError,
  decryptMessage,
  encryptMessage,
  type EnvelopeContext,
  type MessagePlaintext,
} from './envelope.js';
import {
  AttachmentDecryptionError,
  decryptAttachment,
  encryptAttachment,
  encryptedSizeFor,
} from './attachment.js';
import { deviceFingerprint, safetyNumber } from './safety.js';
import { VaultUnlockError, exportVault, importVault } from './vault.js';

beforeAll(async () => {
  await initCrypto();
});

/** Build a signed prekey bundle the way the server would serve one. */
function bundleFor(
  userId: string,
  device: ReturnType<typeof createDeviceSecrets>,
  deviceId: string,
  useOneTime = true,
): PreKeyBundle {
  const otp = device.bundle.oneTimePreKeys[0];
  return {
    deviceId,
    userId,
    identityPublicKey: device.bundle.identityPublicKey,
    signedPreKey: device.bundle.signedPreKey,
    oneTimePreKey: useOneTime && otp ? otp : null,
  };
}

function ctxFor(overrides: Partial<EnvelopeContext> = {}): EnvelopeContext {
  return {
    messageId: 'msg_01',
    chatId: 'chat_01',
    senderUserId: 'user_alice',
    senderDeviceId: 'dev_alice',
    createdAt: 1_700_000_000_000,
    ...overrides,
  };
}

describe('device identity', () => {
  it('generates an identity, a signed prekey and a batch of one-time prekeys', () => {
    const { secrets, bundle } = createDeviceSecrets('dev_a', 10);
    expect(bundle.oneTimePreKeys).toHaveLength(10);
    expect(secrets.oneTimePreKeys).toHaveLength(10);
    expect(fromB64(secrets.identityPublicKey)).toHaveLength(32);
    expect(fromB64(secrets.identityPrivateKey)).toHaveLength(64);
  });

  it('signs every published prekey with the identity key', () => {
    const { bundle } = createDeviceSecrets('dev_a', 5);
    expect(verifyPreKey(bundle.identityPublicKey, bundle.signedPreKey)).toBe(true);
    for (const otp of bundle.oneTimePreKeys) {
      expect(verifyPreKey(bundle.identityPublicKey, otp)).toBe(true);
    }
  });

  it('rejects a prekey signed by a different identity', () => {
    const a = createDeviceSecrets('dev_a', 1);
    const b = createDeviceSecrets('dev_b', 1);
    expect(verifyPreKey(a.bundle.identityPublicKey, b.bundle.signedPreKey)).toBe(
      false,
    );
  });

  it('rejects a prekey whose public key was swapped after signing', () => {
    const a = createDeviceSecrets('dev_a', 1);
    const attacker = createDeviceSecrets('dev_x', 1);
    const forged = {
      ...a.bundle.signedPreKey,
      publicKey: attacker.bundle.signedPreKey.publicKey,
    };
    expect(verifyPreKey(a.bundle.identityPublicKey, forged)).toBe(false);
  });

  it('rejects a bundle whose one-time prekey is forged', () => {
    const a = createDeviceSecrets('dev_a', 2);
    const attacker = createDeviceSecrets('dev_x', 2);
    const bundle = bundleFor('user_a', a, 'dev_a');
    bundle.oneTimePreKey = attacker.bundle.oneTimePreKeys[0]!;
    expect(verifyPreKeyBundle(bundle)).toBe(false);
  });

  it('replenishes and rotates keys without losing the identity', () => {
    const start = createDeviceSecrets('dev_a', 2);
    const topped = replenishOneTimePreKeys(start.secrets, 3);
    expect(topped.secrets.oneTimePreKeys).toHaveLength(5);
    expect(topped.published).toHaveLength(3);

    const rotated = rotateSignedPreKey(topped.secrets);
    expect(rotated.secrets.identityPublicKey).toBe(start.secrets.identityPublicKey);
    expect(rotated.secrets.signedPreKey.id).not.toBe(start.secrets.signedPreKey.id);
    expect(
      verifyPreKey(rotated.secrets.identityPublicKey, rotated.published),
    ).toBe(true);
  });

  it('produces unique device ids', () => {
    const ids = new Set(Array.from({ length: 200 }, () => newDeviceId()));
    expect(ids.size).toBe(200);
  });
});

describe('message encryption', () => {
  const message: MessagePlaintext = {
    v: 1,
    body: 'Ночью выдвигаемся. 🐺',
    replyToId: 'msg_00',
  };

  it('round-trips a message to a recipient device', () => {
    const alice = createDeviceSecrets('dev_alice', 3);
    const bob = createDeviceSecrets('dev_bob', 3);
    const ctx = ctxFor();

    const envelope = encryptMessage(
      message,
      ctx,
      alice.secrets.identityPrivateKey,
      [bundleFor('user_bob', bob, 'dev_bob')],
    );

    const { plaintext } = decryptMessage(
      envelope,
      ctx,
      'dev_bob',
      (id) => findPrivatePreKey(bob.secrets, id),
      alice.secrets.identityPublicKey,
    );
    expect(plaintext.body).toBe(message.body);
    expect(plaintext.replyToId).toBe('msg_00');
  });

  it('never places plaintext in the wire envelope', () => {
    const alice = createDeviceSecrets('dev_alice', 2);
    const bob = createDeviceSecrets('dev_bob', 2);
    const secret = 'TOP-SECRET-CANARY-6f2c1a';
    const envelope = encryptMessage(
      { v: 1, body: secret },
      ctxFor(),
      alice.secrets.identityPrivateKey,
      [bundleFor('user_bob', bob, 'dev_bob')],
    );
    const serialized = JSON.stringify(envelope);
    expect(serialized).not.toContain(secret);
    expect(serialized).not.toContain(alice.secrets.identityPrivateKey);
    // Base64 of the plaintext must not appear either.
    expect(serialized).not.toContain(toB64(utf8(secret)));
  });

  it('encrypts to several devices at once, including the sender fan-out', () => {
    const alice1 = createDeviceSecrets('dev_alice1', 2);
    const alice2 = createDeviceSecrets('dev_alice2', 2);
    const bob1 = createDeviceSecrets('dev_bob1', 2);
    const bob2 = createDeviceSecrets('dev_bob2', 2);
    const ctx = ctxFor({ senderDeviceId: 'dev_alice1' });

    const envelope = encryptMessage(
      message,
      ctx,
      alice1.secrets.identityPrivateKey,
      [
        bundleFor('user_alice', alice2, 'dev_alice2'),
        bundleFor('user_bob', bob1, 'dev_bob1'),
        bundleFor('user_bob', bob2, 'dev_bob2'),
      ],
    );

    expect(envelope.keys).toHaveLength(3);
    for (const [deviceId, device] of [
      ['dev_alice2', alice2],
      ['dev_bob1', bob1],
      ['dev_bob2', bob2],
    ] as const) {
      const { plaintext } = decryptMessage(
        envelope,
        ctx,
        deviceId,
        (id) => findPrivatePreKey(device.secrets, id),
        alice1.secrets.identityPublicKey,
      );
      expect(plaintext.body).toBe(message.body);
    }
  });

  it('refuses to decrypt for a device it was not addressed to', () => {
    const alice = createDeviceSecrets('dev_alice', 2);
    const bob = createDeviceSecrets('dev_bob', 2);
    const eve = createDeviceSecrets('dev_eve', 2);
    const ctx = ctxFor();
    const envelope = encryptMessage(
      message,
      ctx,
      alice.secrets.identityPrivateKey,
      [bundleFor('user_bob', bob, 'dev_bob')],
    );

    expect(() =>
      decryptMessage(
        envelope,
        ctx,
        'dev_eve',
        (id) => findPrivatePreKey(eve.secrets, id),
        alice.secrets.identityPublicKey,
      ),
    ).toThrowError(DecryptionError);
  });

  it('fails when the ciphertext is tampered with', () => {
    const alice = createDeviceSecrets('dev_alice', 2);
    const bob = createDeviceSecrets('dev_bob', 2);
    const ctx = ctxFor();
    const envelope = encryptMessage(
      message,
      ctx,
      alice.secrets.identityPrivateKey,
      [bundleFor('user_bob', bob, 'dev_bob')],
    );

    const raw = fromB64(envelope.ciphertext);
    raw[3] = (raw[3]! ^ 0xff) & 0xff;
    const tampered = { ...envelope, ciphertext: toB64(raw) };

    expect(() =>
      decryptMessage(
        tampered,
        ctx,
        'dev_bob',
        (id) => findPrivatePreKey(bob.secrets, id),
        alice.secrets.identityPublicKey,
      ),
    ).toThrowError(/signature|altered/i);
  });

  it('fails when the server tries to move a ciphertext into another chat', () => {
    const alice = createDeviceSecrets('dev_alice', 2);
    const bob = createDeviceSecrets('dev_bob', 2);
    const ctx = ctxFor();
    const envelope = encryptMessage(
      message,
      ctx,
      alice.secrets.identityPrivateKey,
      [bundleFor('user_bob', bob, 'dev_bob')],
    );

    expect(() =>
      decryptMessage(
        envelope,
        { ...ctx, chatId: 'chat_evil' },
        'dev_bob',
        (id) => findPrivatePreKey(bob.secrets, id),
        alice.secrets.identityPublicKey,
      ),
    ).toThrowError(DecryptionError);
  });

  it('fails when the server re-attributes the message to another sender', () => {
    const alice = createDeviceSecrets('dev_alice', 2);
    const bob = createDeviceSecrets('dev_bob', 2);
    const ctx = ctxFor();
    const envelope = encryptMessage(
      message,
      ctx,
      alice.secrets.identityPrivateKey,
      [bundleFor('user_bob', bob, 'dev_bob')],
    );

    expect(() =>
      decryptMessage(
        envelope,
        { ...ctx, senderUserId: 'user_mallory' },
        'dev_bob',
        (id) => findPrivatePreKey(bob.secrets, id),
        alice.secrets.identityPublicKey,
      ),
    ).toThrowError(DecryptionError);
  });

  it('rejects a message signed by an unexpected identity key', () => {
    const alice = createDeviceSecrets('dev_alice', 2);
    const mallory = createDeviceSecrets('dev_mallory', 2);
    const bob = createDeviceSecrets('dev_bob', 2);
    const ctx = ctxFor();

    // Mallory encrypts to Bob but Bob has Alice's identity key pinned.
    const envelope = encryptMessage(
      message,
      ctx,
      mallory.secrets.identityPrivateKey,
      [bundleFor('user_bob', bob, 'dev_bob')],
    );

    expect(() =>
      decryptMessage(
        envelope,
        ctx,
        'dev_bob',
        (id) => findPrivatePreKey(bob.secrets, id),
        alice.secrets.identityPublicKey,
      ),
    ).toThrowError(/signature/i);
  });

  it('refuses to encrypt against an unverifiable prekey bundle', () => {
    const alice = createDeviceSecrets('dev_alice', 2);
    const bob = createDeviceSecrets('dev_bob', 2);
    const attacker = createDeviceSecrets('dev_x', 2);
    const bundle = bundleFor('user_bob', bob, 'dev_bob');
    // A hostile server swaps in its own prekey but keeps Bob's identity key.
    bundle.oneTimePreKey = attacker.bundle.oneTimePreKeys[0]!;

    expect(() =>
      encryptMessage(message, ctxFor(), alice.secrets.identityPrivateKey, [bundle]),
    ).toThrowError(RecipientKeyError);
  });

  it('gives forward secrecy: a consumed one-time prekey cannot reopen history', () => {
    const alice = createDeviceSecrets('dev_alice', 3);
    const bob = createDeviceSecrets('dev_bob', 3);
    const ctx = ctxFor();
    const envelope = encryptMessage(
      message,
      ctx,
      alice.secrets.identityPrivateKey,
      [bundleFor('user_bob', bob, 'dev_bob')],
    );

    const usedId = envelope.keys[0]!.preKeyId!;
    const after = consumeOneTimePreKey(bob.secrets, usedId);

    expect(() =>
      decryptMessage(
        envelope,
        ctx,
        'dev_bob',
        (id) => findPrivatePreKey(after, id),
        alice.secrets.identityPublicKey,
      ),
    ).toThrowError(/no longer available/i);
  });

  it('falls back to the signed prekey when one-time prekeys are exhausted', () => {
    const alice = createDeviceSecrets('dev_alice', 1);
    const bob = createDeviceSecrets('dev_bob', 1);
    const ctx = ctxFor();
    const envelope = encryptMessage(
      message,
      ctx,
      alice.secrets.identityPrivateKey,
      [bundleFor('user_bob', bob, 'dev_bob', false)],
    );

    expect(envelope.keys[0]!.preKeyId).toBe(bob.secrets.signedPreKey.id);
    const { plaintext } = decryptMessage(
      envelope,
      ctx,
      'dev_bob',
      (id) => findPrivatePreKey(bob.secrets, id),
      alice.secrets.identityPublicKey,
    );
    expect(plaintext.body).toBe(message.body);
  });

  it('uses a distinct nonce and content key for every message', () => {
    const alice = createDeviceSecrets('dev_alice', 50);
    const bob = createDeviceSecrets('dev_bob', 50);
    const nonces = new Set<string>();
    const wrapped = new Set<string>();
    for (let i = 0; i < 25; i += 1) {
      const env = encryptMessage(
        { v: 1, body: 'same text every time' },
        ctxFor({ messageId: `msg_${i}` }),
        alice.secrets.identityPrivateKey,
        [
          {
            ...bundleFor('user_bob', bob, 'dev_bob'),
            oneTimePreKey: bob.bundle.oneTimePreKeys[i]!,
          },
        ],
      );
      nonces.add(env.nonce);
      wrapped.add(env.keys[0]!.wrapped);
      expect(env.ciphertext).not.toBe([...nonces][0]);
    }
    expect(nonces.size).toBe(25);
    expect(wrapped.size).toBe(25);
  });

  it('refuses to encrypt with no recipients', () => {
    const alice = createDeviceSecrets('dev_alice', 1);
    expect(() =>
      encryptMessage(message, ctxFor(), alice.secrets.identityPrivateKey, []),
    ).toThrowError(/no recipient/i);
  });
});

describe('attachment encryption', () => {
  it('round-trips a multi-chunk file', () => {
    const plaintext = randomBytes(200_000);
    const cipher = encryptAttachment(plaintext);
    expect(cipher.data.length).toBe(encryptedSizeFor(plaintext.length));
    const opened = decryptAttachment(cipher.data, cipher.key, cipher.header);
    expect(Buffer.from(opened).equals(Buffer.from(plaintext))).toBe(true);
  });

  it('round-trips an empty file', () => {
    const cipher = encryptAttachment(new Uint8Array(0));
    const opened = decryptAttachment(cipher.data, cipher.key, cipher.header);
    expect(opened.length).toBe(0);
  });

  it('reports progress monotonically', () => {
    const seen: number[] = [];
    encryptAttachment(randomBytes(200_000), (f) => seen.push(f));
    expect(seen.length).toBeGreaterThan(1);
    expect(seen.at(-1)).toBe(1);
    expect([...seen].sort((a, b) => a - b)).toEqual(seen);
  });

  it('rejects a tampered chunk', () => {
    const cipher = encryptAttachment(randomBytes(100_000));
    cipher.data[100] = (cipher.data[100]! ^ 0xff) & 0xff;
    expect(() =>
      decryptAttachment(cipher.data, cipher.key, cipher.header),
    ).toThrowError(AttachmentDecryptionError);
  });

  it('rejects a truncated stream instead of returning a partial file', () => {
    const cipher = encryptAttachment(randomBytes(200_000));
    const truncated = cipher.data.subarray(0, cipher.data.length - 70_000);
    expect(() =>
      decryptAttachment(truncated, cipher.key, cipher.header),
    ).toThrowError(AttachmentDecryptionError);
  });

  it('rejects the wrong key', () => {
    const cipher = encryptAttachment(randomBytes(1000));
    const other = encryptAttachment(randomBytes(1000));
    expect(() =>
      decryptAttachment(cipher.data, other.key, cipher.header),
    ).toThrowError(AttachmentDecryptionError);
  });

  it('does not leak plaintext into the ciphertext', () => {
    const marker = utf8('CANARY-ATTACHMENT-PAYLOAD');
    const plaintext = new Uint8Array(4096);
    plaintext.set(marker, 100);
    const cipher = encryptAttachment(plaintext);
    expect(Buffer.from(cipher.data).includes(Buffer.from(marker))).toBe(false);
  });
});

describe('safety numbers', () => {
  it('is symmetric between the two parties', () => {
    const a = { userId: 'u_a', identityPublicKey: createDeviceSecrets('d', 1).secrets.identityPublicKey };
    const b = { userId: 'u_b', identityPublicKey: createDeviceSecrets('d', 1).secrets.identityPublicKey };
    expect(safetyNumber(a, b)).toBe(safetyNumber(b, a));
  });

  it('renders 12 groups of 5 digits', () => {
    const a = { userId: 'u_a', identityPublicKey: createDeviceSecrets('d', 1).secrets.identityPublicKey };
    const b = { userId: 'u_b', identityPublicKey: createDeviceSecrets('d', 1).secrets.identityPublicKey };
    const n = safetyNumber(a, b);
    expect(n.split(' ')).toHaveLength(12);
    expect(n.replace(/ /g, '')).toMatch(/^\d{60}$/);
  });

  it('changes when either identity key changes', () => {
    const a = { userId: 'u_a', identityPublicKey: createDeviceSecrets('d', 1).secrets.identityPublicKey };
    const b = { userId: 'u_b', identityPublicKey: createDeviceSecrets('d', 1).secrets.identityPublicKey };
    const b2 = { userId: 'u_b', identityPublicKey: createDeviceSecrets('d', 1).secrets.identityPublicKey };
    expect(safetyNumber(a, b)).not.toBe(safetyNumber(a, b2));
  });

  it('produces a stable per-device fingerprint', () => {
    const key = createDeviceSecrets('d', 1).secrets.identityPublicKey;
    expect(deviceFingerprint(key)).toBe(deviceFingerprint(key));
    expect(deviceFingerprint(key)).toMatch(/^[0-9A-F]{4}( [0-9A-F]{4}){9}$/);
  });
});

describe('key vault export', () => {
  it('round-trips with the correct passphrase', () => {
    const { secrets } = createDeviceSecrets('dev_a', 2);
    const vault = exportVault(secrets, 'correct horse battery staple');
    const restored = importVault(vault, 'correct horse battery staple');
    expect(restored.identityPrivateKey).toBe(secrets.identityPrivateKey);
    expect(restored.oneTimePreKeys).toHaveLength(2);
  });

  it('fails closed on a wrong passphrase', () => {
    const { secrets } = createDeviceSecrets('dev_a', 1);
    const vault = exportVault(secrets, 'correct horse battery staple');
    expect(() => importVault(vault, 'wrong passphrase')).toThrowError(
      VaultUnlockError,
    );
  });

  it('does not store private key material in the clear', () => {
    const { secrets } = createDeviceSecrets('dev_a', 1);
    const vault = exportVault(secrets, 'a strong passphrase here');
    const blob = JSON.stringify(vault);
    expect(blob).not.toContain(secrets.identityPrivateKey);
    expect(blob).not.toContain(secrets.signedPreKey.privateKey);
  });

  it('uses Argon2id with a per-export random salt', () => {
    const { secrets } = createDeviceSecrets('dev_a', 1);
    const one = exportVault(secrets, 'a strong passphrase here');
    const two = exportVault(secrets, 'a strong passphrase here');
    expect(one.kdf).toBe('argon2id');
    expect(one.salt).not.toBe(two.salt);
    expect(one.ciphertext).not.toBe(two.ciphertext);
  });
});
