import { normalizeDisplayText, type ContactRecord } from '@wolffmsg/shared';
import { prisma } from '../db.js';
import { badRequest, notFound } from '../errors.js';
import { projectUser, publicUserSelect } from './users.js';
import { publishToUsers } from '../realtime/hub.js';

/**
 * Contacts are one-directional and require no approval: adding someone is a
 * personal bookmark, not a mutual relationship. Whether they can actually
 * reach you is governed by privacy settings and the block list, which are
 * enforced separately in `access.ts`.
 */

const b64 = (buf: Uint8Array) => Buffer.from(buf).toString('base64');

export async function listContacts(ownerId: string): Promise<ContactRecord[]> {
  const contacts = await prisma.contact.findMany({
    where: { ownerId },
    include: { target: { select: publicUserSelect } },
    orderBy: { createdAt: 'desc' },
  });

  return Promise.all(
    contacts.map(async (contact) => {
      const identityChangedAt = await detectIdentityChange(contact);
      return {
        user: await projectUser(contact.target, ownerId),
        createdAt: contact.createdAt.toISOString(),
        alias: contact.alias,
        verifiedAt: contact.verifiedAt?.toISOString() ?? null,
        identityChangedAt,
      };
    }),
  );
}

/**
 * If the peer's current identity keys no longer include the one that was
 * verified, the safety number has changed and the UI must say so loudly.
 */
async function detectIdentityChange(contact: {
  targetId: string;
  verifiedIdentityKey: Uint8Array | null;
  verifiedAt: Date | null;
}): Promise<string | null> {
  if (!contact.verifiedIdentityKey || !contact.verifiedAt) return null;
  const devices = await prisma.device.findMany({
    where: { userId: contact.targetId, removedAt: null },
    select: { identityPublicKey: true, createdAt: true },
  });
  const verified = b64(contact.verifiedIdentityKey);
  const stillPresent = devices.some((d) => b64(d.identityPublicKey) === verified);
  if (stillPresent) return null;

  const newest = devices.reduce<Date | null>(
    (latest, d) => (!latest || d.createdAt > latest ? d.createdAt : latest),
    null,
  );
  return (newest ?? new Date()).toISOString();
}

export async function addContact(
  ownerId: string,
  targetId: string,
  alias: string | null,
): Promise<ContactRecord> {
  if (ownerId === targetId) throw badRequest('You are already yourself');

  const target = await prisma.user.findFirst({
    where: { id: targetId, disabledAt: null },
    select: publicUserSelect,
  });
  if (!target) throw notFound('That person could not be found');

  const cleanAlias = alias ? normalizeDisplayText(alias).slice(0, 48) || null : null;

  const contact = await prisma.contact.upsert({
    where: { ownerId_targetId: { ownerId, targetId } },
    create: { ownerId, targetId, alias: cleanAlias },
    update: { alias: cleanAlias },
  });

  await publishToUsers([ownerId], { t: 'contact:update', contactUserId: targetId });

  return {
    user: await projectUser(target, ownerId),
    createdAt: contact.createdAt.toISOString(),
    alias: contact.alias,
    verifiedAt: contact.verifiedAt?.toISOString() ?? null,
    identityChangedAt: null,
  };
}

export async function removeContact(
  ownerId: string,
  targetId: string,
): Promise<void> {
  await prisma.contact
    .delete({ where: { ownerId_targetId: { ownerId, targetId } } })
    .catch(() => undefined);
  await publishToUsers([ownerId], { t: 'contact:update', contactUserId: targetId });
}

/**
 * Record that the user compared safety numbers out of band and they matched.
 *
 * The key being verified is supplied by the caller and must match one the peer
 * has actually published — otherwise a client bug could mark a key verified
 * that the peer never held.
 */
export async function verifyContact(
  ownerId: string,
  targetId: string,
  identityPublicKey: string,
): Promise<void> {
  const key = Uint8Array.from(Buffer.from(identityPublicKey, 'base64'));
  if (key.length !== 32) throw badRequest('That is not a valid identity key');

  const devices = await prisma.device.findMany({
    where: { userId: targetId, removedAt: null },
    select: { identityPublicKey: true },
  });
  const matches = devices.some((d) =>
    Buffer.from(d.identityPublicKey).equals(Buffer.from(key)),
  );
  if (!matches) {
    throw badRequest('That key does not belong to this person right now');
  }

  await prisma.contact.upsert({
    where: { ownerId_targetId: { ownerId, targetId } },
    create: {
      ownerId,
      targetId,
      verifiedIdentityKey: key,
      verifiedAt: new Date(),
    },
    update: { verifiedIdentityKey: key, verifiedAt: new Date() },
  });

  await publishToUsers([ownerId], { t: 'contact:update', contactUserId: targetId });
}

export async function unverifyContact(
  ownerId: string,
  targetId: string,
): Promise<void> {
  await prisma.contact
    .update({
      where: { ownerId_targetId: { ownerId, targetId } },
      data: { verifiedIdentityKey: null, verifiedAt: null },
    })
    .catch(() => undefined);
  await publishToUsers([ownerId], { t: 'contact:update', contactUserId: targetId });
}

/* ─────────────────────────────── blocking ───────────────────────────────── */

export async function blockUser(
  blockerId: string,
  blockedId: string,
): Promise<void> {
  if (blockerId === blockedId) throw badRequest('You cannot block yourself');

  const target = await prisma.user.findUnique({
    where: { id: blockedId },
    select: { id: true },
  });
  if (!target) throw notFound('That person could not be found');

  await prisma.$transaction(async (tx) => {
    await tx.blockedUser.upsert({
      where: { blockerId_blockedId: { blockerId, blockedId } },
      create: { blockerId, blockedId },
      update: {},
    });
    // Blocking implies removing them from your contacts.
    await tx.contact
      .deleteMany({ where: { ownerId: blockerId, targetId: blockedId } })
      .catch(() => undefined);
  });

  // Both sides need to re-render: presence and permissions just changed.
  await publishToUsers([blockerId, blockedId], {
    t: 'contact:update',
    contactUserId: blockerId === blockedId ? blockedId : blockedId,
  });
}

export async function unblockUser(
  blockerId: string,
  blockedId: string,
): Promise<void> {
  await prisma.blockedUser
    .delete({ where: { blockerId_blockedId: { blockerId, blockedId } } })
    .catch(() => undefined);
  await publishToUsers([blockerId, blockedId], {
    t: 'contact:update',
    contactUserId: blockedId,
  });
}

export async function listBlocked(blockerId: string) {
  const rows = await prisma.blockedUser.findMany({
    where: { blockerId },
    include: { blocked: { select: publicUserSelect } },
    orderBy: { createdAt: 'desc' },
  });
  return Promise.all(
    rows.map(async (row) => ({
      user: await projectUser(row.blocked, blockerId),
      createdAt: row.createdAt.toISOString(),
    })),
  );
}
