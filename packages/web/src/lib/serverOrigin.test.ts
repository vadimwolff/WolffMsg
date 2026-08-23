/**
 * The server address a person types is the origin every API request and the
 * WebSocket are built from, so it is an input worth treating as hostile. These
 * tests pin down what is accepted and what is not.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  apiUrl,
  clearServerOrigin,
  describeOriginProblem,
  isSplitOrigin,
  normaliseOrigin,
  serverOrigin,
  setServerOrigin,
  socketUrl,
} from './serverOrigin.ts';

beforeEach(() => {
  localStorage.clear();
  clearServerOrigin();
});

describe('normaliseOrigin', () => {
  it('accepts a bare https origin', () => {
    expect(normaliseOrigin('https://chat.example.com')).toBe('https://chat.example.com');
  });

  it('keeps an explicit port', () => {
    expect(normaliseOrigin('https://chat.example.com:8443')).toBe(
      'https://chat.example.com:8443',
    );
  });

  it('strips a trailing slash rather than rejecting it', () => {
    expect(normaliseOrigin('https://chat.example.com/')).toBe(
      'https://chat.example.com',
    );
    expect(normaliseOrigin('  https://chat.example.com///  ')).toBe(
      'https://chat.example.com',
    );
  });

  it('rejects plain http on a public host', () => {
    // Web Crypto is unavailable outside a secure context, so the app could not
    // generate or unwrap a key against such a server at all.
    expect(normaliseOrigin('http://chat.example.com')).toBe('');
  });

  it('allows plain http on loopback, where the browser grants a secure context', () => {
    expect(normaliseOrigin('http://localhost:4000')).toBe('http://localhost:4000');
    expect(normaliseOrigin('http://127.0.0.1:4000')).toBe('http://127.0.0.1:4000');
  });

  it('refuses anything carrying a path, query or fragment', () => {
    // These would be silently dropped when joined to an API path; refusing is
    // clearer than half-honouring them.
    expect(normaliseOrigin('https://example.com/wolff')).toBe('');
    expect(normaliseOrigin('https://example.com/?a=1')).toBe('');
    expect(normaliseOrigin('https://example.com/#x')).toBe('');
  });

  it('refuses schemes that are not http(s)', () => {
    expect(normaliseOrigin('javascript:alert(1)')).toBe('');
    expect(normaliseOrigin('data:text/html,x')).toBe('');
    expect(normaliseOrigin('ws://example.com')).toBe('');
    expect(normaliseOrigin('file:///etc/passwd')).toBe('');
  });

  it('refuses input with no scheme, rather than guessing one', () => {
    expect(normaliseOrigin('chat.example.com')).toBe('');
    expect(normaliseOrigin('//chat.example.com')).toBe('');
  });

  it('refuses empty and whitespace input', () => {
    expect(normaliseOrigin('')).toBe('');
    expect(normaliseOrigin('   ')).toBe('');
  });
});

describe('describeOriginProblem', () => {
  it('says nothing when the address is usable', () => {
    expect(describeOriginProblem('https://chat.example.com')).toBeNull();
  });

  it('names the specific problem so the form can be corrected', () => {
    expect(describeOriginProblem('')).toMatch(/enter/i);
    expect(describeOriginProblem('chat.example.com')).toMatch(/scheme/i);
    expect(describeOriginProblem('http://chat.example.com')).toMatch(/https/i);
    expect(describeOriginProblem('https://chat.example.com/app')).toMatch(/path/i);
  });
});

describe('choosing a server', () => {
  it('remembers a choice and builds URLs from it', () => {
    setServerOrigin('https://chat.example.com');

    expect(serverOrigin()).toBe('https://chat.example.com');
    expect(apiUrl('/api/config')).toBe('https://chat.example.com/api/config');
    expect(socketUrl()).toBe('wss://chat.example.com/ws');
    expect(isSplitOrigin()).toBe(true);
  });

  it('derives ws:// from an http origin, not wss://', () => {
    setServerOrigin('http://localhost:4000');
    expect(socketUrl()).toBe('ws://localhost:4000/ws');
  });

  it('refuses to store an unusable address, with a readable reason', () => {
    expect(() => setServerOrigin('http://chat.example.com')).toThrow(/https/i);
    expect(serverOrigin()).toBe('');
  });

  it('falls back to same-origin once a choice is forgotten', () => {
    setServerOrigin('https://chat.example.com');
    clearServerOrigin();

    expect(serverOrigin()).toBe('');
    // A relative path, so the browser keeps the request on this origin and
    // SameSite=strict cookies keep working.
    expect(apiUrl('/api/config')).toBe('/api/config');
    expect(isSplitOrigin()).toBe(false);
  });

  it('is not split-origin when the stored address is this page', () => {
    setServerOrigin(location.origin);
    expect(isSplitOrigin()).toBe(false);
  });

  it('discards a stored value that no longer passes validation', async () => {
    // Written by an older build, or by hand into devtools. The stored value is
    // re-checked when it is first read rather than trusted because it once got
    // past the form. A fresh module instance is what makes this a real test:
    // the loaded value is cached for the life of the module.
    localStorage.setItem('wolffmsg.server-origin', 'http://evil.example.com');

    vi.resetModules();
    const fresh = await import('./serverOrigin.ts');

    expect(fresh.serverOrigin()).toBe('');
  });

  it('honours a valid stored value on a fresh load', async () => {
    localStorage.setItem('wolffmsg.server-origin', 'https://chat.example.com');

    vi.resetModules();
    const fresh = await import('./serverOrigin.ts');

    expect(fresh.serverOrigin()).toBe('https://chat.example.com');
  });
});
