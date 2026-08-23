import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * The Prisma CLI runs from `packages/server`, but the repository keeps a
 * single `.env` at the root so server, tooling and docker-compose all read the
 * same values. Load it here before Prisma resolves `env("DATABASE_URL")`.
 */
const here = path.dirname(fileURLToPath(import.meta.url));
for (const candidate of [
  path.resolve(here, '.env'),
  path.resolve(here, '../../.env'),
]) {
  if (fs.existsSync(candidate)) {
    process.loadEnvFile(candidate);
    break;
  }
}

export default {
  schema: path.join('prisma', 'schema.prisma'),
  migrations: {
    seed: 'tsx prisma/seed.ts',
  },
};
