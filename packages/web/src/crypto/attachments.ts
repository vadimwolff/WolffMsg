/**
 * Attachment upload and download, client side.
 *
 * The file is encrypted here, before it goes anywhere. The server receives an
 * opaque blob and a declared type; the key that opens it travels inside the
 * message ciphertext, so possessing the blob is useless on its own.
 */
import {
  decryptAttachment,
  encryptAttachment,
  type PlaintextAttachment,
} from '@wolffmsg/shared';
import { api, type UploadHandle } from '../lib/api.ts';

export interface UploadProgress {
  /** 0–1 across both phases. */
  fraction: number;
  phase: 'encrypting' | 'uploading' | 'done';
}

export interface PreparedAttachment {
  descriptor: PlaintextAttachment;
  encryptedSize: number;
}

export interface AttachmentUpload {
  promise: Promise<PreparedAttachment>;
  cancel: () => void;
}

/**
 * Encrypt and upload one file.
 *
 * Progress spans both phases so the UI shows one continuous bar rather than
 * jumping. Encryption is weighted at 30% — roughly what it costs relative to
 * the network on a typical connection.
 */
export function uploadAttachment(
  file: File,
  chatId: string,
  onProgress?: (progress: UploadProgress) => void,
  extra: { width?: number; height?: number; durationMs?: number } = {},
): AttachmentUpload {
  let handle: UploadHandle<{ id: string; encryptedSize: number }> | null = null;
  let cancelled = false;

  const promise = (async (): Promise<PreparedAttachment> => {
    const plaintext = new Uint8Array(await file.arrayBuffer());

    const cipher = encryptAttachment(plaintext, (fraction) => {
      onProgress?.({ fraction: fraction * 0.3, phase: 'encrypting' });
    });
    plaintext.fill(0);

    if (cancelled) throw Object.assign(new Error('Cancelled'), { name: 'AbortError' });

    const blob = new Blob([cipher.data as BlobPart], {
      type: 'application/octet-stream',
    });

    handle = api.upload<{ id: string; encryptedSize: number }>(
      `/api/attachments?chatId=${encodeURIComponent(chatId)}` +
        `&mimeType=${encodeURIComponent(normaliseType(file))}`,
      blob,
      {
        // A neutral filename: the real one lives inside the encrypted message.
        filename: 'blob',
        onProgress: (fraction) =>
          onProgress?.({ fraction: 0.3 + fraction * 0.7, phase: 'uploading' }),
      },
    );

    const uploaded = await handle.promise;
    onProgress?.({ fraction: 1, phase: 'done' });

    return {
      descriptor: {
        id: uploaded.id,
        name: file.name,
        mimeType: normaliseType(file),
        size: file.size,
        key: cipher.key,
        header: cipher.header,
        ...(extra.width !== undefined ? { width: extra.width } : {}),
        ...(extra.height !== undefined ? { height: extra.height } : {}),
        ...(extra.durationMs !== undefined ? { durationMs: extra.durationMs } : {}),
      },
      encryptedSize: uploaded.encryptedSize,
    };
  })();

  return {
    promise,
    cancel: () => {
      cancelled = true;
      handle?.cancel();
    },
  };
}

/**
 * Browsers sometimes report an empty or eccentric type. Fall back to a generic
 * one rather than sending something the server's allow-list will reject.
 */
function normaliseType(file: File): string {
  const declared = (file.type ?? '').split(';')[0]?.trim().toLowerCase() ?? '';
  if (!declared) return 'application/octet-stream';
  if (declared === 'image/jpg') return 'image/jpeg';
  return declared;
}

/* ───────────────────────────── downloading ─────────────────────────────── */

const objectUrls = new Map<string, string>();

/**
 * Fetch, decrypt and hand back an object URL.
 *
 * URLs are cached per attachment because a message can be re-rendered many
 * times, and every render must not mean another download-and-decrypt.
 */
export async function openAttachment(
  descriptor: PlaintextAttachment,
  onProgress?: (fraction: number) => void,
): Promise<string> {
  const cached = objectUrls.get(descriptor.id);
  if (cached) return cached;

  const encrypted = await api.bytes(
    `/api/attachments/${encodeURIComponent(descriptor.id)}`,
  );
  const plaintext = decryptAttachment(
    encrypted,
    descriptor.key,
    descriptor.header,
    onProgress,
  );

  // The blob is given the *real* type here, on the client, where it is safe:
  // this URL is only ever consumed by our own <img>/<video>/<audio> element.
  const blob = new Blob([plaintext as BlobPart], { type: descriptor.mimeType });
  const url = URL.createObjectURL(blob);
  objectUrls.set(descriptor.id, url);
  return url;
}

/** Download to disk under the sender's original filename. */
export async function saveAttachment(
  descriptor: PlaintextAttachment,
): Promise<void> {
  const url = await openAttachment(descriptor);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = safeFilename(descriptor.name);
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
}

/**
 * Sanitise the filename before handing it to the download attribute.
 *
 * The name came from another user, so it must not be able to escape the
 * downloads directory or hide its extension behind control characters.
 */
function safeFilename(name: string): string {
  const cleaned = name
    // eslint-disable-next-line no-control-regex -- stripping them is the point
    .replace(/[\u0000-\u001F\u007F]/g, '')
    .replace(/[\u202A-\u202E\u2066-\u2069]/g, '')
    .replace(/[/\\]/g, '_')
    .replace(/^\.+/, '')
    .trim();
  return cleaned.slice(0, 120) || 'download';
}

export function releaseAttachment(attachmentId: string): void {
  const url = objectUrls.get(attachmentId);
  if (url) {
    URL.revokeObjectURL(url);
    objectUrls.delete(attachmentId);
  }
}

export function releaseAllAttachments(): void {
  for (const url of objectUrls.values()) URL.revokeObjectURL(url);
  objectUrls.clear();
}

/** Read an image's natural size, so the bubble can reserve space before load. */
export function imageDimensions(
  file: File,
): Promise<{ width: number; height: number } | null> {
  return new Promise((resolve) => {
    if (!file.type.startsWith('image/')) return resolve(null);
    const url = URL.createObjectURL(file);
    const image = new Image();
    image.onload = () => {
      URL.revokeObjectURL(url);
      resolve({ width: image.naturalWidth, height: image.naturalHeight });
    };
    image.onerror = () => {
      URL.revokeObjectURL(url);
      resolve(null);
    };
    image.src = url;
  });
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}
