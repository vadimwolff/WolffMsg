import type { Readable } from 'node:stream';
import { ALLOWED_ATTACHMENT_MIME } from '@wolffmsg/shared';
import { bytes, prisma } from '../db.js';
import { env } from '../env.js';
import { badRequest, forbidden, notFound } from '../errors.js';
import { logger } from '../logger.js';
import { requireMembership } from './access.js';
import {
  deleteBlob,
  deleteBlobs,
  readBlobStream,
  writeBlob,
} from '../storage/local.js';

/**
 * Attachments.
 *
 * The server receives an already-encrypted blob and stores it under a random
 * key. It never learns the filename, the contents, or the key that opens it —
 * all three live inside the message ciphertext.
 *
 * Because the bytes are opaque, content-based validation is impossible by
 * construction. The mitigations that remain, and that this module applies, are:
 *   • an allow-list of declared types, so an unexpected type is refused;
 *   • a hard size cap enforced while streaming;
 *   • a random server-side filename, never the client's;
 *   • download responses that are always `application/octet-stream` with
 *     `Content-Disposition: attachment` and a sandboxing CSP, so nothing the
 *     browser receives here can execute in our origin.
 */

export interface UploadResult {
  id: string;
  encryptedSize: number;
}

export async function uploadAttachment(params: {
  uploaderId: string;
  chatId: string;
  mimeType: string;
  stream: Readable;
}): Promise<UploadResult> {
  await requireMembership(params.chatId, params.uploaderId);

  const mimeType = normalizeMime(params.mimeType);
  if (!ALLOWED_ATTACHMENT_MIME.has(mimeType)) {
    throw badRequest('That file type is not supported');
  }

  const blob = await writeBlob(params.stream, env.MAX_ATTACHMENT_BYTES);

  try {
    const attachment = await prisma.attachment.create({
      data: {
        chatId: params.chatId,
        uploaderId: params.uploaderId,
        mimeType,
        encryptedSize: blob.size,
        storageKey: blob.storageKey,
        ciphertextHash: bytes(blob.hash),
      },
      select: { id: true, encryptedSize: true },
    });
    return attachment;
  } catch (err) {
    await deleteBlob(blob.storageKey);
    throw err;
  }
}

/**
 * A declared MIME type is untrusted input. Strip parameters, lowercase, and
 * reject anything that is not a plain `type/subtype`, so it can never carry a
 * header injection or a `; charset=` trick into a response.
 */
function normalizeMime(value: string): string {
  const base = (value ?? '').split(';')[0]?.trim().toLowerCase() ?? '';
  if (!/^[a-z0-9][a-z0-9!#$&^_.+-]{0,62}\/[a-z0-9][a-z0-9!#$&^_.+-]{0,62}$/.test(base)) {
    throw badRequest('That file type is not supported');
  }
  return base;
}

/**
 * Authorize a download.
 *
 * Membership is re-checked on every fetch, so revoking someone from a group
 * immediately cuts off their access to that group's media — an id alone is
 * never sufficient (this is the direct-object-reference case).
 */
export async function openAttachment(
  attachmentId: string,
  viewerId: string,
): Promise<{ stream: Readable; mimeType: string; size: number }> {
  const attachment = await prisma.attachment.findUnique({
    where: { id: attachmentId },
    select: {
      id: true,
      chatId: true,
      uploaderId: true,
      messageId: true,
      mimeType: true,
      encryptedSize: true,
      storageKey: true,
      message: { select: { seq: true, deletedAt: true } },
    },
  });
  if (!attachment) throw notFound('That file is no longer available');

  const membership = await requireMembership(attachment.chatId, viewerId).catch(
    () => null,
  );
  if (!membership) throw notFound('That file is no longer available');

  if (attachment.message) {
    if (attachment.message.deletedAt) {
      throw notFound('That file is no longer available');
    }
    // Members only see media from messages posted after they joined.
    if (attachment.message.seq < membership.joinedAtSeq) {
      throw notFound('That file is no longer available');
    }
  } else if (attachment.uploaderId !== viewerId) {
    // Not yet attached to a message — only its uploader can fetch it back.
    throw forbidden('That file is not available yet');
  }

  return {
    stream: readBlobStream(attachment.storageKey),
    mimeType: attachment.mimeType,
    size: attachment.encryptedSize,
  };
}

export async function deleteAttachment(
  attachmentId: string,
  actorId: string,
): Promise<void> {
  const attachment = await prisma.attachment.findUnique({
    where: { id: attachmentId },
    select: { id: true, uploaderId: true, messageId: true, storageKey: true },
  });
  if (!attachment) return;
  if (attachment.uploaderId !== actorId) {
    throw forbidden('You can only remove your own uploads');
  }
  if (attachment.messageId) {
    throw badRequest('Delete the message to remove this file');
  }
  await prisma.attachment.delete({ where: { id: attachmentId } });
  await deleteBlob(attachment.storageKey);
}

/**
 * Sweep blobs that were uploaded but never attached to a message — an upload
 * the user cancelled, or a send that failed after the upload succeeded.
 */
export async function sweepOrphanAttachments(
  olderThanMs = 6 * 60 * 60 * 1000,
): Promise<number> {
  const cutoff = new Date(Date.now() - olderThanMs);
  const orphans = await prisma.attachment.findMany({
    where: { messageId: null, createdAt: { lt: cutoff } },
    select: { id: true, storageKey: true },
    take: 500,
  });
  if (orphans.length === 0) return 0;

  await prisma.attachment.deleteMany({
    where: { id: { in: orphans.map((o) => o.id) } },
  });
  await deleteBlobs(orphans.map((o) => o.storageKey));
  logger.info({ count: orphans.length }, 'swept orphaned attachments');
  return orphans.length;
}
