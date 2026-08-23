/**
 * Device identity, signed prekeys and one-time prekeys.
 *
 * Every device a user signs in from generates its own long-term Ed25519
 * identity key. The private half never leaves the device — the server only
 * ever receives public keys and signatures.
 */
import {
  concat,
  fromB64,
  randomBytes,
  randomId,
  sodium,
  toB64,
  utf8,
} from './sodium.js';
import {
  ONE_TIME_PREKEY_BATCH,
  PROTOCOL_VERSION,
  SIG_CONTEXT_PREKEY,
} from '../constants.js';

/** A public prekey as published to the server. */
export interface PublicPreKey {
  /** Opaque, server-visible identifier. */
  id: string;
  /** base64 X25519 public key. */
  publicKey: string;
  /** base64 Ed25519 signature by the device identity key. */
  signature: string;
}

/** The private half of a prekey — never transmitted. */
export interface PrivatePreKey {
  id: string;
  publicKey: string;
  privateKey: string;
}

/** Everything a device keeps locally. Encrypted at rest in the key vault. */
export interface DeviceSecrets {
  v: number;
  deviceId: string;
  /** base64 Ed25519 public key. */
  identityPublicKey: string;
  /** base64 Ed25519 private key. */
  identityPrivateKey: string;
  signedPreKey: PrivatePreKey;
  signedPreKeyCreatedAt: number;
  oneTimePreKeys: PrivatePreKey[];
}

/** Public material a device publishes when it registers. */
export interface DevicePublicBundle {
  identityPublicKey: string;
  signedPreKey: PublicPreKey;
  oneTimePreKeys: PublicPreKey[];
}

/** What a sender fetches in order to encrypt to one recipient device. */
export interface PreKeyBundle {
  deviceId: string;
  userId: string;
  identityPublicKey: string;
  signedPreKey: PublicPreKey;
  /** `null` once the device's one-time prekeys are exhausted. */
  oneTimePreKey: PublicPreKey | null;
}

/**
 * Bytes that a prekey signature covers. Domain-separated so a signature over a
 * prekey can never be replayed as a signature over a message.
 */
function preKeySigningPayload(publicKey: Uint8Array, id: string): Uint8Array {
  return concat(utf8(SIG_CONTEXT_PREKEY), utf8(id), utf8('|'), publicKey);
}

function generateSignedPreKeyPair(identityPrivateKey: Uint8Array): {
  priv: PrivatePreKey;
  pub: PublicPreKey;
} {
  const s = sodium();
  const id = randomId(12);
  const kp = s.crypto_box_keypair();
  const signature = s.crypto_sign_detached(
    preKeySigningPayload(kp.publicKey, id),
    identityPrivateKey,
  );
  return {
    priv: {
      id,
      publicKey: toB64(kp.publicKey),
      privateKey: toB64(kp.privateKey),
    },
    pub: { id, publicKey: toB64(kp.publicKey), signature: toB64(signature) },
  };
}

/**
 * Create a brand-new device identity together with a signed prekey and an
 * initial batch of one-time prekeys.
 */
export function createDeviceSecrets(
  deviceId: string,
  oneTimeCount = ONE_TIME_PREKEY_BATCH,
): { secrets: DeviceSecrets; bundle: DevicePublicBundle } {
  const s = sodium();
  const identity = s.crypto_sign_keypair();

  const signed = generateSignedPreKeyPair(identity.privateKey);
  const oneTime: { priv: PrivatePreKey; pub: PublicPreKey }[] = [];
  for (let i = 0; i < oneTimeCount; i += 1) {
    oneTime.push(generateSignedPreKeyPair(identity.privateKey));
  }

  return {
    secrets: {
      v: PROTOCOL_VERSION,
      deviceId,
      identityPublicKey: toB64(identity.publicKey),
      identityPrivateKey: toB64(identity.privateKey),
      signedPreKey: signed.priv,
      signedPreKeyCreatedAt: Date.now(),
      oneTimePreKeys: oneTime.map((k) => k.priv),
    },
    bundle: {
      identityPublicKey: toB64(identity.publicKey),
      signedPreKey: signed.pub,
      oneTimePreKeys: oneTime.map((k) => k.pub),
    },
  };
}

/**
 * Mint a fresh batch of one-time prekeys, appending the private halves to the
 * device secrets. Called when the server reports the device is running low.
 */
export function replenishOneTimePreKeys(
  secrets: DeviceSecrets,
  count = ONE_TIME_PREKEY_BATCH,
): { secrets: DeviceSecrets; published: PublicPreKey[] } {
  const identityPrivateKey = fromB64(secrets.identityPrivateKey);
  const fresh: { priv: PrivatePreKey; pub: PublicPreKey }[] = [];
  for (let i = 0; i < count; i += 1) {
    fresh.push(generateSignedPreKeyPair(identityPrivateKey));
  }
  return {
    secrets: {
      ...secrets,
      oneTimePreKeys: [...secrets.oneTimePreKeys, ...fresh.map((k) => k.priv)],
    },
    published: fresh.map((k) => k.pub),
  };
}

/**
 * Rotate the medium-term signed prekey. The previous one is discarded, which
 * bounds how long a compromised device key can decrypt newly arriving traffic
 * that fell back past the one-time prekeys.
 */
export function rotateSignedPreKey(secrets: DeviceSecrets): {
  secrets: DeviceSecrets;
  published: PublicPreKey;
} {
  const identityPrivateKey = fromB64(secrets.identityPrivateKey);
  const next = generateSignedPreKeyPair(identityPrivateKey);
  return {
    secrets: {
      ...secrets,
      signedPreKey: next.priv,
      signedPreKeyCreatedAt: Date.now(),
    },
    published: next.pub,
  };
}

/**
 * Verify that a prekey really was signed by the advertised identity key.
 *
 * A sender MUST call this before wrapping a content key to a bundle; skipping
 * it would let a malicious server substitute its own prekey.
 */
export function verifyPreKey(
  identityPublicKey: string,
  preKey: PublicPreKey,
): boolean {
  const s = sodium();
  try {
    return s.crypto_sign_verify_detached(
      fromB64(preKey.signature),
      preKeySigningPayload(fromB64(preKey.publicKey), preKey.id),
      fromB64(identityPublicKey),
    );
  } catch {
    return false;
  }
}

/** Verify every signature in a bundle. Returns false if anything is off. */
export function verifyPreKeyBundle(bundle: PreKeyBundle): boolean {
  if (!verifyPreKey(bundle.identityPublicKey, bundle.signedPreKey)) return false;
  if (
    bundle.oneTimePreKey &&
    !verifyPreKey(bundle.identityPublicKey, bundle.oneTimePreKey)
  ) {
    return false;
  }
  return true;
}

/**
 * Consume a one-time prekey after a successful decryption.
 *
 * Deleting the private half is what gives WolffMsg forward secrecy: once the
 * key is gone, a later compromise of the device cannot recover that message.
 */
export function consumeOneTimePreKey(
  secrets: DeviceSecrets,
  preKeyId: string,
): DeviceSecrets {
  return {
    ...secrets,
    oneTimePreKeys: secrets.oneTimePreKeys.filter((k) => k.id !== preKeyId),
  };
}

/** Locate a private prekey (one-time or signed) by its published id. */
export function findPrivatePreKey(
  secrets: DeviceSecrets,
  preKeyId: string | null,
): PrivatePreKey | null {
  if (preKeyId === null || preKeyId === secrets.signedPreKey.id) {
    return secrets.signedPreKey;
  }
  return secrets.oneTimePreKeys.find((k) => k.id === preKeyId) ?? null;
}

/** Non-secret summary used for UI and audit logs. */
export function describeDeviceKeys(secrets: DeviceSecrets): {
  deviceId: string;
  identityPublicKey: string;
  signedPreKeyId: string;
  oneTimePreKeysRemaining: number;
  signedPreKeyAgeDays: number;
} {
  return {
    deviceId: secrets.deviceId,
    identityPublicKey: secrets.identityPublicKey,
    signedPreKeyId: secrets.signedPreKey.id,
    oneTimePreKeysRemaining: secrets.oneTimePreKeys.length,
    signedPreKeyAgeDays: Math.floor(
      (Date.now() - secrets.signedPreKeyCreatedAt) / 86_400_000,
    ),
  };
}

/** Randomly generated, non-secret device identifier. */
export function newDeviceId(): string {
  return toB64(randomBytes(16)).replace(/[+/=]/g, '').slice(0, 22);
}
