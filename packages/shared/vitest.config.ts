import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    // Argon2id at MODERATE cost is deliberately slow.
    testTimeout: 30_000,
  },
});
