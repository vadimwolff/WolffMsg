import type { FastifyRequest } from 'fastify';
import { counters } from '../redis.js';
import { rateLimited } from '../errors.js';
import { rateLimitKey } from './ipHint.js';

export interface RateLimitRule {
  /** Stable name, used as the counter key prefix. */
  name: string;
  /** Requests allowed inside the window. */
  limit: number;
  /** Window length in seconds. */
  windowSeconds: number;
  /** Message shown when the limit trips. */
  message: string;
}

/**
 * Every limit the server enforces, in one place so the policy is auditable.
 *
 * Anonymous endpoints are keyed by client address; authenticated ones by user
 * id, so one user on a shared NAT cannot lock out their colleagues.
 */
export const RATE_LIMITS = {
  register: {
    name: 'register',
    limit: 5,
    windowSeconds: 3_600,
    message: 'Too many accounts created from here. Try again in an hour.',
  },
  login: {
    name: 'login',
    limit: 10,
    windowSeconds: 900,
    message: 'Too many sign-in attempts. Try again in a few minutes.',
  },
  loginPerAccount: {
    name: 'login_account',
    limit: 8,
    windowSeconds: 900,
    message: 'Too many sign-in attempts. Try again in a few minutes.',
  },
  passwordChange: {
    name: 'password_change',
    limit: 5,
    windowSeconds: 3_600,
    message: 'Too many password changes. Try again later.',
  },
  sendMessage: {
    name: 'send_message',
    limit: 120,
    windowSeconds: 60,
    message: 'You are sending messages too quickly.',
  },
  uploadAttachment: {
    name: 'upload',
    limit: 40,
    windowSeconds: 300,
    message: 'Too many uploads. Give it a moment.',
  },
  search: {
    name: 'search',
    limit: 60,
    windowSeconds: 60,
    message: 'Too many searches. Slow down a little.',
  },
  addContact: {
    name: 'add_contact',
    limit: 40,
    windowSeconds: 3_600,
    message: 'Too many contacts added. Try again later.',
  },
  createChat: {
    name: 'create_chat',
    limit: 30,
    windowSeconds: 3_600,
    message: 'Too many conversations created. Try again later.',
  },
  startCall: {
    name: 'start_call',
    limit: 20,
    windowSeconds: 600,
    message: 'Too many calls started. Try again shortly.',
  },
  claimPreKeys: {
    name: 'claim_prekeys',
    limit: 300,
    windowSeconds: 300,
    message: 'Too many key requests.',
  },
  socketEvents: {
    name: 'ws_events',
    limit: 600,
    windowSeconds: 60,
    message: 'Too many realtime events.',
  },
  reaction: {
    name: 'reaction',
    limit: 120,
    windowSeconds: 60,
    message: 'Too many reactions.',
  },
  pushSubscribe: {
    name: 'push_subscribe',
    limit: 20,
    windowSeconds: 3_600,
    message: 'Too many push registrations.',
  },
} as const satisfies Record<string, RateLimitRule>;

/**
 * Consume one unit against a rule. Throws a 429 with `Retry-After` when the
 * window is exhausted.
 */
export async function consume(
  rule: RateLimitRule,
  subject: string,
): Promise<void> {
  const key = `rl:${rule.name}:${subject}`;
  const { count, ttl } = await counters.incr(key, rule.windowSeconds);
  if (count > rule.limit) {
    throw rateLimited(rule.message, ttl);
  }
}

/** Consume against the requesting client address (for anonymous endpoints). */
export async function consumeByIp(
  rule: RateLimitRule,
  request: FastifyRequest,
): Promise<void> {
  await consume(rule, `ip:${rateLimitKey(request)}`);
}

/** Consume against the signed-in user. */
export async function consumeByUser(
  rule: RateLimitRule,
  userId: string,
): Promise<void> {
  await consume(rule, `u:${userId}`);
}

/**
 * Check without consuming — used by the WebSocket layer, which wants to close
 * an abusive socket rather than answer with an HTTP status.
 */
export async function isOverLimit(
  rule: RateLimitRule,
  subject: string,
): Promise<boolean> {
  const key = `rl:${rule.name}:${subject}`;
  const { count } = await counters.incr(key, rule.windowSeconds);
  return count > rule.limit;
}

export async function clearLimit(
  rule: RateLimitRule,
  subject: string,
): Promise<void> {
  await counters.reset(`rl:${rule.name}:${subject}`);
}
