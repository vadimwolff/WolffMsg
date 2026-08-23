/**
 * The only module allowed to touch `localStorage`.
 *
 * `localStorage` is readable by any script that runs on the page, so a single
 * XSS reads everything in it. Nothing secret may go here: device keys live in
 * the non-extractable IndexedDB vault (`crypto/keyVault.ts`), and decrypted
 * message content lives in an IndexedDB store that sign-out destroys.
 *
 * What is left is a short list of non-secret preferences that genuinely need
 * to survive a reload *and* be readable synchronously — the theme, so the
 * inline script in `index.html` can paint before React mounts, and the chosen
 * server, so a published client remembers where it points. Funnelling them
 * through here keeps that list short and reviewable, and means the lint rule
 * banning `localStorage` needs exactly one documented exception.
 *
 * Every access is guarded: storage can be disabled outright (private windows,
 * blocked site data), and reading a preference must never stop the app.
 */

/* eslint-disable no-restricted-globals -- the one audited place; see above. */

/** Read a preference, or `null` if it is absent or storage is unavailable. */
export function readPref(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

/** Write a preference. Silently does nothing when storage is unavailable. */
export function writePref(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* the preference simply does not persist */
  }
}

/** Remove a preference. */
export function removePref(key: string): void {
  try {
    localStorage.removeItem(key);
  } catch {
    /* nothing to undo */
  }
}

/* eslint-enable no-restricted-globals */

/** Keys in use, named here so the whole list is visible in one place. */
export const PREF = {
  /** Theme, accent, density — read by the inline script in index.html. */
  appearance: 'wolff.appearance',
  /** The API origin a published client was pointed at. */
  serverOrigin: 'wolffmsg.server-origin',
} as const;
