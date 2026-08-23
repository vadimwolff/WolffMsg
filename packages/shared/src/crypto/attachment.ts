/**
 * Attachment encryption.
 *
 * Files are encrypted with `crypto_secretstream_xchacha20poly1305`, which is
 * libsodium's authenticated streaming construction. Each 64 KiB frame carries
 * its own Poly1305 tag and is chained to the previous one, so the server can
 * neither read a chunk, reorder chunks, nor truncate the stream without the
 * recipient noticing.
 *
 * The per-file key lives inside the *message* plaintext, so it inherits the
 * message's end-to-end protection: possession of the blob alone is useless.
 */
import { fromB64, randomBytes, sodium, toB64, wipe } from './sodium.js';
import { ATTACHMENT_CHUNK_SIZE } from '../constants.js';

export interface AttachmentCipher {
  /** base64 32-byte stream key. Travels inside the encrypted message body. */
  key: string;
  /** base64 24-byte stream header. Needed to start decryption. */
  header: string;
  /** The encrypted bytes, ready to upload. */
  data: Uint8Array;
}

/**
 * Ciphertext size for a given plaintext size — useful for upload progress and
 * for the server's size-limit check. The stream header is carried alongside
 * the blob (inside the encrypted message body), not prepended to it, so it is
 * deliberately not counted here.
 */
export function encryptedSizeFor(plaintextBytes: number): number {
  const s = sodium();
  const chunks = Math.max(1, Math.ceil(plaintextBytes / ATTACHMENT_CHUNK_SIZE));
  return plaintextBytes + chunks * s.crypto_secretstream_xchacha20poly1305_ABYTES;
}

/**
 * Encrypt a whole buffer. `onProgress` receives a 0–1 fraction so the UI can
 * show a real progress bar rather than an indeterminate spinner.
 */
export function encryptAttachment(
  plaintext: Uint8Array,
  onProgress?: (fraction: number) => void,
): AttachmentCipher {
  const s = sodium();
  const key = s.crypto_secretstream_xchacha20poly1305_keygen();
  try {
    const { state, header } =
      s.crypto_secretstream_xchacha20poly1305_init_push(key);

    const total = Math.max(1, Math.ceil(plaintext.length / ATTACHMENT_CHUNK_SIZE));
    const frames: Uint8Array[] = [];

    for (let i = 0; i < total; i += 1) {
      const start = i * ATTACHMENT_CHUNK_SIZE;
      const chunk = plaintext.subarray(start, start + ATTACHMENT_CHUNK_SIZE);
      const isFinal = i === total - 1;
      frames.push(
        s.crypto_secretstream_xchacha20poly1305_push(
          state,
          chunk,
          null,
          isFinal
            ? s.crypto_secretstream_xchacha20poly1305_TAG_FINAL
            : s.crypto_secretstream_xchacha20poly1305_TAG_MESSAGE,
        ),
      );
      onProgress?.((i + 1) / total);
    }

    const size = frames.reduce((n, f) => n + f.length, 0);
    const data = new Uint8Array(size);
    let offset = 0;
    for (const f of frames) {
      data.set(f, offset);
      offset += f.length;
    }

    return { key: toB64(key), header: toB64(header), data };
  } finally {
    wipe(key);
  }
}

export class AttachmentDecryptionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AttachmentDecryptionError';
  }
}

/**
 * Decrypt a whole encrypted blob back to plaintext.
 *
 * Throws unless the stream ends with a FINAL tag — a truncated download is
 * treated as tampering rather than silently producing a partial file.
 */
export function decryptAttachment(
  encrypted: Uint8Array,
  keyB64: string,
  headerB64: string,
  onProgress?: (fraction: number) => void,
): Uint8Array {
  const s = sodium();
  const key = fromB64(keyB64);
  const frameSize = ATTACHMENT_CHUNK_SIZE + s.crypto_secretstream_xchacha20poly1305_ABYTES;

  try {
    const state = s.crypto_secretstream_xchacha20poly1305_init_pull(
      fromB64(headerB64),
      key,
    );

    const parts: Uint8Array[] = [];
    let sawFinal = false;
    const total = Math.max(1, Math.ceil(encrypted.length / frameSize));

    for (let i = 0; i * frameSize < encrypted.length; i += 1) {
      const frame = encrypted.subarray(i * frameSize, (i + 1) * frameSize);
      // Depending on build, libsodium either throws or returns `false` when a
      // frame fails authentication. Handle both.
      const result = s.crypto_secretstream_xchacha20poly1305_pull(
        state,
        frame,
        null,
      ) as { message: Uint8Array; tag: number } | false;
      if (result === false) {
        throw new AttachmentDecryptionError(
          'Attachment failed its integrity check',
        );
      }
      parts.push(result.message);
      if (result.tag === s.crypto_secretstream_xchacha20poly1305_TAG_FINAL) {
        sawFinal = true;
      }
      onProgress?.((i + 1) / total);
    }

    if (!sawFinal) {
      throw new AttachmentDecryptionError('Attachment stream was truncated');
    }

    const size = parts.reduce((n, p) => n + p.length, 0);
    const out = new Uint8Array(size);
    let offset = 0;
    for (const p of parts) {
      out.set(p, offset);
      offset += p.length;
    }
    return out;
  } catch (err) {
    if (err instanceof AttachmentDecryptionError) throw err;
    throw new AttachmentDecryptionError('Could not decrypt attachment');
  } finally {
    wipe(key);
  }
}

/**
 * Incremental encryptor for large files, so a 500 MB video never has to be
 * fully resident in memory. Feed it slices; it emits upload-ready frames.
 */
export class AttachmentEncryptStream {
  readonly key: string;
  readonly header: string;
  private readonly state: unknown;
  private closed = false;

  constructor() {
    const s = sodium();
    const rawKey = s.crypto_secretstream_xchacha20poly1305_keygen();
    const { state, header } =
      s.crypto_secretstream_xchacha20poly1305_init_push(rawKey);
    this.state = state;
    this.key = toB64(rawKey);
    this.header = toB64(header);
    wipe(rawKey);
  }

  /** Encrypt one plaintext chunk. Must be exactly ATTACHMENT_CHUNK_SIZE unless final. */
  push(chunk: Uint8Array, isFinal: boolean): Uint8Array {
    if (this.closed) throw new Error('Stream already finalised');
    const s = sodium();
    if (isFinal) this.closed = true;
    return s.crypto_secretstream_xchacha20poly1305_push(
      this.state as never,
      chunk,
      null,
      isFinal
        ? s.crypto_secretstream_xchacha20poly1305_TAG_FINAL
        : s.crypto_secretstream_xchacha20poly1305_TAG_MESSAGE,
    );
  }
}

/** Compute a small amplitude envelope for voice-message waveform rendering. */
export function waveformFromSamples(samples: Float32Array, buckets = 48): number[] {
  if (samples.length === 0) return new Array<number>(buckets).fill(0);
  const perBucket = Math.max(1, Math.floor(samples.length / buckets));
  const out: number[] = [];
  for (let b = 0; b < buckets; b += 1) {
    let peak = 0;
    const start = b * perBucket;
    for (let i = start; i < Math.min(start + perBucket, samples.length); i += 1) {
      const v = Math.abs(samples[i] ?? 0);
      if (v > peak) peak = v;
    }
    out.push(Math.round(Math.min(1, peak) * 100) / 100);
  }
  return out;
}

/** Generate a fresh random key without encrypting anything (for thumbnails). */
export function newAttachmentKey(): string {
  return toB64(randomBytes(32));
}
