import {
  ONE_TIME_PREKEY_LOW_WATER,
  verifyPreKey,
  type DeviceSummary,
  type PreKeyBundle,
  type PublicPreKey,
} from '@wolffmsg/shared';
import { prisma } from '../db.js';
import { badRequest, notFound } from '../errors.js';
import { logger } from '../logger.js';
import { recordSecurityEvent } from './securityEvents.js';

/**
 * Device and key management.
 *
 * The server's job here is custody, not trust: it stores public keys and hands
 * them out, and it enforces that a one-time prekey is issued at most once. It
 * cannot verify that a key belongs to a human, which is exactly why clients
 * check signatures themselves and users compare safety numbers.
 */

const b64 = (buf: Uint8Array) => Buffer.from(buf).toString('base64');
const unb64 = (text: string): Uint8Array<ArrayBuffer> =>
  Uint8Array.from(Buffer.from(text, 'base64'));

export interface RegisterDeviceInput {
  userId: string;
  name: string;
  platform: string;
  identityPublicKey: string;
  signedPreKey: PublicPreKey;
  oneTimePreKeys: PublicPreKey[];
  ipHint: string | null;
}

/**
 * Register a device and publish its initial key material.
 *
 * Every prekey signature is verified server-side before it is stored. This is
 * not a substitute for the client's own verification — a malicious server
 * could skip it — but it stops a *buggy* client from publishing keys that no
 * one will ever be able to use, and it rejects obviously malformed material.
 */
export async function registerDevice(
  input: RegisterDeviceInput,
): Promise<{ deviceId: string }> {
  const identity = unb64(input.identityPublicKey);
  if (identity.length !== 32) {
    throw badRequest('Identity key must be a 32-byte Ed25519 public key', {
      identityPublicKey: 'Invalid key length',
    });
  }

  assertSignedPreKey(input.identityPublicKey, input.signedPreKey);
  for (const otp of input.oneTimePreKeys) {
    assertSignedPreKey(input.identityPublicKey, otp);
  }
  if (input.oneTimePreKeys.length > 200) {
    throw badRequest('Too many one-time prekeys in a single batch');
  }
  assertUniqueKeyIds([input.signedPreKey, ...input.oneTimePreKeys]);

  const device = await prisma.$transaction(async (tx) => {
    const created = await tx.device.create({
      data: {
        userId: input.userId,
        name: input.name.slice(0, 64),
        platform: input.platform.slice(0, 32),
        identityPublicKey: identity,
        lastIpHint: input.ipHint,
      },
      select: { id: true },
    });

    await tx.preKey.createMany({
      data: [
        {
          deviceId: created.id,
          keyId: input.signedPreKey.id,
          kind: 'signed',
          publicKey: unb64(input.signedPreKey.publicKey),
          signature: unb64(input.signedPreKey.signature),
        },
        ...input.oneTimePreKeys.map((k) => ({
          deviceId: created.id,
          keyId: k.id,
          kind: 'onetime',
          publicKey: unb64(k.publicKey),
          signature: unb64(k.signature),
        })),
      ],
    });

    return created;
  });

  await recordSecurityEvent({
    userId: input.userId,
    kind: 'device.registered',
    detail: `${input.name} · ${input.platform}`,
    ipHint: input.ipHint,
  });

  return { deviceId: device.id };
}

function assertSignedPreKey(identityPublicKey: string, preKey: PublicPreKey): void {
  if (!preKey?.id || !preKey.publicKey || !preKey.signature) {
    throw badRequest('Malformed prekey');
  }
  if (preKey.id.length > 64) throw badRequest('Prekey id is too long');
  if (unb64(preKey.publicKey).length !== 32) {
    throw badRequest('Prekey must be a 32-byte X25519 public key');
  }
  if (!verifyPreKey(identityPublicKey, preKey)) {
    throw badRequest('Prekey signature does not match the identity key');
  }
}

function assertUniqueKeyIds(keys: PublicPreKey[]): void {
  const seen = new Set<string>();
  for (const key of keys) {
    if (seen.has(key.id)) throw badRequest('Duplicate prekey id in batch');
    seen.add(key.id);
  }
}

/** Add more one-time prekeys to an existing device. */
export async function replenishPreKeys(
  userId: string,
  deviceId: string,
  keys: PublicPreKey[],
): Promise<{ stored: number; total: number }> {
  const device = await requireOwnDevice(userId, deviceId);
  if (keys.length === 0 || keys.length > 200) {
    throw badRequest('Publish between 1 and 200 prekeys at a time');
  }
  const identityPublicKey = b64(device.identityPublicKey);
  for (const key of keys) assertSignedPreKey(identityPublicKey, key);
  assertUniqueKeyIds(keys);

  const result = await prisma.preKey.createMany({
    data: keys.map((k) => ({
      deviceId,
      keyId: k.id,
      kind: 'onetime',
      publicKey: unb64(k.publicKey),
      signature: unb64(k.signature),
    })),
    skipDuplicates: true,
  });

  const total = await prisma.preKey.count({
    where: { deviceId, kind: 'onetime', claimedAt: null },
  });

  await recordSecurityEvent({
    userId,
    kind: 'prekeys.replenished',
    detail: `${result.count} new one-time keys (${total} available)`,
    ipHint: null,
  });

  return { stored: result.count, total };
}

/** Replace the medium-term signed prekey, retiring the previous one. */
export async function rotateSignedPreKey(
  userId: string,
  deviceId: string,
  preKey: PublicPreKey,
): Promise<void> {
  const device = await requireOwnDevice(userId, deviceId);
  assertSignedPreKey(b64(device.identityPublicKey), preKey);

  await prisma.$transaction(async (tx) => {
    // Retire rather than delete: messages already in flight may be sealed to
    // the old key, and the recipient still holds its private half.
    await tx.preKey.updateMany({
      where: { deviceId, kind: 'signed', retiredAt: null },
      data: { retiredAt: new Date() },
    });
    await tx.preKey.create({
      data: {
        deviceId,
        keyId: preKey.id,
        kind: 'signed',
        publicKey: unb64(preKey.publicKey),
        signature: unb64(preKey.signature),
      },
    });
  });
}

async function requireOwnDevice(userId: string, deviceId: string) {
  const device = await prisma.device.findFirst({
    where: { id: deviceId, userId, removedAt: null },
    select: { id: true, identityPublicKey: true },
  });
  if (!device) throw notFound('That device is not registered to you');
  return device;
}

/**
 * Claim prekey bundles for a set of devices.
 *
 * The one-time prekey is claimed with a single `UPDATE ... WHERE id = (SELECT
 * ... FOR UPDATE SKIP LOCKED)`, so two senders racing for the same recipient
 * can never be handed the same key. When none remain the caller gets the
 * signed prekey instead, and the bundle says so.
 */
export async function claimPreKeyBundles(
  deviceIds: string[],
): Promise<PreKeyBundle[]> {
  if (deviceIds.length === 0) return [];

  const devices = await prisma.device.findMany({
    where: { id: { in: deviceIds }, removedAt: null },
    select: { id: true, userId: true, identityPublicKey: true },
  });

  const bundles: PreKeyBundle[] = [];

  for (const device of devices) {
    const signed = await prisma.preKey.findFirst({
      where: { deviceId: device.id, kind: 'signed', retiredAt: null },
      orderBy: { createdAt: 'desc' },
      select: { keyId: true, publicKey: true, signature: true },
    });
    if (!signed) {
      logger.warn({ deviceId: device.id }, 'device has no active signed prekey');
      continue;
    }

    const claimed = await claimOneTimePreKey(device.id);

    bundles.push({
      deviceId: device.id,
      userId: device.userId,
      identityPublicKey: b64(device.identityPublicKey),
      signedPreKey: {
        id: signed.keyId,
        publicKey: b64(signed.publicKey),
        signature: b64(signed.signature),
      },
      oneTimePreKey: claimed,
    });
  }

  return bundles;
}

interface ClaimedRow {
  keyId: string;
  publicKey: Buffer;
  signature: Buffer;
}

async function claimOneTimePreKey(
  deviceId: string,
): Promise<PublicPreKey | null> {
  // Tagged template — Prisma parameterises `deviceId`, so this is not a
  // string-concatenation query despite being raw SQL.
  const rows = await prisma.$queryRaw<ClaimedRow[]>`
    UPDATE "prekeys" AS p
       SET "claimedAt" = NOW()
     WHERE ("deviceId", "keyId") = (
             SELECT "deviceId", "keyId"
               FROM "prekeys"
              WHERE "deviceId" = ${deviceId}
                AND "kind" = 'onetime'
                AND "claimedAt" IS NULL
              ORDER BY "createdAt" ASC
              LIMIT 1
                FOR UPDATE SKIP LOCKED
           )
    RETURNING p."keyId" AS "keyId", p."publicKey" AS "publicKey", p."signature" AS "signature"
  `;

  const row = rows[0];
  if (!row) return null;
  return {
    id: row.keyId,
    publicKey: b64(row.publicKey),
    signature: b64(row.signature),
  };
}

/** Every active device for a set of users — the fan-out list for a message. */
export async function activeDeviceIdsForUsers(
  userIds: string[],
): Promise<{ deviceId: string; userId: string }[]> {
  if (userIds.length === 0) return [];
  const devices = await prisma.device.findMany({
    where: { userId: { in: userIds }, removedAt: null },
    select: { id: true, userId: true },
  });
  return devices.map((d) => ({ deviceId: d.id, userId: d.userId }));
}

export async function listDevices(
  userId: string,
  currentDeviceId: string | null,
): Promise<DeviceSummary[]> {
  const devices = await prisma.device.findMany({
    where: { userId, removedAt: null },
    orderBy: { lastActiveAt: 'desc' },
    select: {
      id: true,
      name: true,
      platform: true,
      identityPublicKey: true,
      createdAt: true,
      lastActiveAt: true,
      lastIpHint: true,
      _count: { select: { preKeys: true } },
    },
  });

  const remaining = await prisma.preKey.groupBy({
    by: ['deviceId'],
    where: {
      deviceId: { in: devices.map((d) => d.id) },
      kind: 'onetime',
      claimedAt: null,
    },
    _count: { _all: true },
  });
  const remainingByDevice = new Map(
    remaining.map((r) => [r.deviceId, r._count._all]),
  );

  return devices.map((d) => ({
    id: d.id,
    name: d.name,
    platform: d.platform,
    identityPublicKey: b64(d.identityPublicKey),
    createdAt: d.createdAt.toISOString(),
    lastActiveAt: d.lastActiveAt.toISOString(),
    lastIpHint: d.lastIpHint,
    current: d.id === currentDeviceId,
    oneTimePreKeysRemaining: remainingByDevice.get(d.id) ?? 0,
  }));
}

/**
 * Retire a device. Its keys are deleted so no new message can be addressed to
 * it, and the row is tombstoned rather than removed so historical messages
 * keep their sender attribution.
 */
export async function removeDevice(
  userId: string,
  deviceId: string,
): Promise<void> {
  const device = await prisma.device.findFirst({
    where: { id: deviceId, userId, removedAt: null },
    select: { id: true, name: true },
  });
  if (!device) throw notFound('That device is not registered to you');

  await prisma.$transaction(async (tx) => {
    await tx.preKey.deleteMany({ where: { deviceId } });
    await tx.device.update({
      where: { id: deviceId },
      data: { removedAt: new Date() },
    });
    await tx.session.updateMany({
      where: { deviceId, revokedAt: null },
      data: { revokedAt: new Date(), revokedReason: 'device removed' },
    });
  });

  await recordSecurityEvent({
    userId,
    kind: 'device.removed',
    detail: device.name,
    ipHint: null,
  });
}

export async function touchDevice(
  deviceId: string,
  ipHint: string | null,
): Promise<void> {
  await prisma.device
    .update({
      where: { id: deviceId },
      data: { lastActiveAt: new Date(), ...(ipHint ? { lastIpHint: ipHint } : {}) },
    })
    .catch(() => undefined);
}

export async function preKeysRemaining(deviceId: string): Promise<number> {
  return prisma.preKey.count({
    where: { deviceId, kind: 'onetime', claimedAt: null },
  });
}

export function isLowOnPreKeys(remaining: number): boolean {
  return remaining < ONE_TIME_PREKEY_LOW_WATER;
}

/**
 * Identity keys for a user's devices, used by the client to pin and to compute
 * safety numbers. Only public material.
 */
export async function identityKeysFor(
  userId: string,
): Promise<{ deviceId: string; identityPublicKey: string; name: string }[]> {
  const devices = await prisma.device.findMany({
    where: { userId, removedAt: null },
    select: { id: true, identityPublicKey: true, name: true },
    orderBy: { createdAt: 'asc' },
  });
  return devices.map((d) => ({
    deviceId: d.id,
    identityPublicKey: b64(d.identityPublicKey),
    name: d.name,
  }));
}
