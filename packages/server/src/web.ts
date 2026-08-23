/**
 * Serving the built client from the API process.
 *
 * Optional, and off unless `WEB_ROOT` points at a directory. Two deployments
 * want it:
 *
 *  - **A single free host.** Most free tiers give you one process. Without
 *    this, WolffMsg needs two — a static host for the client and a server for
 *    the API — which forces the split-origin setup and its weaker cookie
 *    settings (SECURITY.md §7). One process keeps the browser on one origin,
 *    so `SameSite=strict` still applies. That makes the *easiest* deployment
 *    also the *safest* one, which is the right way round.
 *  - **A small self-hosted box** where running nginx as well is more machinery
 *    than the situation deserves.
 *
 * The compose stack still puts nginx in front, because it serves static files
 * better than Node does. This is the fallback, not the recommendation.
 */
import path from 'node:path';
import fs from 'node:fs';
import fastifyStatic from '@fastify/static';
import type { FastifyInstance } from 'fastify';
import { env } from './env.js';
import { logger } from './logger.js';

/** Build output is content-hashed, so it can be cached indefinitely. */
const IMMUTABLE = 'public, max-age=31536000, immutable';

/**
 * Never cached. `index.html` names the hashed bundles, and the service worker
 * is what replaces the copy already installed in someone's browser — a stale
 * copy of either pins a deployment in place.
 */
const NO_CACHE = 'no-cache, no-store, must-revalidate';

export function webRoot(): string | null {
  if (!env.WEB_ROOT) return null;

  const root = path.resolve(process.cwd(), env.WEB_ROOT);
  if (!fs.existsSync(path.join(root, 'index.html'))) {
    // A misconfigured path must not silently serve nothing: without this the
    // symptom is a blank page and a 404, with no clue why.
    logger.warn(
      { root },
      'WEB_ROOT is set but holds no index.html — the client will not be served',
    );
    return null;
  }
  return root;
}

export async function registerWebClient(app: FastifyInstance): Promise<void> {
  const root = webRoot();
  if (!root) return;

  await app.register(fastifyStatic, {
    root,
    // The API owns everything under /api; this only ever answers what is left.
    wildcard: false,
    index: ['index.html'],
    // `@fastify/static` already refuses to escape `root`; this stops a request
    // from reaching a dotfile that happens to be inside it.
    dotfiles: 'ignore',
    setHeaders(reply, filePath) {
      const name = path.basename(filePath);
      if (name === 'index.html' || name === 'sw.js') {
        reply.setHeader('Cache-Control', NO_CACHE);
        return;
      }
      const dir = path.dirname(filePath);
      if (dir.endsWith(`${path.sep}assets`) || dir.endsWith(`${path.sep}icons`)) {
        reply.setHeader('Cache-Control', IMMUTABLE);
        return;
      }
      reply.setHeader('Cache-Control', 'public, max-age=3600');
    },
  });

  logger.info({ root }, 'serving the web client from this process');
}

/**
 * Single-page fallback: any unmatched path renders the client, which decides
 * what to show.
 *
 * Deliberately narrow. A miss under `/api` is a real 404 and must stay JSON —
 * returning HTML there would turn a typo in an endpoint into a parse error at
 * the call site instead of a clear "not found". Non-GET misses are 404 too:
 * there is no page to render for a POST.
 */
export function shouldServeAppShell(method: string, url: string): boolean {
  if (method !== 'GET' && method !== 'HEAD') return false;
  const pathname = url.split('?')[0] ?? '';
  if (pathname.startsWith('/api/') || pathname === '/api') return false;
  if (pathname.startsWith('/ws')) return false;
  return true;
}
