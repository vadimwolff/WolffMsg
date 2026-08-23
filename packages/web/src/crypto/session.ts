/**
 * The client's cryptographic session.
 *
 * Everything that turns a typed message into a ciphertext, and a ciphertext
 * back into something readable, goes through here. Components never touch
 * libsodium directly — they call `encryptOutgoing` and `decryptRecord`.
 */
import {
  ONE_TIME_PREKEY_BATCH,
  ONE_TIME_PREKEY_LOW_WATER,
  SIGNED_PREKEY_MAX_AGE_DAYS,
  buildAad,
  consumeOneTimePreKey,
  createDeviceSecrets,
  decryptMessage,
  encryptMessage,
  findPrivatePreKey,
  initCrypto,
  replenishOneTimePreKeys,
  rotateSignedPreKey,
  type DevicePublicBundle,
  type DeviceSecrets,
  type EncryptedEnvelope,
  type EnvelopeContext,
  type MessagePlaintext,
  type MessageRecord,
  type PreKeyBundle,
} from '@wolffmsg/shared';
import { api } from '../lib/api.ts';
import { STORE_IDENTITIES, idbGet, idbPut } from '../lib/idb.ts';
import { loadSecrets, saveSecrets } from './keyVault.ts';

let secrets: DeviceSecrets | null = null;
let ready: Promise<void> | null = null;

/** Load libsodium and the device vault exactly once per tab. */
export async function initSession(): Promise<DeviceSecrets | null> {
  if (!ready) {
    ready = (async () => {
      await initCrypto();
      secrets = await loadSecrets();
    })();
  }
  await ready;
  return secrets;
}

export function currentSecrets(): DeviceSecrets | null {
  return secrets;
}

export function requireSecrets(): DeviceSecrets {
  if (!secrets) {
    throw new Error('This device has no encryption identity yet');
  }
  return secrets;
}

/**
 * Create a fresh device identity.
 *
 * Called during sign-up, and during sign-in on a device that has never been
 * used before. The returned bundle is what gets published to the server; the
 * private halves stay here.
 */
export async function createIdentity(): Promise<{
  bundle: DevicePublicBundle;
  pending: DeviceSecrets;
}> {
  await initCrypto();
  const created = createDeviceSecrets('pending', ONE_TIME_PREKEY_BATCH);
  return { bundle: created.bundle, pending: created.secrets };
}

/** Persist the identity once the server has assigned it a real device id. */
export async function adoptIdentity(
  pending: DeviceSecrets,
  deviceId: string,
): Promise<void> {
  secrets = { ...pending, deviceId };
  await saveSecrets(secrets);
}

export async function updateSecrets(next: DeviceSecrets): Promise<void> {
  secrets = next;
  await saveSecrets(next);
}

export function forgetSession(): void {
  secrets = null;
  ready = null;
}

/* ─────────────────────────── identity pinning ───────────────────────────── */

interface PinnedIdentity {
  userId: string;
  /** deviceId → base64 Ed25519 identity key. */
  devices: Record<string, string>;
  updatedAt: number;
}

/**
 * Remember which identity key each of a peer's devices had, so a silent
 * substitution — the classic malicious-server move — becomes visible.
 */
export async function pinIdentities(
  userId: string,
  devices: { deviceId: string; identityPublicKey: string }[],
): Promise<{ changed: string[] }> {
  const previous = await idbGet<PinnedIdentity>(STORE_IDENTITIES, userId);
  const next: Record<string, string> = {};
  const changed: string[] = [];

  for (const device of devices) {
    next[device.deviceId] = device.identityPublicKey;
    const before = previous?.devices[device.deviceId];
    if (before && before !== device.identityPublicKey) changed.push(device.deviceId);
  }

  await idbPut<PinnedIdentity>(
    STORE_IDENTITIES,
    { userId, devices: next, updatedAt: Date.now() },
    userId,
  );
  return { changed };
}

export async function pinnedIdentityFor(
  userId: string,
  deviceId: string,
): Promise<string | null> {
  const record = await idbGet<PinnedIdentity>(STORE_IDENTITIES, userId);
  return record?.devices[deviceId] ?? null;
}

/**
 * Fetch a peer's identity keys, pinning them as a side effect.
 *
 * Cached briefly: this is called on every decrypt, and a device list does not
 * change between one message and the next.
 */
const identityCache = new Map<string, { keys: Record<string, string>; at: number }>();
const IDENTITY_TTL_MS = 60_000;

export async function identityKeysFor(
  userId: string,
): Promise<Record<string, string>> {
  const cached = identityCache.get(userId);
  if (cached && Date.now() - cached.at < IDENTITY_TTL_MS) return cached.keys;

  const response = await api.get<{
    devices: { deviceId: string; identityPublicKey: string; name: string }[];
  }>(`/api/users/${encodeURIComponent(userId)}/identity`);

  const keys: Record<string, string> = {};
  for (const device of response.devices) {
    keys[device.deviceId] = device.identityPublicKey;
  }
  identityCache.set(userId, { keys, at: Date.now() });
  await pinIdentities(userId, response.devices);
  return keys;
}

export function invalidateIdentityCache(userId?: string): void {
  if (userId) identityCache.delete(userId);
  else identityCache.clear();
}

/* ───────────────────────────── encryption ───────────────────────────────── */

/**
 * Claim prekey bundles for everyone who must be able to read a message.
 *
 * Bundle signatures are verified inside `encryptMessage`; a bundle that fails
 * raises rather than being silently skipped, because a bad bundle is exactly
 * what a substitution attack looks like.
 */
async function claimBundles(chatId: string): Promise<PreKeyBundle[]> {
  const response = await api.post<{ bundles: PreKeyBundle[] }>('/api/keys/claim', {
    chatId,
    includeSelf: true,
  });
  return response.bundles;
}

export interface OutgoingEnvelope {
  envelope: EncryptedEnvelope;
  context: EnvelopeContext;
}

export async function encryptOutgoing(
  chatId: string,
  messageId: string,
  createdAt: number,
  userId: string,
  plaintext: MessagePlaintext,
): Promise<OutgoingEnvelope> {
  const device = requireSecrets();
  const bundles = await claimBundles(chatId);

  if (bundles.length === 0) {
    throw new Error(
      'No one in this conversation has a device that can receive messages yet',
    );
  }

  const context: EnvelopeContext = {
    messageId,
    chatId,
    senderUserId: userId,
    senderDeviceId: device.deviceId,
    createdAt,
  };

  const envelope = encryptMessage(
    plaintext,
    context,
    device.identityPrivateKey,
    bundles,
  );
  return { envelope, context };
}

/* ───────────────────────────── decryption ───────────────────────────────── */

export type DecryptOutcome =
  | { status: 'ok'; plaintext: MessagePlaintext }
  | { status: 'not-for-this-device' }
  | { status: 'key-gone' }
  | { status: 'identity-changed' }
  | { status: 'tampered' }
  | { status: 'system' }
  | { status: 'deleted' }
  | { status: 'error'; message: string };

/**
 * Decrypt one message record.
 *
 * On success the one-time prekey it used is destroyed. That deletion is what
 * gives the protocol its forward secrecy, so it happens here rather than being
 * left to a background task that might not run.
 */
export async function decryptRecord(record: MessageRecord): Promise<DecryptOutcome> {
  if (record.deletedAt) return { status: 'deleted' };
  if (record.system) return { status: 'system' };
  if (!record.envelope) return { status: 'not-for-this-device' };

  const device = currentSecrets();
  if (!device) return { status: 'error', message: 'This device is locked' };

  let senderKey: string | undefined;
  try {
    const keys = await identityKeysFor(record.senderId);
    senderKey = keys[record.senderDeviceId];
  } catch {
    return { status: 'error', message: 'Could not verify the sender' };
  }

  if (!senderKey) {
    // The sending device is gone, so its key is no longer published and the
    // signature cannot be checked. Refusing is the safe answer.
    return { status: 'identity-changed' };
  }

  const context: EnvelopeContext = {
    messageId: record.id,
    chatId: record.chatId,
    senderUserId: record.senderId,
    senderDeviceId: record.senderDeviceId,
    createdAt: new Date(record.createdAt).getTime(),
  };

  try {
    const { plaintext, usedPreKeyId } = decryptMessage(
      record.envelope,
      context,
      device.deviceId,
      (preKeyId) => findPrivatePreKey(device, preKeyId),
      senderKey,
    );

    if (usedPreKeyId && usedPreKeyId !== device.signedPreKey.id) {
      await updateSecrets(consumeOneTimePreKey(device, usedPreKeyId));
      void ensurePreKeySupply();
    }

    return { status: 'ok', plaintext };
  } catch (err) {
    const reason = (err as { reason?: string }).reason;
    switch (reason) {
      case 'no-key-for-device':
        return { status: 'not-for-this-device' };
      case 'unwrap-failed':
        return { status: 'key-gone' };
      case 'bad-signature':
        return { status: 'identity-changed' };
      case 'aead-failed':
        return { status: 'tampered' };
      default:
        return { status: 'error', message: 'This message could not be opened' };
    }
  }
}

/** Bytes both sides agree on, exposed so the UI can show what is authenticated. */
export function authenticatedContextFor(record: MessageRecord): Uint8Array {
  return buildAad({
    messageId: record.id,
    chatId: record.chatId,
    senderUserId: record.senderId,
    senderDeviceId: record.senderDeviceId,
    createdAt: new Date(record.createdAt).getTime(),
  });
}

/* ────────────────────────────── key upkeep ──────────────────────────────── */

let replenishing = false;

/**
 * Publish a fresh batch of one-time prekeys when the server is running low.
 *
 * If this never ran, senders would fall back to the long-term signed prekey
 * and forward secrecy would quietly stop applying — so it is called on
 * startup, on every consumed key, and whenever the server says so.
 */
export async function ensurePreKeySupply(): Promise<void> {
  if (replenishing || !secrets) return;
  replenishing = true;
  try {
    const status = await api.get<{ remaining: number; deviceId: string | null }>(
      '/api/keys/status',
    );
    if (status.remaining >= ONE_TIME_PREKEY_LOW_WATER) return;

    const topUp = replenishOneTimePreKeys(secrets, ONE_TIME_PREKEY_BATCH);
    await api.post('/api/keys/one-time', { preKeys: topUp.published });
    await updateSecrets(topUp.secrets);
  } catch {
    // Best effort. A failure here degrades forward secrecy rather than
    // breaking messaging, and the next call will retry.
  } finally {
    replenishing = false;
  }
}

/** Rotate the medium-term signed prekey once it ages past its window. */
export async function rotateSignedPreKeyIfStale(): Promise<void> {
  if (!secrets) return;
  const ageDays = (Date.now() - secrets.signedPreKeyCreatedAt) / 86_400_000;
  if (ageDays < SIGNED_PREKEY_MAX_AGE_DAYS) return;

  try {
    const rotated = rotateSignedPreKey(secrets);
    await api.post('/api/keys/signed', { preKey: rotated.published });
    await updateSecrets(rotated.secrets);
  } catch {
    // Retried on the next launch.
  }
}

/** Run the routine key maintenance a device owes after connecting. */
export async function runKeyMaintenance(): Promise<void> {
  await ensurePreKeySupply();
  await rotateSignedPreKeyIfStale();
}

/*
 * The server emits `prekeys:low` for every message addressed to a device whose
 * supply is short, so a busy chat produces a burst of them. Publishing keys
 * costs a round trip and some CPU, and one top-up answers the whole burst.
 */
const MAINTENANCE_COOLDOWN_MS = 60_000;
let lastMaintenance = 0;

/** Run maintenance unless it already ran within the cooldown. */
export function runKeyMaintenanceThrottled(): Promise<void> {
  const now = Date.now();
  if (now - lastMaintenance < MAINTENANCE_COOLDOWN_MS) return Promise.resolve();
  lastMaintenance = now;
  return runKeyMaintenance();
}

/** Clear the cooldown, so a fresh sign-in is never throttled by the last one. */
export function resetKeyMaintenanceThrottled(): void {
  lastMaintenance = 0;
}
