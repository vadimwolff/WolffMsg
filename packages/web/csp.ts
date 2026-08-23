/**
 * Content Security Policy for the built client.
 *
 * This matters more here than in an ordinary web app. WolffMsg's threat model
 * (SECURITY.md §5) concedes that a compromised server could serve malicious
 * JavaScript — that is the fundamental limit of web-delivered E2EE. A strict
 * CSP does not close that hole, but it does close every *smaller* one: an
 * injected script that cannot reach an attacker's host cannot exfiltrate a
 * decrypted message, and a script source that must match a hash cannot be
 * introduced by a stored-XSS bug at all.
 *
 * The policy is emitted as a `<meta http-equiv>` in the built HTML rather than
 * only as a response header, so it travels with the file. That is what gives a
 * static host — GitHub Pages, a CDN, an S3 bucket, none of which let you set
 * headers — the same protection as the nginx deployment. `frame-ancestors`
 * cannot be expressed in a meta tag and is set as a header instead
 * (`X-Frame-Options: DENY` in docker/nginx.conf).
 */
import crypto from 'node:crypto';
import type { Plugin } from 'vite';

/** The sha256-in-base64 form a CSP hash source expects. */
function hashSource(script: string): string {
  return `'sha256-${crypto.createHash('sha256').update(script, 'utf8').digest('base64')}'`;
}

/**
 * Where the app is allowed to make requests.
 *
 * Three cases, and they are genuinely different in strength:
 *
 *  - **Same origin** (the recommended deployment): `'self'` and nothing else.
 *    An injected script has nowhere to send anything.
 *  - **Pinned API origin**: that origin and its WebSocket, named exactly.
 *    Equally tight.
 *  - **Runtime-chosen server**: the build cannot know the answer, because the
 *    person using it supplies it. `https:`/`wss:` is the tightest expressible
 *    policy — it still rules out `http:`, `data:` and every non-secure
 *    exfiltration path, but it does not restrict *which* secure host, and it
 *    should not be described as if it did.
 */
/*
 * Loopback over plain HTTP, which `serverOrigin.ts` also accepts.
 *
 * A published client pointed at a WolffMsg server running on the same machine
 * is a real workflow, and `https:` alone would make it impossible. Loopback is
 * not an exfiltration target: a remote attacker gains nothing from being able
 * to reach the victim's own localhost that they could not already reach.
 */
const LOOPBACK = [
  'http://localhost:*',
  'http://127.0.0.1:*',
  'ws://localhost:*',
  'ws://127.0.0.1:*',
];

function connectSources(apiOrigin: string, allowRuntimeServer: boolean): string[] {
  if (!apiOrigin) {
    return allowRuntimeServer
      ? ["'self'", 'https:', 'wss:', ...LOOPBACK]
      : ["'self'"];
  }

  let host: string;
  try {
    host = new URL(apiOrigin).host;
  } catch {
    return ["'self'", 'https:', 'wss:'];
  }

  const wsScheme = apiOrigin.startsWith('https:') ? 'wss' : 'ws';
  const sources = ["'self'", apiOrigin, `${wsScheme}://${host}`];
  // A pinned build can still be re-pointed by the person using it, so it needs
  // the same allowance when that is enabled.
  return allowRuntimeServer
    ? [...sources, 'https:', 'wss:', ...LOOPBACK]
    : sources;
}

export function buildCsp(options: {
  apiOrigin: string;
  allowRuntimeServer: boolean;
  inlineScriptHashes: string[];
}): string {
  const directives: [string, string[]][] = [
    ['default-src', ["'none'"]],

    /*
     * Our own bundles, the exact inline scripts present in the built HTML, and
     * WebAssembly.
     *
     * `'wasm-unsafe-eval'` is required, not optional: libsodium compiles a
     * WebAssembly module, and without this the entire crypto core fails to
     * load — the app cannot encrypt anything at all. It is the narrow
     * directive that permits *only* WebAssembly compilation; it does not
     * enable `eval()` or any other string-to-JavaScript path, which is why it
     * exists separately from `'unsafe-eval'`.
     *
     * Still no 'unsafe-inline' and no 'unsafe-eval'.
     */
    ['script-src', ["'self'", "'wasm-unsafe-eval'", ...options.inlineScriptHashes]],

    /*
     * `'unsafe-inline'` here is unavoidable and much narrower than it sounds:
     * React writes component styles as inline `style` attributes, and Framer
     * Motion animates by mutating them every frame. It permits style
     * attributes, not script.
     */
    ['style-src', ["'self'", "'unsafe-inline'"]],

    // `blob:` for decrypted attachments, which become object URLs in the page;
    // `data:` for the generated icons.
    ['img-src', ["'self'", 'blob:', 'data:']],
    ['media-src', ["'self'", 'blob:']],
    ['font-src', ["'self'"]],

    ['connect-src', connectSources(options.apiOrigin, options.allowRuntimeServer)],

    // The service worker.
    ['worker-src', ["'self'"]],
    ['manifest-src', ["'self'"]],

    ['object-src', ["'none'"]],
    ['base-uri', ["'none'"]],
    ['form-action', ["'none'"]],
    // Blocks a plain-HTTP subresource from ever being requested.
    ['upgrade-insecure-requests', []],
  ];

  return directives
    .map(([name, values]) => (values.length ? `${name} ${values.join(' ')}` : name))
    .join('; ');
}

/**
 * Inject the policy into the built `index.html`.
 *
 * The hashes are computed from the *final* HTML, after Vite has rewritten it,
 * so they cannot drift from what actually ships. Edit the inline theme script
 * and the hash follows automatically.
 */
export function cspPlugin(options: {
  apiOrigin: string;
  allowRuntimeServer: boolean;
}): Plugin {
  return {
    name: 'wolffmsg-csp',
    // `post` so Vite has finished rewriting asset URLs and any other plugin
    // has finished adding tags.
    enforce: 'post',
    apply: 'build',

    transformIndexHtml: {
      order: 'post',
      handler(html) {
        const hashes: string[] = [];
        const inlineScript = /<script(?![^>]*\ssrc=)[^>]*>([\s\S]*?)<\/script>/gi;
        for (const match of html.matchAll(inlineScript)) {
          const body = match[1];
          if (body && body.trim()) hashes.push(hashSource(body));
        }

        const policy = buildCsp({ ...options, inlineScriptHashes: hashes });
        const meta =
          `<meta http-equiv="Content-Security-Policy" content="${policy}" />`;

        /*
         * Placed immediately after `<meta charset>` rather than at the very
         * top of <head>. The charset declaration has to fall within the first
         * 1024 bytes of the document, and this policy is long enough to push
         * it out. It still precedes every script and every subresource, which
         * is what a meta CSP requires.
         */
        const charset = /<meta\s+charset=[^>]*>/i.exec(html);
        if (charset?.index !== undefined) {
          const at = charset.index + charset[0].length;
          return `${html.slice(0, at)}\n    ${meta}${html.slice(at)}`;
        }
        return html.replace(/<head[^>]*>/i, (open) => `${open}\n    ${meta}`);
      },
    },
  };
}
