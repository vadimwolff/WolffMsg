import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Point the whole test run at the dedicated test database and bring its schema
 * up to date, so a suite never touches development data.
 */
export default function setup(): void {
  for (const candidate of [
    path.resolve(process.cwd(), '.env'),
    path.resolve(process.cwd(), '../../.env'),
  ]) {
    if (fs.existsSync(candidate)) {
      process.loadEnvFile(candidate);
      break;
    }
  }

  const testUrl = process.env.TEST_DATABASE_URL;
  if (!testUrl) {
    throw new Error(
      'TEST_DATABASE_URL is not set. Copy .env.example to .env and point it at ' +
        'a database that may be wiped.',
    );
  }

  // Guard against a mis-set variable dropping a real database.
  if (!/test/i.test(testUrl)) {
    throw new Error(
      'TEST_DATABASE_URL does not contain "test". Refusing to run the suite ' +
        'against what may be a live database.',
    );
  }

  execFileSync('npx', ['prisma', 'migrate', 'deploy'], {
    env: { ...process.env, DATABASE_URL: testUrl },
    stdio: 'pipe',
  });
}
