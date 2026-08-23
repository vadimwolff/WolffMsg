import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import { cspPlugin } from './csp.ts';

const API_TARGET = process.env.VITE_API_TARGET ?? 'http://127.0.0.1:4000';

const API_ORIGIN = (process.env.VITE_API_ORIGIN ?? '').trim();

/*
 * Does this build let the person using it name their own server?
 *
 * It costs a real amount of CSP tightness — `connect-src` has to allow secure
 * origins generally rather than one named host — so it is off unless asked
 * for. A static host with no API behind it needs it; every other deployment
 * does not.
 */
const ALLOW_RUNTIME_SERVER = /^(1|true|yes)$/i.test(
  (process.env.ALLOW_RUNTIME_SERVER ?? '').trim(),
);

/*
 * Where the built client will be served from. `/` covers the normal case — the
 * server, or a reverse proxy in front of it, serving the app at the root of a
 * hostname. A static host that publishes under a subpath (GitHub Pages at
 * `/<repo>/`) sets this instead, and every asset URL is rewritten to match.
 */
const BASE = (() => {
  const raw = (process.env.BASE_PATH ?? '/').trim() || '/';
  const withLeading = raw.startsWith('/') ? raw : `/${raw}`;
  return withLeading.endsWith('/') ? withLeading : `${withLeading}/`;
})();

export default defineConfig({
  base: BASE,
  plugins: [
    react(),
    cspPlugin({ apiOrigin: API_ORIGIN, allowRuntimeServer: ALLOW_RUNTIME_SERVER }),
  ],
  /*
   * libsodium's ESM bundle carries a Node-only branch that uses top-level
   * await to reach `url` and `path`. That branch is dead in a browser, but
   * esbuild still parses it, and its default target rejects top-level await.
   * Raising the target for dependency pre-bundling lets it through; the code
   * itself never runs.
   */
  optimizeDeps: {
    esbuildOptions: {
      target: 'es2022',
      supported: { 'top-level-await': true },
    },
  },
  esbuild: { target: 'es2022' },
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      // The dev server and the API share an origin from the browser's point of
      // view, so `SameSite=strict` cookies and the CSRF header behave exactly
      // as they will in production behind a single reverse proxy.
      '/api': { target: API_TARGET, changeOrigin: false },
      '/ws': { target: API_TARGET, ws: true, changeOrigin: false },
    },
  },
  build: {
    target: 'es2022',
    sourcemap: true,
    rollupOptions: {
      output: {
        manualChunks: (id) => {
          // libsodium is a large payload; keeping it separate lets the sign-in
          // screen paint before the crypto core finishes downloading.
          if (id.includes('libsodium')) return 'sodium';
          if (id.includes('/react-dom/') || id.includes('/react/')) return 'react';
          if (id.includes('framer-motion') || id.includes('motion-dom')) return 'motion';
          // Settings is a large surface almost no session opens immediately.
          if (id.includes('/components/settings/')) return 'settings';
          return undefined;
        },
      },
    },
  },
  test: {
    environment: 'jsdom',
    // `csp.test.ts` sits beside the build plugin it covers, outside src/.
    include: ['src/**/*.test.{ts,tsx}', '*.test.ts'],
  },
});
