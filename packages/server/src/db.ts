import { PrismaClient } from '@prisma/client';
import { env } from './env.js';
import { logger } from './logger.js';

/**
 * Prisma parameterises every query it builds, which is what keeps SQL
 * injection off the table. The few `$queryRaw` uses in this codebase all go
 * through tagged templates for the same reason — never string concatenation.
 */
export const prisma = new PrismaClient({
  log: env.LOG_LEVEL === 'trace' ? ['query', 'warn', 'error'] : ['warn', 'error'],
});

export async function connectDatabase(): Promise<void> {
  await prisma.$connect();
  logger.info('database connected');
}

export async function disconnectDatabase(): Promise<void> {
  await prisma.$disconnect();
}

export type Db = typeof prisma;

/**
 * Narrow a Node `Buffer` to the `Uint8Array<ArrayBuffer>` that Prisma's
 * `Bytes` columns expect. `Buffer` is typed over `ArrayBufferLike`, which
 * includes `SharedArrayBuffer` and therefore is not assignable. The copy is
 * cheap — every value passed through here is a key, hash or nonce.
 */
export function bytes(input: Uint8Array): Uint8Array<ArrayBuffer> {
  return Uint8Array.from(input);
}

/** Prisma's unique-constraint violation. */
export function isUniqueViolation(err: unknown, target?: string): boolean {
  const e = err as { code?: string; meta?: { target?: string[] | string } };
  if (e?.code !== 'P2002') return false;
  if (!target) return true;
  const t = e.meta?.target;
  const fields = Array.isArray(t) ? t : typeof t === 'string' ? [t] : [];
  return fields.some((f) => f.includes(target));
}

/** Prisma's "record not found" for an update/delete. */
export function isNotFound(err: unknown): boolean {
  return (err as { code?: string })?.code === 'P2025';
}
