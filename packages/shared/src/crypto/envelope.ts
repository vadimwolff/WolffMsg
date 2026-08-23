/**
 * Message envelope encryption.
 *
 * ┌── on the sender's device ──────────────────────────────────────────────┐
 * │ 1. content key CK ← CSPRNG(32)                                         │
 * │ 2. ciphertext ← XChaCha20-Poly1305-IETF(plaintext, AAD, nonce, CK)     │
 * │ 3. for each recipient device D:                                        │
 * │       verify D's prekey signature against D's identity key             │
 * │       wrapped[D] ← crypto_box_seal(CK, D.preKeyPublic)                 │
 * │ 4. signature ← Ed25519(BLAKE2b(AAD ‖ ciphertext), senderIdentityKey)   │
 * └────────────────────────────────────────────────────────────────────────┘
 *
 * The server receives only `ciphertext`, `nonce`, the per-device sealed
 * `wrapped` blobs and the routing metadata inside the AAD. It holds no key
 * capable of opening any of them.
 *
 * The AAD binds the ciphertext to its message id, chat, sender and timestamp,
 * so a malicious server cannot move a ciphertext into a different chat or
 * re-attribute it to another sender without the AEAD check failing.
 */
import {
  concat,
  fromB64,
  fromUtf8,
  randomBytes,
  sodium,
  toB64,
  utf8,
  wipe,
} from './sodium.js';
import { PROTOCOL_VERSION, SIG_CONTEXT_MESSAGE } from '../constants.js';
import {
  verifyPreKeyBundle,
  type PreKeyBundle,
  type PrivatePreKey,
} from './identity.js';

/** Metadata that both parties must agree on, byte for byte. */
export interface EnvelopeContext {
  messageId: string;
  chatId: string;
  senderUserId: string;
  senderDeviceId: string;
  createdAt: number;
}

/** A content key sealed to one recipient device. */
export interface WrappedKey {
  deviceId: string;
  /** Which prekey the content key was sealed to. `null` = signed prekey. */
  preKeyId: string | null;
  /** base64 `crypto_box_seal` output. */
  wrapped: string;
}

/** The complete ciphertext record handed to the server. */
export interface EncryptedEnvelope {
  v: number;
  alg: 'xchacha20poly1305-ietf';
  /** base64 AEAD ciphertext (includes the Poly1305 tag). */
  ciphertext: string;
  /** base64 24-byte nonce. */
  nonce: string;
  /** base64 Ed25519 detached signature over BLAKE2b(AAD ‖ ciphertext). */
  signature: string;
  keys: WrappedKey[];
}

/** Structured plaintext. Only ever exists in device memory. */
export interface MessagePlaintext {
  v: number;
  /** Human-readable body. May be empty when the message is media-only. */
  body: string;
  attachments?: PlaintextAttachment[];
  replyToId?: string;
  forwardedFrom?: {
    userId: string;
    displayName: string;
    originalCreatedAt: number;
  };
  /** Present on voice messages. */
  voice?: { durationMs: number; waveform: number[] };
}

/** Describes one encrypted attachment, including the key needed to open it. */
export interface PlaintextAttachment {
  /** Server-side blob id. */
  id: string;
  /** Original filename, as typed by the sender. Never used as a server path. */
  name: string;
  mimeType: string;
  /** Plaintext byte length. */
  size: number;
  /** base64 32-byte secretstream key. */
  key: string;
  /** base64 secretstream header. */
  header: string;
  width?: number;
  height?: number;
  durationMs?: number;
  /** base64 encrypted blurhash-style thumbnail payload, if any. */
  thumbnail?: { id: string; key: string; header: string } | undefined;
}

/**
 * Unit separator between AAD fields. Without it, `("ab","c")` and `("a","bc")`
 * would serialise identically and two different contexts could share an AAD.
 */
const FIELD_SEPARATOR = '\u001F';

/**
 * Canonical AAD. Any change to this function is a wire-breaking change and
 * must come with a PROTOCOL_VERSION bump.
 */
export function buildAad(ctx: EnvelopeContext): Uint8Array {
  return utf8(
    [
      `v${PROTOCOL_VERSION}`,
      ctx.messageId,
      ctx.chatId,
      ctx.senderUserId,
      ctx.senderDeviceId,
      String(ctx.createdAt),
    ].join(FIELD_SEPARATOR),
  );
}

function signingDigest(aad: Uint8Array, ciphertext: Uint8Array): Uint8Array {
  const s = sodium();
  return s.crypto_generichash(
    32,
    concat(utf8(SIG_CONTEXT_MESSAGE), aad, ciphertext),
  );
}

export class DecryptionError extends Error {
  constructor(
    message: string,
    readonly reason:
      | 'no-key-for-device'
      | 'unwrap-failed'
      | 'aead-failed'
      | 'bad-signature'
      | 'malformed',
  ) {
    super(message);
    this.name = 'DecryptionError';
  }
}

export class RecipientKeyError extends Error {
  constructor(readonly deviceId: string) {
    super(`Prekey bundle for device ${deviceId} failed signature verification`);
    this.name = 'RecipientKeyError';
  }
}

/**
 * Encrypt a message for a set of recipient devices.
 *
 * @param recipients every device that must be able to read the message —
 *   including the sender's *other* devices, so their history stays in sync.
 */
export function encryptMessage(
  plaintext: MessagePlaintext,
  ctx: EnvelopeContext,
  senderIdentityPrivateKey: string,
  recipients: PreKeyBundle[],
): EncryptedEnvelope {
  const s = sodium();
  if (recipients.length === 0) {
    throw new Error('Refusing to encrypt a message with no recipient devices');
  }

  const contentKey = randomBytes(s.crypto_aead_xchacha20poly1305_ietf_KEYBYTES);
  const nonce = randomBytes(s.crypto_aead_xchacha20poly1305_ietf_NPUBBYTES);
  const aad = buildAad(ctx);

  try {
    const ciphertext = s.crypto_aead_xchacha20poly1305_ietf_encrypt(
      utf8(JSON.stringify(plaintext)),
      aad,
      null,
      nonce,
      contentKey,
    );

    const keys: WrappedKey[] = recipients.map((bundle) => {
      if (!verifyPreKeyBundle(bundle)) throw new RecipientKeyError(bundle.deviceId);
      const target = bundle.oneTimePreKey ?? bundle.signedPreKey;
      return {
        deviceId: bundle.deviceId,
        preKeyId: target.id,
        wrapped: toB64(
          s.crypto_box_seal(contentKey, fromB64(target.publicKey)),
        ),
      };
    });

    const signature = s.crypto_sign_detached(
      signingDigest(aad, ciphertext),
      fromB64(senderIdentityPrivateKey),
    );

    return {
      v: PROTOCOL_VERSION,
      alg: 'xchacha20poly1305-ietf',
      ciphertext: toB64(ciphertext),
      nonce: toB64(nonce),
      signature: toB64(signature),
      keys,
    };
  } finally {
    wipe(contentKey);
  }
}

/**
 * Decrypt an envelope addressed to `deviceId`.
 *
 * Verifies the sender's signature against the identity key the caller has
 * pinned for that device. A mismatch raises rather than returning content —
 * an unexpected identity key is exactly the case the UI must warn about.
 */
export function decryptMessage(
  envelope: EncryptedEnvelope,
  ctx: EnvelopeContext,
  deviceId: string,
  resolvePreKey: (preKeyId: string | null) => PrivatePreKey | null,
  senderIdentityPublicKey: string,
): { plaintext: MessagePlaintext; usedPreKeyId: string | null } {
  const s = sodium();
  if (envelope.v !== PROTOCOL_VERSION) {
    throw new DecryptionError(
      `Unsupported envelope version ${envelope.v}`,
      'malformed',
    );
  }

  const entry = envelope.keys.find((k) => k.deviceId === deviceId);
  if (!entry) {
    throw new DecryptionError(
      'This message was not encrypted to this device',
      'no-key-for-device',
    );
  }

  const preKey = resolvePreKey(entry.preKeyId);
  if (!preKey) {
    throw new DecryptionError(
      'The prekey this message was sealed to is no longer available',
      'unwrap-failed',
    );
  }

  const ciphertext = fromB64(envelope.ciphertext);
  const aad = buildAad(ctx);

  // Authenticate the sender *before* unwrapping, so a forged envelope is
  // rejected without touching our private key material.
  let signatureOk = false;
  try {
    signatureOk = s.crypto_sign_verify_detached(
      fromB64(envelope.signature),
      signingDigest(aad, ciphertext),
      fromB64(senderIdentityPublicKey),
    );
  } catch {
    signatureOk = false;
  }
  if (!signatureOk) {
    throw new DecryptionError(
      'Sender signature does not match the pinned identity key',
      'bad-signature',
    );
  }

  let contentKey: Uint8Array;
  try {
    contentKey = s.crypto_box_seal_open(
      fromB64(entry.wrapped),
      fromB64(preKey.publicKey),
      fromB64(preKey.privateKey),
    );
  } catch {
    throw new DecryptionError('Could not unwrap the content key', 'unwrap-failed');
  }

  try {
    const opened = s.crypto_aead_xchacha20poly1305_ietf_decrypt(
      null,
      ciphertext,
      aad,
      fromB64(envelope.nonce),
      contentKey,
    );
    const parsed = JSON.parse(fromUtf8(opened)) as MessagePlaintext;
    return { plaintext: parsed, usedPreKeyId: entry.preKeyId };
  } catch (err) {
    if (err instanceof SyntaxError) {
      throw new DecryptionError('Decrypted payload was not valid JSON', 'malformed');
    }
    throw new DecryptionError(
      'Authenticated decryption failed — the message was altered in transit',
      'aead-failed',
    );
  } finally {
    wipe(contentKey);
  }
}

/**
 * Re-wrap an already-known content key for an additional device.
 *
 * Used when a contact adds a new device and asks for backfill, and when an
 * edit must reach devices that joined after the original send.
 */
export function wrapContentKeyFor(
  contentKey: Uint8Array,
  bundle: PreKeyBundle,
): WrappedKey {
  const s = sodium();
  if (!verifyPreKeyBundle(bundle)) throw new RecipientKeyError(bundle.deviceId);
  const target = bundle.oneTimePreKey ?? bundle.signedPreKey;
  return {
    deviceId: bundle.deviceId,
    preKeyId: target.id,
    wrapped: toB64(s.crypto_box_seal(contentKey, fromB64(target.publicKey))),
  };
}
