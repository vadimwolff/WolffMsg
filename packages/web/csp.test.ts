/**
 * The CSP is security-relevant logic that runs once, at build time, where a
 * mistake is invisible until it reaches a browser — either as a policy that
 * silently permits what it should not, or as one that breaks the app.
 *
 * Both failure modes have already happened once here: an early version omitted
 * `'wasm-unsafe-eval'` and blocked libsodium entirely, so the app could not
 * encrypt anything. These tests pin down both directions.
 */
import { describe, expect, it } from 'vitest';
import { buildCsp } from './csp.ts';

const directives = (policy: string): Map<string, string[]> =>
  new Map(
    policy.split(';').map((part) => {
      const [name, ...values] = part.trim().split(/\s+/);
      return [name ?? '', values];
    }),
  );

const base = { apiOrigin: '', allowRuntimeServer: false, inlineScriptHashes: [] };

describe('script sources', () => {
  it('permits WebAssembly, which libsodium requires', () => {
    // Without this the crypto core fails to compile and nothing can be
    // encrypted at all. It is not optional.
    const script = directives(buildCsp(base)).get('script-src') ?? [];
    expect(script).toContain("'wasm-unsafe-eval'");
  });

  it('never permits eval or inline script', () => {
    const script = directives(buildCsp(base)).get('script-src') ?? [];
    expect(script).not.toContain("'unsafe-eval'");
    expect(script).not.toContain("'unsafe-inline'");
  });

  it('carries the hashes of the inline scripts that actually shipped', () => {
    const policy = buildCsp({ ...base, inlineScriptHashes: ["'sha256-abc123'"] });
    expect(directives(policy).get('script-src')).toContain("'sha256-abc123'");
  });
});

describe('connect sources', () => {
  it('is same-origin only for the recommended deployment', () => {
    // The whole point: an injected script has nowhere to send a decrypted
    // message.
    expect(directives(buildCsp(base)).get('connect-src')).toEqual(["'self'"]);
  });

  it('names a pinned API origin and its WebSocket exactly', () => {
    const policy = buildCsp({ ...base, apiOrigin: 'https://chat.example.com' });
    const connect = directives(policy).get('connect-src') ?? [];

    expect(connect).toContain('https://chat.example.com');
    expect(connect).toContain('wss://chat.example.com');
    // Still no blanket permission.
    expect(connect).not.toContain('https:');
  });

  it('derives ws:// rather than wss:// from an http origin', () => {
    const policy = buildCsp({ ...base, apiOrigin: 'http://localhost:4000' });
    expect(directives(policy).get('connect-src')).toContain('ws://localhost:4000');
  });

  it('widens to secure origins only when runtime server choice is enabled', () => {
    const connect =
      directives(buildCsp({ ...base, allowRuntimeServer: true })).get('connect-src') ??
      [];

    expect(connect).toContain('https:');
    expect(connect).toContain('wss:');
    // Loopback over plain HTTP is a real developer workflow that serverOrigin
    // also accepts, and is not an exfiltration target.
    expect(connect).toContain('http://localhost:*');
    // But plain HTTP to the internet at large is still refused.
    expect(connect).not.toContain('http:');
    expect(connect).not.toContain('*');
  });

  it('does not widen by accident when the flag is off', () => {
    const connect =
      directives(buildCsp({ ...base, apiOrigin: 'https://chat.example.com' })).get(
        'connect-src',
      ) ?? [];
    expect(connect).not.toContain('https:');
    expect(connect).not.toContain('http://localhost:*');
  });
});

describe('the rest of the policy', () => {
  it('denies everything not explicitly allowed', () => {
    expect(directives(buildCsp(base)).get('default-src')).toEqual(["'none'"]);
  });

  it('blocks plugins, base-tag hijacking and form submission', () => {
    const d = directives(buildCsp(base));
    expect(d.get('object-src')).toEqual(["'none'"]);
    expect(d.get('base-uri')).toEqual(["'none'"]);
    expect(d.get('form-action')).toEqual(["'none'"]);
  });

  it('allows blob URLs for decrypted attachments but not for script', () => {
    const d = directives(buildCsp(base));
    // Decrypted images and audio become object URLs in the page.
    expect(d.get('img-src')).toContain('blob:');
    expect(d.get('media-src')).toContain('blob:');
    expect(d.get('script-src')).not.toContain('blob:');
  });

  it('upgrades insecure subresource requests', () => {
    expect(directives(buildCsp(base)).has('upgrade-insecure-requests')).toBe(true);
  });

  it('produces a value safe to place in an HTML attribute', () => {
    // It is injected as content="…", so a double quote would break out of the
    // attribute and inject markup.
    const policy = buildCsp({
      ...base,
      apiOrigin: 'https://chat.example.com',
      allowRuntimeServer: true,
      inlineScriptHashes: ["'sha256-abc123'"],
    });
    expect(policy).not.toContain('"');
    expect(policy).not.toContain('<');
  });
});
