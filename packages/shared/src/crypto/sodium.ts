/**
 * Thin, typed access layer over libsodium.
 *
 * WolffMsg performs **no** custom cryptography. Every primitive used by the
 * protocol comes from libsodium (compiled to WebAssembly via
 * `libsodium-wrappers-sumo`), which is the same audited implementation used
 * by Signal, Wire and WireGuard userspace tooling.
 *
 * The primitives in use are:
 *   - Ed25519                         — device identity signatures
 *   - X25519 sealed boxes             — anonymous public-key key wrapping
 *   - XChaCha20-Poly1305-IETF (AEAD)  — message body encryption
 *   - XChaCha20-Poly1305 secretstream — chunked attachment encryption
 *   - BLAKE2b                         — fingerprints / safety numbers
 *   - Argon2id                        — passphrase-based key derivation
 *   - libsodium CSPRNG                — all random material
 */
import _sodium from 'libsodium-wrappers-sumo';

export type Sodium = typeof _sodium;

let readyPromise: Promise<Sodium> | null = null;

/**
 * Resolve once the WASM runtime is initialised. Safe to call concurrently and
 * repeatedly — initialisation happens exactly once per process/tab.
 */
export async function initCrypto(): Promise<Sodium> {
  if (!readyPromise) {
    readyPromise = (async () => {
      await _sodium.ready;
      return _sodium;
    })();
  }
  return readyPromise;
}

/**
 * Synchronous accessor for code paths that already awaited {@link initCrypto}.
 * Throws rather than silently operating on an uninitialised WASM heap.
 */
export function sodium(): Sodium {
  if (!_sodium.crypto_sign_keypair) {
    throw new Error('libsodium is not initialised — await initCrypto() first');
  }
  return _sodium;
}

/* ────────────────────────────── encoding helpers ────────────────────────── */

export function toB64(bytes: Uint8Array): string {
  return sodium().to_base64(bytes, _sodium.base64_variants.ORIGINAL);
}

export function fromB64(text: string): Uint8Array {
  return sodium().from_base64(text, _sodium.base64_variants.ORIGINAL);
}

export function toB64Url(bytes: Uint8Array): string {
  return sodium().to_base64(bytes, _sodium.base64_variants.URLSAFE_NO_PADDING);
}

export function fromB64Url(text: string): Uint8Array {
  return sodium().from_base64(text, _sodium.base64_variants.URLSAFE_NO_PADDING);
}

export function utf8(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

export function fromUtf8(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes);
}

export function randomBytes(length: number): Uint8Array {
  return sodium().randombytes_buf(length);
}

/**
 * Cryptographically secure random identifier, URL-safe and collision-resistant
 * (128 bits of entropy by default).
 */
export function randomId(byteLength = 16): string {
  return toB64Url(randomBytes(byteLength));
}

/** Constant-time comparison. Use for any secret-dependent equality check. */
export function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  return sodium().memcmp(a, b);
}

/** Overwrite key material in place once it is no longer needed. */
export function wipe(bytes: Uint8Array): void {
  sodium().memzero(bytes);
}

export function concat(...parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
}
