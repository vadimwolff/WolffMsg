/**
 * The device key vault.
 *
 * How private keys are protected in a browser
 * ───────────────────────────────────────────
 * A browser has no secure enclave a web page can reach, so "protected" has to
 * mean something concrete. What it means here:
 *
 *   1. A 256-bit AES-GCM key is generated with `extractable: false`. The
 *      browser will hand a reference to it to JavaScript, but there is no API
 *      by which JavaScript can read its bytes — `exportKey` throws.
 *   2. That reference is stored in IndexedDB, which structured-clones
 *      `CryptoKey` objects without ever materialising the key material in the
 *      JavaScript heap.
 *   3. The device's identity and prekey private halves are serialised, sealed
 *      under that key, and only the ciphertext is stored.
 *
 * The honest limit: script running on this origin can still *use* the vault key
 * to decrypt, because that is the whole point of it being usable. What it
 * cannot do is copy the key somewhere else. An XSS bug therefore becomes a
 * "read messages while the attacker's code runs" problem rather than a
 * "permanently clone this identity" one. That is a meaningful reduction, not
 * an elimination, and SECURITY.md says so.
 *
 * Nothing here ever touches localStorage.
 */
import {
  exportVault,
  importVault,
  type DeviceSecrets,
  type EncryptedVault,
} from '@wolffmsg/shared';
import { STORE_VAULT, idbDelete, idbGet, idbPut } from '../lib/idb.ts';

const VAULT_KEY_HANDLE = 'device-key';
const VAULT_PAYLOAD = 'device-secrets';
const IV_BYTES = 12;

export class VaultError extends Error {
  constructor(
    message: string,
    readonly reason: 'unavailable' | 'missing' | 'corrupt',
  ) {
    super(message);
    this.name = 'VaultError';
  }
}

interface SealedSecrets {
  v: 1;
  iv: Uint8Array<ArrayBuffer>;
  ciphertext: ArrayBuffer;
}

function assertCryptoAvailable(): void {
  if (typeof crypto === 'undefined' || !crypto.subtle) {
    throw new VaultError(
      'This browser does not expose the Web Crypto API. WolffMsg needs it to ' +
        'protect your keys, and will not run without it.',
      'unavailable',
    );
  }
}

/**
 * Fetch the vault key, creating it on first use.
 *
 * `extractable: false` is the single most important argument in this file.
 */
async function getVaultKey(): Promise<CryptoKey> {
  assertCryptoAvailable();

  const existing = await idbGet<CryptoKey>(STORE_VAULT, VAULT_KEY_HANDLE);
  if (existing) return existing;

  const key = await crypto.subtle.generateKey(
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
  await idbPut(STORE_VAULT, key, VAULT_KEY_HANDLE);
  return key;
}

/** Seal the device's private key material and store the ciphertext. */
export async function saveSecrets(secrets: DeviceSecrets): Promise<void> {
  const key = await getVaultKey();
  const iv = crypto.getRandomValues(new Uint8Array(new ArrayBuffer(IV_BYTES)));
  const plaintext = new TextEncoder().encode(JSON.stringify(secrets));

  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    key,
    plaintext,
  );
  plaintext.fill(0);

  const sealed: SealedSecrets = { v: 1, iv, ciphertext };
  await idbPut(STORE_VAULT, sealed, VAULT_PAYLOAD);
}

/** Open the vault. Returns `null` when this device has no identity yet. */
export async function loadSecrets(): Promise<DeviceSecrets | null> {
  assertCryptoAvailable();

  const sealed = await idbGet<SealedSecrets>(STORE_VAULT, VAULT_PAYLOAD);
  if (!sealed) return null;

  const key = await idbGet<CryptoKey>(STORE_VAULT, VAULT_KEY_HANDLE);
  if (!key) {
    // Ciphertext survived but the key did not. Unrecoverable by design — the
    // caller must register a fresh device.
    throw new VaultError(
      'This device’s key vault is damaged and its keys cannot be recovered.',
      'corrupt',
    );
  }

  let opened: ArrayBuffer;
  try {
    opened = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: sealed.iv },
      key,
      sealed.ciphertext,
    );
  } catch {
    throw new VaultError(
      'This device’s key vault could not be opened.',
      'corrupt',
    );
  }

  try {
    return JSON.parse(new TextDecoder().decode(opened)) as DeviceSecrets;
  } catch {
    throw new VaultError('Stored key material is malformed.', 'corrupt');
  }
}

export async function hasSecrets(): Promise<boolean> {
  const sealed = await idbGet<SealedSecrets>(STORE_VAULT, VAULT_PAYLOAD);
  return Boolean(sealed);
}

/**
 * Destroy the vault.
 *
 * Removing the non-extractable key is what makes this final: even a forensic
 * recovery of the ciphertext from disk has nothing to open it with.
 */
export async function destroyVault(): Promise<void> {
  await idbDelete(STORE_VAULT, VAULT_PAYLOAD).catch(() => undefined);
  await idbDelete(STORE_VAULT, VAULT_KEY_HANDLE).catch(() => undefined);
}

/**
 * Export the identity under a passphrase, for moving to another device.
 *
 * This is the one path that turns the keys into something portable, so it is
 * gated behind an explicit user action and an Argon2id-derived key.
 */
export async function exportBackup(passphrase: string): Promise<EncryptedVault> {
  const secrets = await loadSecrets();
  if (!secrets) {
    throw new VaultError('There is no identity on this device to export.', 'missing');
  }
  return exportVault(secrets, passphrase);
}

export async function importBackup(
  vault: EncryptedVault,
  passphrase: string,
): Promise<DeviceSecrets> {
  const secrets = importVault(vault, passphrase);
  await saveSecrets(secrets);
  return secrets;
}

/**
 * Confirm the browser really refuses to export the vault key.
 *
 * Run once at startup. If a browser (or an extension shimming Web Crypto) does
 * hand the bytes over, the security model this file describes does not hold,
 * and we would rather know than assume.
 */
export async function verifyKeyIsNonExtractable(): Promise<boolean> {
  try {
    const key = await getVaultKey();
    if (key.extractable) return false;
    await crypto.subtle.exportKey('raw', key);
    // Reaching here means the export succeeded, which it must not.
    return false;
  } catch {
    return true;
  }
}
