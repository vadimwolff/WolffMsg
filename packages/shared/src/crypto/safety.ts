/**
 * Safety numbers — the human-comparable fingerprint two people read out loud
 * (or scan) to confirm that no one is sitting in the middle.
 *
 * The number is derived from both participants' identity public keys. It is
 * symmetric: both sides compute the same 60 digits, and it changes the instant
 * either side's identity key changes.
 */
import { concat, fromB64, sodium, utf8 } from './sodium.js';
import { HASH_CONTEXT_SAFETY } from '../constants.js';

export interface SafetyParty {
  userId: string;
  identityPublicKey: string;
}

/**
 * Iterated BLAKE2b over the party material. The iteration count makes brute
 * forcing a colliding identity key expensive, mirroring the rationale behind
 * Signal's iterated fingerprint derivation.
 */
function derive(parties: SafetyParty[], iterations = 5_200): Uint8Array {
  const s = sodium();
  const sorted = [...parties].sort((a, b) =>
    a.userId < b.userId ? -1 : a.userId > b.userId ? 1 : 0,
  );

  let acc = concat(
    utf8(HASH_CONTEXT_SAFETY),
    ...sorted.flatMap((p) => [utf8(p.userId), fromB64(p.identityPublicKey)]),
  );

  for (let i = 0; i < iterations; i += 1) {
    acc = s.crypto_generichash(32, acc);
  }
  return acc;
}

/**
 * 60 decimal digits, rendered as 12 space-separated groups of 5.
 * Stable across both devices in a conversation.
 */
export function safetyNumber(a: SafetyParty, b: SafetyParty): string {
  const digest = derive([a, b]);
  const groups: string[] = [];
  for (let i = 0; i < 12; i += 1) {
    // Five bytes per group → a 40-bit integer, reduced to five digits.
    let value = 0;
    for (let j = 0; j < 5; j += 1) {
      value = value * 256 + (digest[(i * 5 + j) % digest.length] ?? 0);
    }
    groups.push(String(value % 100_000).padStart(5, '0'));
  }
  return groups.join(' ');
}

/** Compact string suitable for a QR code. */
export function safetyQrPayload(a: SafetyParty, b: SafetyParty): string {
  return `wolffmsg:verify:1:${safetyNumber(a, b).replace(/ /g, '')}`;
}

/**
 * A single device's own fingerprint, shown on the Security screen so a user
 * can read their device identity independently of any conversation.
 */
export function deviceFingerprint(identityPublicKey: string): string {
  const s = sodium();
  const digest = s.crypto_generichash(20, fromB64(identityPublicKey));
  return Array.from(digest)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
    .toUpperCase()
    .replace(/(.{4})/g, '$1 ')
    .trim();
}
