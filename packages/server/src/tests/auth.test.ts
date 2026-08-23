import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createDeviceSecrets } from '@wolffmsg/shared';
import {
  closeApp,
  createActor,
  prisma,
  request,
  resetDatabase,
  signChallenge,
} from './helpers.js';
import { hashPassword, needsRehash, verifyPassword } from '../auth/password.js';
import { env } from '../env.js';

beforeEach(async () => {
  await resetDatabase();
});

afterAll(async () => {
  await closeApp();
});

function deviceBundle() {
  const { bundle } = createDeviceSecrets('pending', 4);
  return {
    name: 'Vitest',
    platform: 'Linux',
    identityPublicKey: bundle.identityPublicKey,
    signedPreKey: bundle.signedPreKey,
    oneTimePreKeys: bundle.oneTimePreKeys,
  };
}

describe('password hashing', () => {
  it('produces an Argon2id hash with the configured cost', async () => {
    const hash = await hashPassword('a-strong-test-password-9271');
    expect(hash.startsWith('$argon2id$')).toBe(true);
    expect(hash).toMatch(/\$m=65536,t=3,p=4\$/);
    expect(needsRehash(hash)).toBe(false);
  });

  it('verifies correctly and rejects a wrong password', async () => {
    const hash = await hashPassword('a-strong-test-password-9271');
    expect(await verifyPassword(hash, 'a-strong-test-password-9271')).toBe(true);
    expect(await verifyPassword(hash, 'not-the-password')).toBe(false);
  });

  it('salts, so identical passwords hash differently', async () => {
    const a = await hashPassword('a-strong-test-password-9271');
    const b = await hashPassword('a-strong-test-password-9271');
    expect(a).not.toBe(b);
  });

  it('flags a weaker legacy hash for upgrade', () => {
    expect(needsRehash('$argon2id$v=19$m=4096,t=1,p=1$abc$def')).toBe(true);
    expect(needsRehash('not-a-hash')).toBe(true);
  });
});

describe('registration', () => {
  it('creates an account and returns a session', async () => {
    const actor = await createActor('wolf_alpha');
    expect(actor.userId).toBeTruthy();
    expect(actor.deviceId).toBeTruthy();
    expect(actor.cookie).toContain('session');
  });

  it('never stores the password in plaintext', async () => {
    const password = 'super-secret-canary-64182';
    await request({
      method: 'POST',
      url: '/api/auth/register',
      payload: {
        username: 'wolf_canary',
        password,
        displayName: 'Canary',
        device: deviceBundle(),
      },
    });

    const user = await prisma.user.findUniqueOrThrow({
      where: { username: 'wolf_canary' },
      select: { passwordHash: true },
    });
    expect(user.passwordHash).not.toContain(password);
    expect(user.passwordHash.startsWith('$argon2id$')).toBe(true);

    // And nowhere else in the database either.
    const dump = JSON.stringify(await prisma.user.findMany());
    expect(dump).not.toContain(password);
  });

  it('rejects a duplicate username', async () => {
    await createActor('wolf_dupe');
    const response = await request<{ error: { code: string } }>({
      method: 'POST',
      url: '/api/auth/register',
      payload: {
        username: 'wolf_dupe',
        password: 'a-strong-test-password-9271',
        displayName: 'Copy',
        device: deviceBundle(),
      },
    });
    expect(response.status).toBe(409);
    expect(response.body.error.code).toBe('username_taken');
  });

  it('rejects a weak password', async () => {
    const response = await request<{ error: { fields?: Record<string, string> } }>({
      method: 'POST',
      url: '/api/auth/register',
      payload: {
        username: 'wolf_weak',
        password: 'short',
        displayName: 'Weak',
        device: deviceBundle(),
      },
    });
    expect(response.status).toBe(400);
    expect(response.body.error.fields?.password).toBeTruthy();
  });

  it('rejects an invalid username', async () => {
    const response = await request<{ error: { fields?: Record<string, string> } }>({
      method: 'POST',
      url: '/api/auth/register',
      payload: {
        username: 'Not Valid!',
        password: 'a-strong-test-password-9271',
        displayName: 'Nope',
        device: deviceBundle(),
      },
    });
    expect(response.status).toBe(400);
    expect(response.body.error.fields?.username).toBeTruthy();
  });

  it('rejects a display name carrying a bidi override', async () => {
    const response = await request({
      method: 'POST',
      url: '/api/auth/register',
      payload: {
        username: 'wolf_bidi',
        password: 'a-strong-test-password-9271',
        // U+202E right-to-left override — a display-name spoofing trick.
        displayName: 'admin‮evil',
        device: deviceBundle(),
      },
    });
    // The override is stripped during normalisation, so the account is created
    // with a safe name rather than the spoofed one.
    expect(response.status).toBe(201);
    const user = await prisma.user.findUniqueOrThrow({
      where: { username: 'wolf_bidi' },
      select: { displayName: true },
    });
    expect(user.displayName).not.toContain('‮');
  });

  it('rejects a prekey whose signature does not match the identity key', async () => {
    const real = createDeviceSecrets('pending', 2);
    const attacker = createDeviceSecrets('pending', 2);
    const response = await request({
      method: 'POST',
      url: '/api/auth/register',
      payload: {
        username: 'wolf_badkey',
        password: 'a-strong-test-password-9271',
        displayName: 'Bad key',
        device: {
          name: 'Vitest',
          platform: 'Linux',
          identityPublicKey: real.bundle.identityPublicKey,
          // Signed by a different identity.
          signedPreKey: attacker.bundle.signedPreKey,
          oneTimePreKeys: [],
        },
      },
    });
    expect(response.status).toBe(400);
  });
});

describe('login', () => {
  it('signs in with the right password', async () => {
    await createActor('wolf_login');
    const response = await request({
      method: 'POST',
      url: '/api/auth/login',
      payload: {
        username: 'wolf_login',
        password: 'a-strong-test-password-9271',
        device: deviceBundle(),
      },
    });
    expect(response.status).toBe(200);
  });

  it('rejects a wrong password', async () => {
    await createActor('wolf_wrongpw');
    const response = await request({
      method: 'POST',
      url: '/api/auth/login',
      payload: {
        username: 'wolf_wrongpw',
        password: 'definitely-not-the-password',
        device: deviceBundle(),
      },
    });
    expect(response.status).toBe(401);
  });

  it('gives an identical answer for an unknown username', async () => {
    await createActor('wolf_exists');

    const wrongPassword = await request<{ error: { message: string } }>({
      method: 'POST',
      url: '/api/auth/login',
      payload: {
        username: 'wolf_exists',
        password: 'definitely-not-the-password',
        device: deviceBundle(),
      },
    });
    const unknownUser = await request<{ error: { message: string } }>({
      method: 'POST',
      url: '/api/auth/login',
      payload: {
        username: 'nobody_here_at_all',
        password: 'definitely-not-the-password',
        device: deviceBundle(),
      },
    });

    // Same status and same wording — no account enumeration.
    expect(unknownUser.status).toBe(wrongPassword.status);
    expect(unknownUser.body.error.message).toBe(wrongPassword.body.error.message);
  });

  it('locks out after repeated failures', async () => {
    await createActor('wolf_bruteforce');
    let sawRateLimit = false;
    for (let i = 0; i < 12; i += 1) {
      const response = await request({
        method: 'POST',
        url: '/api/auth/login',
        payload: {
          username: 'wolf_bruteforce',
          password: `guess-number-${i}`,
          device: deviceBundle(),
        },
      });
      if (response.status === 429 || response.status === 409) {
        sawRateLimit = true;
        break;
      }
    }
    expect(sawRateLimit).toBe(true);
  });

  it('re-binds an existing device only with a valid signature', async () => {
    const actor = await createActor('wolf_rebind');

    const challenge = await request<{ nonce: string }>({
      method: 'GET',
      url: '/api/auth/challenge',
    });
    const signature = await signChallenge(actor.secrets, challenge.body.nonce);

    const good = await request<{ deviceId: string }>({
      method: 'POST',
      url: '/api/auth/login',
      payload: {
        username: 'wolf_rebind',
        password: 'a-strong-test-password-9271',
        existingDevice: {
          deviceId: actor.deviceId,
          nonce: challenge.body.nonce,
          signature,
        },
      },
    });
    expect(good.status).toBe(200);
    expect(good.body.deviceId).toBe(actor.deviceId);

    // A forged signature is refused.
    const secondChallenge = await request<{ nonce: string }>({
      method: 'GET',
      url: '/api/auth/challenge',
    });
    const impostor = createDeviceSecrets('pending', 1);
    const bad = await request({
      method: 'POST',
      url: '/api/auth/login',
      payload: {
        username: 'wolf_rebind',
        password: 'a-strong-test-password-9271',
        existingDevice: {
          deviceId: actor.deviceId,
          nonce: secondChallenge.body.nonce,
          signature: await signChallenge(impostor.secrets, secondChallenge.body.nonce),
        },
      },
    });
    expect(bad.status).toBe(401);
  });

  it('will not accept a replayed challenge', async () => {
    const actor = await createActor('wolf_replay');
    const challenge = await request<{ nonce: string }>({
      method: 'GET',
      url: '/api/auth/challenge',
    });
    const signature = await signChallenge(actor.secrets, challenge.body.nonce);
    const payload = {
      username: 'wolf_replay',
      password: 'a-strong-test-password-9271',
      existingDevice: {
        deviceId: actor.deviceId,
        nonce: challenge.body.nonce,
        signature,
      },
    };

    expect((await request({ method: 'POST', url: '/api/auth/login', payload })).status).toBe(200);
    // The nonce is single-use.
    expect((await request({ method: 'POST', url: '/api/auth/login', payload })).status).toBe(400);
  });
});

describe('sessions', () => {
  it('rejects an unauthenticated request', async () => {
    const response = await request({ method: 'GET', url: '/api/chats' });
    expect(response.status).toBe(401);
  });

  it('rejects a forged session cookie', async () => {
    const actor = await createActor();
    const forged = actor.cookie.replace(/(session=[^.]+\.)(.+?)(;|$)/, '$1forged-secret$3');
    const response = await request({
      method: 'GET',
      url: '/api/chats',
      headers: { cookie: forged, 'x-wolff-csrf': actor.csrfToken },
    });
    expect(response.status).toBe(401);
  });

  it('stores only a keyed hash of the session secret', async () => {
    const actor = await createActor();
    const secret = actor.cookie.split('session=')[1]?.split(';')[0]?.split('.')[1] ?? '';
    expect(secret.length).toBeGreaterThan(20);

    const sessions = await prisma.session.findMany({ select: { tokenHash: true } });
    for (const session of sessions) {
      expect(Buffer.from(session.tokenHash).toString('base64url')).not.toBe(secret);
      expect(session.tokenHash.length).toBe(32);
    }
  });

  it('signs out and invalidates the cookie', async () => {
    const actor = await createActor();
    expect((await request({ method: 'GET', url: '/api/auth/me', actor })).status).toBe(200);

    await request({ method: 'POST', url: '/api/auth/logout', actor });
    expect((await request({ method: 'GET', url: '/api/auth/me', actor })).status).toBe(401);
  });

  it('lists active sessions and revokes another one', async () => {
    const first = await createActor('wolf_multi');
    const second = await loginSecond('wolf_multi');

    const list = await request<{ sessions: { id: string; current: boolean }[] }>({
      method: 'GET',
      url: '/api/auth/sessions',
      actor: first,
    });
    expect(list.body.sessions.length).toBe(2);

    const other = list.body.sessions.find((s) => !s.current);
    expect(other).toBeTruthy();

    const revoked = await request({
      method: 'DELETE',
      url: `/api/auth/sessions/${other!.id}`,
      actor: first,
    });
    expect(revoked.status).toBe(200);

    // The revoked session stops working immediately.
    expect((await request({ method: 'GET', url: '/api/auth/me', actor: second })).status).toBe(401);
    expect((await request({ method: 'GET', url: '/api/auth/me', actor: first })).status).toBe(200);
  });

  it('will not let one user revoke another user session', async () => {
    const victim = await createActor();
    const attacker = await createActor();

    const victimSessions = await request<{ sessions: { id: string }[] }>({
      method: 'GET',
      url: '/api/auth/sessions',
      actor: victim,
    });
    const targetId = victimSessions.body.sessions[0]!.id;

    const response = await request({
      method: 'DELETE',
      url: `/api/auth/sessions/${targetId}`,
      actor: attacker,
    });
    expect(response.status).toBe(404);
    expect((await request({ method: 'GET', url: '/api/auth/me', actor: victim })).status).toBe(200);
  });

  it('signs out every other session when the password changes', async () => {
    const first = await createActor('wolf_pwchange');
    const second = await loginSecond('wolf_pwchange');

    const response = await request({
      method: 'POST',
      url: '/api/auth/password',
      actor: first,
      payload: {
        currentPassword: 'a-strong-test-password-9271',
        newPassword: 'an-even-stronger-password-55193',
      },
    });
    expect(response.status).toBe(200);

    expect((await request({ method: 'GET', url: '/api/auth/me', actor: second })).status).toBe(401);
    expect((await request({ method: 'GET', url: '/api/auth/me', actor: first })).status).toBe(200);
  });

  it('refuses a password change without the current password', async () => {
    const actor = await createActor();
    const response = await request({
      method: 'POST',
      url: '/api/auth/password',
      actor,
      payload: {
        currentPassword: 'wrong-current-password',
        newPassword: 'an-even-stronger-password-55193',
      },
    });
    expect(response.status).toBe(401);
  });
});

describe('CSRF', () => {
  it('rejects a state-changing request with no CSRF header', async () => {
    const actor = await createActor();
    const response = await request({
      method: 'POST',
      url: '/api/chats/direct',
      headers: { cookie: actor.cookie },
      payload: { userId: actor.userId },
    });
    expect(response.status).toBe(403);
  });

  it('rejects a mismatched CSRF token', async () => {
    const actor = await createActor();
    const response = await request({
      method: 'POST',
      url: '/api/chats/direct',
      headers: { cookie: actor.cookie, 'x-wolff-csrf': 'not-the-right-token' },
      payload: { userId: actor.userId },
    });
    expect(response.status).toBe(403);
  });

  it('rejects a request from an unrecognised origin', async () => {
    const actor = await createActor();
    const response = await request({
      method: 'POST',
      url: '/api/chats/direct',
      actor,
      headers: { origin: 'https://evil.example' },
      payload: { userId: actor.userId },
    });
    expect(response.status).toBe(403);
  });

  it('allows a safe method without a CSRF token', async () => {
    const actor = await createActor();
    const response = await request({
      method: 'GET',
      url: '/api/chats',
      headers: { cookie: actor.cookie },
    });
    expect(response.status).toBe(200);
  });

  /*
   * Split-origin deployments (a client on a static host) must relax the cookie
   * to `SameSite=none`, at which point a missing Origin header can no longer be
   * read as "same-site" — the browser is no longer refusing cross-site requests
   * on our behalf. The header becomes mandatory for anything carrying a session.
   */
  it('requires an Origin header on a session request when SameSite is none', async () => {
    const actor = await createActor();
    const original = env.COOKIE_SAMESITE;
    (env as { COOKIE_SAMESITE: string }).COOKIE_SAMESITE = 'none';
    try {
      const withoutOrigin = await request({
        method: 'POST',
        url: '/api/chats/direct',
        headers: {
          cookie: actor.cookie,
          'x-wolff-csrf': actor.csrfToken,
          origin: undefined as unknown as string,
        },
        payload: { userId: actor.userId },
      });
      expect(withoutOrigin.status).toBe(403);

      const withOrigin = await request({
        method: 'POST',
        url: '/api/chats/direct',
        headers: {
          cookie: actor.cookie,
          'x-wolff-csrf': actor.csrfToken,
          origin: env.webOrigins[0] ?? 'http://localhost:5173',
        },
        payload: { userId: actor.userId },
      });
      // A chat with oneself is refused on its own merits — what matters is
      // that CSRF let it through to the route at all.
      expect(withOrigin.status).not.toBe(403);
    } finally {
      (env as { COOKIE_SAMESITE: string }).COOKIE_SAMESITE = original;
    }
  });
});

describe('security events', () => {
  it('records sign-in and failed attempts without leaking secrets', async () => {
    const actor = await createActor('wolf_audit');
    await request({
      method: 'POST',
      url: '/api/auth/login',
      payload: {
        username: 'wolf_audit',
        password: 'wrong-password-here',
        device: deviceBundle(),
      },
    });

    const response = await request<{ events: { kind: string; detail: string }[] }>({
      method: 'GET',
      url: '/api/me/security-events',
      actor,
    });
    expect(response.status).toBe(200);
    const kinds = response.body.events.map((e) => e.kind);
    expect(kinds).toContain('device.registered');
    expect(kinds).toContain('login.failed');

    const dump = JSON.stringify(response.body);
    expect(dump).not.toContain('a-strong-test-password-9271');
    expect(dump).not.toContain(actor.secrets.identityPrivateKey);
  });
});

/** Sign a second device in for the same account. */
async function loginSecond(username: string) {
  const { createDeviceSecrets: make } = await import('@wolffmsg/shared');
  const { secrets, bundle } = make('pending', 4);
  const response = await request<{ user: { id: string }; deviceId: string }>({
    method: 'POST',
    url: '/api/auth/login',
    payload: {
      username,
      password: 'a-strong-test-password-9271',
      device: {
        name: 'Second device',
        platform: 'Android',
        identityPublicKey: bundle.identityPublicKey,
        signedPreKey: bundle.signedPreKey,
        oneTimePreKeys: bundle.oneTimePreKeys,
      },
    },
  });
  const session = response.cookies.find((c) => c.name.includes('session'));
  const csrf = response.cookies.find((c) => c.name.includes('csrf'));
  return {
    userId: response.body.user.id,
    username,
    displayName: username,
    deviceId: response.body.deviceId,
    secrets: { ...secrets, deviceId: response.body.deviceId },
    cookie: `${session?.name}=${session?.value}; ${csrf?.name}=${csrf?.value}`,
    csrfToken: csrf?.value ?? '',
  };
}
