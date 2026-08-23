import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';

/**
 * Load the repository-root `.env` when one exists. Real deployments inject
 * variables through the process environment instead, and values already set
 * there always win.
 */
function loadDotEnv(): void {
  const candidates = [
    path.resolve(process.cwd(), '.env'),
    path.resolve(process.cwd(), '../../.env'),
    path.resolve(process.cwd(), '../..', '.env'),
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      process.loadEnvFile(candidate);
      return;
    }
  }
}
loadDotEnv();

/**
 * Some hosts inject the public URL of the service they just created.
 *
 * `WEB_ORIGIN` has to be the exact origin a browser will use, and on a
 * platform that assigns the hostname there is no way to know it in advance —
 * which for someone deploying by hand means a chicken-and-egg step: create the
 * service, read the URL, edit the config, redeploy. Using what the platform
 * already tells us removes that step entirely.
 *
 * An explicitly set value always wins, so this can never override a real
 * configuration.
 */
function adoptPlatformUrl(): void {
  const assigned = process.env.RENDER_EXTERNAL_URL?.trim();
  if (!assigned) return;
  process.env.WEB_ORIGIN ??= assigned;
  process.env.PUBLIC_URL ??= assigned;
}
adoptPlatformUrl();

const booleanish = z
  .string()
  .transform((v) => v.trim().toLowerCase())
  .pipe(z.enum(['true', 'false', '1', '0', 'yes', 'no']))
  .transform((v) => v === 'true' || v === '1' || v === 'yes');

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65_535).default(4000),
  HOST: z.string().default('0.0.0.0'),

  WEB_ORIGIN: z.string().default('http://localhost:5173'),
  PUBLIC_URL: z.string().default('http://localhost:5173'),
  COOKIE_SECURE: booleanish.default('false'),
  /*
   * `strict` is the default and the one we recommend: the browser then refuses
   * to attach the session cookie to any cross-site request at all, which is a
   * CSRF defence no application code can get wrong.
   *
   * `none` exists for one real deployment shape — the web client served from a
   * different origin than the API, such as a static host — where `strict` would
   * simply never send the cookie and nobody could sign in. It is a genuine
   * weakening: CSRF then rests entirely on the Origin allow-list and the
   * double-submit token in `security/csrf.ts`. It requires COOKIE_SECURE.
   */
  COOKIE_SAMESITE: z
    .string()
    .transform((v) => v.trim().toLowerCase())
    .pipe(z.enum(['strict', 'lax', 'none']))
    .default('strict'),

  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
  REDIS_URL: z.string().optional().default(''),

  SESSION_SECRET: z
    .string()
    .min(32, 'SESSION_SECRET must be at least 32 characters of entropy'),

  /*
   * Serve the built web client from this process when set (e.g.
   * `packages/web/dist`). Empty means the client is served by something else —
   * nginx in the compose stack, or a static host.
   *
   * Setting it is what makes a one-process deployment possible, and a
   * one-process deployment is same-origin, which is the *stronger* cookie
   * posture. See src/web.ts.
   */
  WEB_ROOT: z.string().optional().default(''),

  STORAGE_DRIVER: z.enum(['local']).default('local'),
  STORAGE_PATH: z.string().default('./storage'),
  MAX_ATTACHMENT_BYTES: z.coerce.number().int().positive().default(104_857_600),
  MAX_AVATAR_BYTES: z.coerce.number().int().positive().default(4_194_304),

  STUN_SERVERS: z.string().default('stun:stun.l.google.com:19302'),
  TURN_SERVER: z.string().optional().default(''),
  TURN_USERNAME: z.string().optional().default(''),
  TURN_PASSWORD: z.string().optional().default(''),

  VAPID_PUBLIC_KEY: z.string().optional().default(''),
  VAPID_PRIVATE_KEY: z.string().optional().default(''),
  VAPID_SUBJECT: z.string().optional().default('mailto:admin@example.com'),

  LOG_LEVEL: z
    .enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal', 'silent'])
    .default('info'),
  ALLOW_REGISTRATION: booleanish.default('true'),
});

const parsed = schema.safeParse(process.env);

if (!parsed.success) {
  const problems = parsed.error.issues
    .map((issue) => `  • ${issue.path.join('.')}: ${issue.message}`)
    .join('\n');
  // This is a startup failure, not a request failure — print and exit rather
  // than booting a half-configured server.
  console.error(`WolffMsg cannot start — invalid configuration:\n${problems}`);
  process.exit(1);
}

const raw = parsed.data;

/**
 * Refuse to boot in production with the placeholder secret from
 * `.env.example`, which would otherwise silently ship a known session key.
 */
if (
  raw.NODE_ENV === 'production' &&
  /CHANGE_ME|example|placeholder/i.test(raw.SESSION_SECRET)
) {
  console.error(
    'WolffMsg cannot start — SESSION_SECRET still holds the example value.',
  );
  process.exit(1);
}

/*
 * `SameSite=None` without `Secure` is rejected outright by every current
 * browser, so this configuration would not fail loudly — it would simply never
 * authenticate anyone. Fail at boot instead.
 */
if (raw.COOKIE_SAMESITE === 'none' && !raw.COOKIE_SECURE) {
  console.error(
    'WolffMsg cannot start — COOKIE_SAMESITE=none requires COOKIE_SECURE=true. ' +
      'Browsers discard a SameSite=None cookie that is not marked Secure.',
  );
  process.exit(1);
}

if (raw.COOKIE_SAMESITE === 'none') {
  console.warn(
    'WolffMsg: COOKIE_SAMESITE=none. Session cookies will travel on cross-site ' +
      'requests, so CSRF protection now rests only on the WEB_ORIGIN allow-list ' +
      'and the double-submit token. Keep WEB_ORIGIN exact.',
  );
}

if (raw.NODE_ENV === 'production' && !raw.COOKIE_SECURE) {
  console.warn(
    'WolffMsg: COOKIE_SECURE is false in production. Session cookies will be ' +
      'sent over plain HTTP. Set COOKIE_SECURE=true behind TLS.',
  );
}

export const env = {
  ...raw,
  isProduction: raw.NODE_ENV === 'production',
  isTest: raw.NODE_ENV === 'test',
  /** Allowed browser origins, parsed once. */
  webOrigins: raw.WEB_ORIGIN.split(',')
    .map((o) => o.trim())
    .filter(Boolean),
  stunServers: raw.STUN_SERVERS.split(',')
    .map((o) => o.trim())
    .filter(Boolean),
  pushEnabled: Boolean(raw.VAPID_PUBLIC_KEY && raw.VAPID_PRIVATE_KEY),
  redisEnabled: Boolean(raw.REDIS_URL),
  storageRoot: path.resolve(process.cwd(), raw.STORAGE_PATH),
} as const;

export type Env = typeof env;
