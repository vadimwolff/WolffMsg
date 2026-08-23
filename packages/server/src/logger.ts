import pino from 'pino';
import { env } from './env.js';

/**
 * Keys whose values must never reach a log line, at any depth.
 *
 * The redaction list is deliberately broad: it is far cheaper to redact an
 * innocuous field than to discover a password in a log aggregator.
 */
const REDACTED_KEYS = new Set([
  'password',
  'currentpassword',
  'newpassword',
  'confirmpassword',
  'passwordhash',
  'token',
  'accesstoken',
  'refreshtoken',
  'sessiontoken',
  'authorization',
  'cookie',
  'set-cookie',
  'csrftoken',
  'secret',
  'sessionsecret',
  'privatekey',
  'identityprivatekey',
  'ciphertext',
  'plaintext',
  'body',
  'wrapped',
  'nonce',
  'signature',
  'p256dh',
  'auth',
  'endpoint',
  'vapid_private_key',
]);

/**
 * Recursively strip sensitive values. Pino's `redact` option only handles
 * fixed paths; message payloads here have shapes we do not control.
 */
function scrub(value: unknown, depth = 0): unknown {
  if (depth > 6) return '[deep]';
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.slice(0, 20).map((v) => scrub(v, depth + 1));
  if (value instanceof Uint8Array) return `[bytes:${value.length}]`;
  if (value instanceof Error) {
    return { name: value.name, message: value.message, stack: value.stack };
  }

  const out: Record<string, unknown> = {};
  for (const [key, inner] of Object.entries(value as Record<string, unknown>)) {
    out[key] = REDACTED_KEYS.has(key.toLowerCase())
      ? '[redacted]'
      : scrub(inner, depth + 1);
  }
  return out;
}

export const logger = pino({
  level: env.isTest ? 'silent' : env.LOG_LEVEL,
  base: { service: 'wolffmsg' },
  timestamp: pino.stdTimeFunctions.isoTime,
  formatters: {
    level: (label) => ({ level: label }),
  },
  hooks: {
    logMethod(args, method) {
      const [first, ...rest] = args;
      if (first && typeof first === 'object') {
        method.apply(this, [scrub(first) as object, ...rest] as never);
        return;
      }
      method.apply(this, args as never);
    },
  },
  // Belt and braces: fixed-path redaction for the shapes Fastify emits.
  redact: {
    paths: [
      'req.headers.cookie',
      'req.headers.authorization',
      'res.headers["set-cookie"]',
      'req.body.password',
      'req.body.newPassword',
      'req.body.currentPassword',
    ],
    censor: '[redacted]',
  },
});

export type Logger = typeof logger;
