/**
 * Validation shared by client and server.
 *
 * The client uses these for instant feedback; the server re-runs every one of
 * them on the request it actually receives. Client-side validation is a
 * courtesy, never a control.
 */
import { LIMITS, USERNAME_PATTERN } from './constants.js';

export interface FieldProblem {
  field: string;
  message: string;
}

export function validateUsername(value: string): FieldProblem | null {
  if (!value) return { field: 'username', message: 'Username is required' };
  if (!USERNAME_PATTERN.test(value)) {
    return {
      field: 'username',
      message: `${LIMITS.usernameMin}–${LIMITS.usernameMax} characters, lowercase letters, digits and underscores only`,
    };
  }
  return null;
}

/**
 * Password policy. Length is the dominant factor, so the floor is high and
 * composition rules are deliberately light — we reject the obviously weak
 * rather than forcing unmemorable patterns.
 */
export function validatePassword(value: string): FieldProblem | null {
  if (!value) return { field: 'password', message: 'Password is required' };
  if (value.length < LIMITS.passwordMin) {
    return {
      field: 'password',
      message: `At least ${LIMITS.passwordMin} characters`,
    };
  }
  if (value.length > LIMITS.passwordMax) {
    return { field: 'password', message: 'That password is too long' };
  }
  if (/^(.)\1+$/.test(value)) {
    return { field: 'password', message: 'Choose something less repetitive' };
  }
  if (COMMON_PASSWORDS.has(value.toLowerCase())) {
    return { field: 'password', message: 'That password is too common' };
  }
  return null;
}

export function validateDisplayName(value: string): FieldProblem | null {
  const trimmed = value.trim();
  if (!trimmed) return { field: 'displayName', message: 'Display name is required' };
  if (trimmed.length > LIMITS.displayNameMax) {
    return {
      field: 'displayName',
      message: `At most ${LIMITS.displayNameMax} characters`,
    };
  }
  if (containsControlChars(trimmed)) {
    return { field: 'displayName', message: 'Contains characters that are not allowed' };
  }
  return null;
}

export function validateBio(value: string | null): FieldProblem | null {
  if (value == null) return null;
  if (value.length > LIMITS.bioMax) {
    return { field: 'bio', message: `At most ${LIMITS.bioMax} characters` };
  }
  if (containsControlChars(value, true)) {
    return { field: 'bio', message: 'Contains characters that are not allowed' };
  }
  return null;
}

export function validateChatTitle(value: string): FieldProblem | null {
  const trimmed = value.trim();
  if (!trimmed) return { field: 'title', message: 'Give the group a name' };
  if (trimmed.length > LIMITS.chatTitleMax) {
    return { field: 'title', message: `At most ${LIMITS.chatTitleMax} characters` };
  }
  if (containsControlChars(trimmed)) {
    return { field: 'title', message: 'Contains characters that are not allowed' };
  }
  return null;
}

/**
 * Reject control characters and bidirectional overrides. The latter are the
 * "Trojan Source" trick — they can make a display name render as something
 * entirely different from the bytes actually stored.
 */
function containsControlChars(value: string, allowNewlines = false): boolean {
  for (const ch of value) {
    const code = ch.codePointAt(0) ?? 0;
    if (allowNewlines && (code === 0x0a || code === 0x0d)) continue;
    if (code < 0x20 || code === 0x7f) return true;
    // U+202A–U+202E and U+2066–U+2069: bidi embedding / isolate overrides.
    if ((code >= 0x202a && code <= 0x202e) || (code >= 0x2066 && code <= 0x2069)) {
      return true;
    }
  }
  return false;
}

/** Trim, collapse runs of whitespace, and drop disallowed control characters. */
export function normalizeDisplayText(value: string): string {
  return value
    // eslint-disable-next-line no-control-regex -- stripping them is the point
    .replace(/[\u0000-\u001F\u007F]/g, '')
    .replace(/[\u202A-\u202E\u2066-\u2069]/g, '')
    .replace(/[ \t]+/g, ' ')
    .trim();
}

export function normalizeUsername(value: string): string {
  return value.trim().toLowerCase();
}

/**
 * A single grapheme-ish emoji, used for reactions. Anything longer than a few
 * code points, or containing letters/digits, is rejected so reactions cannot
 * be used as an unbounded plaintext side channel.
 */
export function validateReaction(value: string): FieldProblem | null {
  if (!value) return { field: 'emoji', message: 'Pick an emoji' };
  if (value.length > LIMITS.reactionMax) {
    return { field: 'emoji', message: 'Not a valid reaction' };
  }
  if (/[\p{L}\p{N}\s]/u.test(value)) {
    return { field: 'emoji', message: 'Reactions must be emoji' };
  }
  if (!/\p{Extended_Pictographic}/u.test(value)) {
    return { field: 'emoji', message: 'Reactions must be emoji' };
  }
  return null;
}

/** Passwords that show up at the top of every breach corpus. */
const COMMON_PASSWORDS = new Set([
  'password',
  'password1',
  'password123',
  'passw0rd123',
  '1234567890',
  '12345678901',
  '123456789012',
  'qwertyuiop',
  'qwerty12345',
  'iloveyou123',
  'letmein1234',
  'welcome1234',
  'admin123456',
  'abc123456789',
  'football1234',
  'monkey123456',
  'dragon123456',
  'baseball1234',
  'sunshine1234',
  'princess1234',
]);

/** Rough strength estimate for the registration meter (0–4). */
export function passwordStrength(value: string): number {
  if (!value) return 0;
  let score = 0;
  if (value.length >= 10) score += 1;
  if (value.length >= 14) score += 1;
  if (value.length >= 20) score += 1;
  const classes = [/[a-z]/, /[A-Z]/, /[0-9]/, /[^a-zA-Z0-9]/].filter((re) =>
    re.test(value),
  ).length;
  if (classes >= 3) score += 1;
  if (COMMON_PASSWORDS.has(value.toLowerCase()) || /^(.)\1+$/.test(value)) return 0;
  return Math.min(4, score);
}
