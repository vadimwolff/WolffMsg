import { createRequire } from 'node:module';
import { defineConfig } from 'vitest/config';

// libsodium-wrappers-sumo ships a broken ESM build: its .mjs entry imports
// `./libsodium-sumo.mjs`, a file that lives in a *different* package. The
// CommonJS build is correct and complete, so we resolve the package to it.
// See https://github.com/jedisct1/libsodium.js/issues/243
const require = createRequire(import.meta.url);

export default defineConfig({
  resolve: {
    alias: {
      'libsodium-wrappers-sumo': require.resolve('libsodium-wrappers-sumo'),
    },
  },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    // Argon2id at MODERATE cost is deliberately slow.
    testTimeout: 30_000,
  },
});
