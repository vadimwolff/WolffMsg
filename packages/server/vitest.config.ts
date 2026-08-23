import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/tests/**/*.test.ts'],
    globalSetup: ['./src/tests/globalSetup.ts'],
    setupFiles: ['./src/tests/setup.ts'],
    // The suite shares one PostgreSQL database and truncates between tests,
    // so files must not run concurrently.
    fileParallelism: false,
    pool: 'forks',
    poolOptions: { forks: { singleFork: true } },
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
});
