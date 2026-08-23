import fs from 'node:fs';
import path from 'node:path';

/**
 * Runs before any application module is imported, so `env.ts` reads the test
 * configuration rather than the development one.
 */
for (const candidate of [
  path.resolve(process.cwd(), '.env'),
  path.resolve(process.cwd(), '../../.env'),
]) {
  if (fs.existsSync(candidate)) {
    process.loadEnvFile(candidate);
    break;
  }
}

process.env.NODE_ENV = 'test';
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL ?? '';
process.env.LOG_LEVEL = 'silent';
// Use the in-process store so the suite is not affected by, and does not
// pollute, a running Redis instance.
process.env.REDIS_URL = '';
process.env.SESSION_SECRET =
  process.env.SESSION_SECRET ?? 'test-only-session-secret-value-32-bytes-minimum!!';
process.env.STORAGE_PATH = path.resolve(process.cwd(), '.test-storage');
process.env.ALLOW_REGISTRATION = 'true';
process.env.COOKIE_SECURE = 'false';
