/**
 * Passphrase-protected export of a device's private keys.
 *
 * This is the *backup* path, used when a user deliberately moves their
 * identity to another device. Day-to-day, keys live in the browser key vault
 * (see `packages/web/src/crypto/keyVault.ts`) wrapped by a non-extractable
 * WebCrypto key — they are never serialised to a passphrase-only blob unless
 * the user explicitly asks for an export.
 *
 * Key derivation is Argon2id (libsodium `crypto_pwhash`), so a weak passphrase
 * still costs real memory and time to attack.
 */
import { fromB64, fromUtf8, randomBytes, sodium, toB64, utf8, wipe } from './sodium.js';
import type { DeviceSecrets } from './identity.js';

export interface EncryptedVault {
  v: 1;
  kdf: 'argon2id';
  /** base64 16-byte salt. */
  salt: string;
  opsLimit: number;
  memLimit: number;
  /** base64 24-byte nonce. */
  nonce: string;
  /** base64 XChaCha20-Poly1305 ciphertext. */
  ciphertext: string;
}

/** Argon2id cost. `MODERATE` ≈ 256 MiB / ~0.7 s on a modern laptop. */
function costs(): { opsLimit: number; memLimit: number } {
  const s = sodium();
  return {
    opsLimit: s.crypto_pwhash_OPSLIMIT_MODERATE,
    memLimit: s.crypto_pwhash_MEMLIMIT_MODERATE,
  };
}

function deriveKey(
  passphrase: string,
  salt: Uint8Array,
  opsLimit: number,
  memLimit: number,
): Uint8Array {
  const s = sodium();
  return s.crypto_pwhash(
    s.crypto_aead_xchacha20poly1305_ietf_KEYBYTES,
    passphrase,
    salt,
    opsLimit,
    memLimit,
    s.crypto_pwhash_ALG_ARGON2ID13,
  );
}

export function exportVault(
  secrets: DeviceSecrets,
  passphrase: string,
): EncryptedVault {
  const s = sodium();
  const { opsLimit, memLimit } = costs();
  const salt = randomBytes(s.crypto_pwhash_SALTBYTES);
  const nonce = randomBytes(s.crypto_aead_xchacha20poly1305_ietf_NPUBBYTES);
  const key = deriveKey(passphrase, salt, opsLimit, memLimit);

  try {
    const ciphertext = s.crypto_aead_xchacha20poly1305_ietf_encrypt(
      utf8(JSON.stringify(secrets)),
      utf8('wolffmsg:vault:v1'),
      null,
      nonce,
      key,
    );
    return {
      v: 1,
      kdf: 'argon2id',
      salt: toB64(salt),
      opsLimit,
      memLimit,
      nonce: toB64(nonce),
      ciphertext: toB64(ciphertext),
    };
  } finally {
    wipe(key);
  }
}

export class VaultUnlockError extends Error {
  constructor() {
    super('Incorrect passphrase, or the backup file is damaged');
    this.name = 'VaultUnlockError';
  }
}

export function importVault(
  vault: EncryptedVault,
  passphrase: string,
): DeviceSecrets {
  const s = sodium();
  if (vault.v !== 1 || vault.kdf !== 'argon2id') {
    throw new VaultUnlockError();
  }
  const key = deriveKey(
    passphrase,
    fromB64(vault.salt),
    vault.opsLimit,
    vault.memLimit,
  );
  try {
    const opened = s.crypto_aead_xchacha20poly1305_ietf_decrypt(
      null,
      fromB64(vault.ciphertext),
      utf8('wolffmsg:vault:v1'),
      fromB64(vault.nonce),
      key,
    );
    return JSON.parse(fromUtf8(opened)) as DeviceSecrets;
  } catch {
    throw new VaultUnlockError();
  } finally {
    wipe(key);
  }
}
