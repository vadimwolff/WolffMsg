import { hash, verify } from '@node-rs/argon2';
import { logger } from '../logger.js';

/**
 * `Algorithm.Argon2id` from @node-rs/argon2 is an ambient `const enum`, which
 * cannot be referenced under `isolatedModules`. Its value is 2; a test asserts
 * that this constant really does select Argon2id, so a library change cannot
 * silently downgrade us to Argon2i.
 */
const ARGON2ID = 2;

/**
 * Argon2id parameters.
 *
 * 64 MiB / 3 passes / 4 lanes sits above the OWASP 2024 minimum (19 MiB,
 * 2 iterations) with headroom, and costs roughly 60 ms on a modern server
 * core — slow enough to hurt an offline cracker, fast enough that a login
 * request is not noticeably delayed.
 */
const PARAMS = {
  algorithm: ARGON2ID,
  memoryCost: 65_536,
  timeCost: 3,
  parallelism: 4,
} as const;

export async function hashPassword(plaintext: string): Promise<string> {
  return hash(plaintext, PARAMS);
}

/**
 * Verify a password. Returns false on *any* failure, including a malformed
 * stored hash — never throws into the request path, and never distinguishes
 * "wrong password" from "corrupt record" to the caller.
 */
export async function verifyPassword(
  storedHash: string,
  plaintext: string,
): Promise<boolean> {
  try {
    return await verify(storedHash, plaintext, PARAMS);
  } catch (err) {
    logger.warn({ err }, 'password verification failed to run');
    return false;
  }
}

/**
 * A pre-computed hash of a random value, used to burn the same CPU time on a
 * login attempt for a username that does not exist. Without this, response
 * timing tells an attacker which usernames are registered.
 */
let decoyHash: Promise<string> | null = null;

export function decoyVerify(plaintext: string): Promise<boolean> {
  if (!decoyHash) {
    decoyHash = hashPassword(
      // Not a secret — its only job is to exist so verify() has work to do.
      'wolffmsg-timing-equaliser-' + Math.random().toString(36),
    );
  }
  return decoyHash.then((h) => verifyPassword(h, plaintext));
}

/**
 * Whether a stored hash was produced with weaker parameters than we now use,
 * in which case it is transparently upgraded on the next successful login.
 */
export function needsRehash(storedHash: string): boolean {
  const match = /^\$argon2id\$v=19\$m=(\d+),t=(\d+),p=(\d+)\$/.exec(storedHash);
  if (!match) return true;
  const [, m, t, p] = match;
  return (
    Number(m) < PARAMS.memoryCost ||
    Number(t) < PARAMS.timeCost ||
    Number(p) < PARAMS.parallelism
  );
}
