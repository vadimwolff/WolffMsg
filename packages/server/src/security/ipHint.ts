import crypto from 'node:crypto';
import type { FastifyRequest } from 'fastify';
import { env } from '../env.js';

/**
 * WolffMsg never stores a raw client IP address.
 *
 * What it stores is a "hint": the network prefix (/24 for IPv4, /48 for IPv6)
 * plus a short keyed digest of the full address. That is enough to show a user
 * "a session appeared from a different network" and to rate-limit per client,
 * without keeping a precise, individually identifying location log.
 */
export function ipHint(request: FastifyRequest): string {
  return ipHintFromAddress(clientAddress(request));
}

/** Same derivation, for callers that hold a raw address (the WebSocket upgrade). */
export function ipHintFromAddress(address: string | undefined | null): string {
  if (!address) return 'unknown';
  const normalized = address.startsWith('::ffff:') ? address.slice(7) : address;
  return `${prefixOf(normalized)}·${keyedDigest(normalized).slice(0, 6)}`;
}

/**
 * A stable per-client key for rate limiting. Uses the full address (keyed, so
 * the table cannot be reversed) rather than the prefix, so one abusive host
 * cannot be masked by its neighbours.
 */
export function rateLimitKey(request: FastifyRequest): string {
  const address = clientAddress(request);
  return address ? keyedDigest(address).slice(0, 24) : 'unknown';
}

/**
 * Resolve the client address.
 *
 * `X-Forwarded-For` is only honoured when Fastify's `trustProxy` is enabled,
 * which this app turns on solely in production (where it sits behind a known
 * reverse proxy). Otherwise a client could forge the header to defeat
 * per-IP rate limiting.
 */
function clientAddress(request: FastifyRequest): string | null {
  const raw = request.ip;
  if (!raw) return null;
  return raw.startsWith('::ffff:') ? raw.slice(7) : raw;
}

function prefixOf(address: string): string {
  if (address.includes(':')) {
    const groups = address.split(':').filter(Boolean).slice(0, 3);
    return `${groups.join(':')}::/48`;
  }
  const octets = address.split('.');
  if (octets.length !== 4) return 'unknown';
  return `${octets[0]}.${octets[1]}.${octets[2]}.0/24`;
}

let ipKey: Buffer | null = null;

function keyedDigest(value: string): string {
  if (!ipKey) {
    ipKey = crypto.hkdfSync(
      'sha256',
      Buffer.from(env.SESSION_SECRET, 'utf8'),
      Buffer.alloc(0),
      Buffer.from('wolffmsg:ip-hint:v1'),
      32,
    ) as unknown as Buffer;
  }
  return crypto.createHmac('sha256', ipKey).update(value).digest('hex');
}

/**
 * Reduce a User-Agent to a coarse "Chrome on Windows" style label. The full
 * string is a fingerprinting surface and is never persisted.
 */
export function describeUserAgent(userAgent: string | undefined): {
  name: string;
  platform: string;
} {
  const ua = userAgent ?? '';
  const platform = /android/i.test(ua)
    ? 'Android'
    : /iphone|ipad|ipod/i.test(ua)
      ? 'iOS'
      : /mac os x/i.test(ua)
        ? 'macOS'
        : /windows/i.test(ua)
          ? 'Windows'
          : /linux/i.test(ua)
            ? 'Linux'
            : 'Unknown';

  const name = /edg\//i.test(ua)
    ? 'Edge'
    : /opr\//i.test(ua)
      ? 'Opera'
      : /firefox\//i.test(ua)
        ? 'Firefox'
        : /chrome\//i.test(ua)
          ? 'Chrome'
          : /safari\//i.test(ua)
            ? 'Safari'
            : 'Browser';

  return { name, platform };
}
