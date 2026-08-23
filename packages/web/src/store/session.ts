/**
 * Session state: who is signed in, on which device, and how healthy the
 * connection to the server is.
 */
import { create } from 'zustand';
import {
  sodium,
  toB64,
  type AppearanceSettings,
  type SelfUser,
} from '@wolffmsg/shared';
import { ApiError, NetworkError, api, forgetCsrfToken } from '../lib/api.ts';
import { realtime, type ConnectionState } from '../lib/socket.ts';
import {
  clearServerOrigin,
  needsServerChoice,
  serverOrigin,
  setServerOrigin,
} from '../lib/serverOrigin.ts';
import {
  adoptIdentity,
  createIdentity,
  currentSecrets,
  forgetSession,
  initSession,
  runKeyMaintenance,
} from '../crypto/session.ts';
import { destroyVault } from '../crypto/keyVault.ts';
import { destroyDb } from '../lib/idb.ts';
import { clearMemory } from '../crypto/messageCache.ts';
import { releaseAllAttachments } from '../crypto/attachments.ts';
import { useUi } from './ui.ts';

export interface ServerConfig {
  registrationOpen: boolean;
  pushEnabled: boolean;
  vapidPublicKey: string | null;
  maxAttachmentBytes: number;
  maxAvatarBytes: number;
  callsEnabled: boolean;
  turnConfigured: boolean;
}

type Phase =
  | 'booting'
  | 'needs-server'
  | 'signed-out'
  | 'signed-in'
  | 'unsupported';

interface SessionState {
  phase: Phase;
  user: SelfUser | null;
  deviceId: string | null;
  config: ServerConfig | null;
  connection: ConnectionState;
  /** Set when the browser cannot support the security model at all. */
  blockingError: string | null;

  /** The API origin in use, or `''` when the server serves this page itself. */
  serverOrigin: string;

  boot: () => Promise<void>;
  /** Point this client at a server and boot against it. */
  connectToServer: (origin: string) => Promise<void>;
  /** Forget the chosen server, wipe local keys, and return to the connect screen. */
  forgetServer: () => Promise<void>;
  register: (input: {
    username: string;
    password: string;
    displayName: string;
  }) => Promise<void>;
  signIn: (input: { username: string; password: string }) => Promise<void>;
  signOut: () => Promise<void>;
  /** The server has already invalidated this session; tear down locally. */
  handleRevoked: (reason: string) => Promise<void>;
  refreshUser: () => Promise<void>;
  applyAppearance: (appearance: Partial<AppearanceSettings>) => Promise<void>;
  setUser: (user: SelfUser) => void;
}

/**
 * Tell "no WolffMsg server here" apart from "the server answered badly".
 *
 * A static host serves its 404 page for `/api/config`; a wrong hostname or a
 * blocked CORS preflight fails before any response arrives. Both mean the
 * address is wrong. A 500 does not — that server exists and is having a bad
 * day, and pushing someone to re-enter a correct address would not help.
 */
function isServerUnreachable(err: unknown): boolean {
  if (err instanceof NetworkError) return true;
  if (err instanceof ApiError) return err.status === 404 || err.status === 405;
  return false;
}

/** Describe this browser for the device list, without fingerprinting detail. */
function describeThisDevice(): { name: string; platform: string } {
  const ua = navigator.userAgent;
  const platform = /android/i.test(ua)
    ? 'Android'
    : /iphone|ipad|ipod/i.test(ua)
      ? 'iOS'
      : /mac os x/i.test(ua)
        ? 'macOS'
        : /windows/i.test(ua)
          ? 'Windows'
          : /linux/i.test(ua)
            ? 'Linux'
            : 'Unknown';

  const name = /edg\//i.test(ua)
    ? 'Edge'
    : /opr\//i.test(ua)
      ? 'Opera'
      : /firefox\//i.test(ua)
        ? 'Firefox'
        : /chrome\//i.test(ua)
          ? 'Chrome'
          : /safari\//i.test(ua)
            ? 'Safari'
            : 'Browser';

  return { name, platform };
}

/**
 * Push the appearance choice onto the document root.
 *
 * Applied as data attributes rather than a class so the token file can express
 * the whole theme without any JavaScript involvement at paint time.
 */
export function applyAppearanceToDocument(appearance: AppearanceSettings): void {
  const root = document.documentElement;
  const resolved =
    appearance.theme === 'system'
      ? window.matchMedia('(prefers-color-scheme: light)').matches
        ? 'light'
        : 'dark'
      : appearance.theme;

  root.dataset.theme = resolved;
  root.dataset.accent = appearance.accent;
  root.dataset.density = appearance.messageDensity;
  root.dataset.reducedMotion = String(appearance.reducedMotion);
  root.style.setProperty('--font-scale', String(appearance.fontScale));

  const themeColor = resolved === 'light' ? '#f2f4f9' : '#06070a';
  document
    .querySelector('meta[name="theme-color"]')
    ?.setAttribute('content', themeColor);
}

export const useSession = create<SessionState>((set, get) => ({
  phase: 'booting',
  user: null,
  deviceId: null,
  config: null,
  connection: 'offline',
  blockingError: null,
  serverOrigin: serverOrigin(),

  connectToServer: async (origin) => {
    // Throws with a readable reason if the address is not a usable origin.
    const normalised = setServerOrigin(origin);

    /*
     * The phase deliberately stays `needs-server` until the address is known
     * to work. Switching to `booting` here would unmount the form mid-request,
     * and the error this throws would land on a component that no longer
     * exists — the screen would silently reset instead of saying what failed.
     */
    let config: ServerConfig;
    try {
      config = await api.get<ServerConfig>('/api/config');
    } catch (err) {
      // Keep a chosen origin only when something that looks like a server
      // answered; a wrong address must not linger and break the next attempt.
      if (isServerUnreachable(err)) {
        clearServerOrigin();
        throw new Error('No WolffMsg server answered at that address');
      }
      throw err;
    }

    set({ config, serverOrigin: normalised, phase: 'booting' });
    await initSession();

    try {
      const me = await api.get<{ user: SelfUser; deviceId: string | null }>(
        '/api/auth/me',
      );
      applyAppearanceToDocument(me.user.appearance);
      set({ phase: 'signed-in', user: me.user, deviceId: me.deviceId });
      realtime.connect();
      void runKeyMaintenance();
    } catch {
      set({ phase: 'signed-out', user: null, deviceId: null });
    }
  },

  forgetServer: async () => {
    realtime.disconnect();
    await api.post('/api/auth/logout').catch(() => undefined);

    /*
     * Device keys are registered with one server, so pointing this client at a
     * different one leaves them meaningless. Wipe them along with everything
     * they decrypt, exactly as signing out does — a switch must not leave one
     * server's plaintext cache sitting in front of another server's account.
     */
    releaseAllAttachments();
    clearMemory();
    await destroyVault().catch(() => undefined);
    await destroyDb().catch(() => undefined);
    forgetSession();
    forgetCsrfToken();
    clearServerOrigin();

    set({
      phase: 'needs-server',
      user: null,
      deviceId: null,
      config: null,
      serverOrigin: serverOrigin(),
    });
  },

  boot: async () => {
    // The security model rests on Web Crypto and IndexedDB. Without them the
    // app must refuse to run rather than silently degrade.
    if (typeof crypto === 'undefined' || !crypto.subtle) {
      set({
        phase: 'unsupported',
        blockingError:
          'WolffMsg needs the Web Crypto API to protect your keys. It is only ' +
          'available over HTTPS (or on localhost).',
      });
      return;
    }

    realtime.onStateChange((connection) => set({ connection }));

    /*
     * `/api/config` doubles as a reachability probe. A static host has no API
     * to answer it, and rather than dropping someone onto a sign-in form whose
     * every button will fail, the app asks which server to talk to.
     */
    if (needsServerChoice()) {
      set({ phase: 'needs-server' });
      return;
    }

    try {
      const config = await api.get<ServerConfig>('/api/config');
      set({ config });
    } catch (err) {
      if (isServerUnreachable(err)) {
        set({ phase: 'needs-server' });
        return;
      }
      // Reachable but unhappy — the sign-in screen can still render.
    }

    await initSession();

    try {
      const me = await api.get<{ user: SelfUser; deviceId: string | null }>(
        '/api/auth/me',
      );
      applyAppearanceToDocument(me.user.appearance);
      set({ phase: 'signed-in', user: me.user, deviceId: me.deviceId });
      realtime.connect();
      void runKeyMaintenance();
    } catch {
      set({ phase: 'signed-out', user: null, deviceId: null });
    }
  },

  register: async ({ username, password, displayName }) => {
    const { bundle, pending } = await createIdentity();
    const device = describeThisDevice();

    const response = await api.post<{ user: SelfUser; deviceId: string }>(
      '/api/auth/register',
      {
        username,
        password,
        displayName,
        device: {
          name: device.name,
          platform: device.platform,
          identityPublicKey: bundle.identityPublicKey,
          signedPreKey: bundle.signedPreKey,
          oneTimePreKeys: bundle.oneTimePreKeys,
        },
      },
    );

    await adoptIdentity(pending, response.deviceId);
    applyAppearanceToDocument(response.user.appearance);
    set({ phase: 'signed-in', user: response.user, deviceId: response.deviceId });
    realtime.connect();
  },

  signIn: async ({ username, password }) => {
    const existing = currentSecrets();

    // If this device already holds an identity, prove possession of its
    // private key and keep it — that preserves the ability to read history
    // already encrypted to it.
    if (existing) {
      try {
        const challenge = await api.get<{ nonce: string }>('/api/auth/challenge');
        const signature = toB64(
          sodium().crypto_sign_detached(
            new TextEncoder().encode(`wolffmsg:device-auth:v1:${challenge.nonce}`),
            sodium().from_base64(
              existing.identityPrivateKey,
              sodium().base64_variants.ORIGINAL,
            ),
          ),
        );

        const response = await api.post<{ user: SelfUser; deviceId: string }>(
          '/api/auth/login',
          {
            username,
            password,
            existingDevice: {
              deviceId: existing.deviceId,
              nonce: challenge.nonce,
              signature,
            },
          },
        );

        applyAppearanceToDocument(response.user.appearance);
        set({ phase: 'signed-in', user: response.user, deviceId: response.deviceId });
        realtime.connect();
          void runKeyMaintenance();
        return;
      } catch (err) {
        // A wrong password must surface as a wrong password, not silently
        // fall through to registering a brand-new device.
        if ((err as { status?: number }).status === 401) throw err;
        // Otherwise the stored device is stale (removed server-side, or the
        // account differs) — fall through and register a fresh one.
      }
    }

    const { bundle, pending } = await createIdentity();
    const device = describeThisDevice();

    const response = await api.post<{ user: SelfUser; deviceId: string }>(
      '/api/auth/login',
      {
        username,
        password,
        device: {
          name: device.name,
          platform: device.platform,
          identityPublicKey: bundle.identityPublicKey,
          signedPreKey: bundle.signedPreKey,
          oneTimePreKeys: bundle.oneTimePreKeys,
        },
      },
    );

    await adoptIdentity(pending, response.deviceId);
    applyAppearanceToDocument(response.user.appearance);
    set({ phase: 'signed-in', user: response.user, deviceId: response.deviceId });
    realtime.connect();
  },

  signOut: async () => {
    realtime.disconnect();
    await api.post('/api/auth/logout').catch(() => undefined);

    // Everything local goes: keys, decrypted cache, decrypted blobs. Leaving
    // any of it behind would mean signing out did not actually protect the
    // person who did it.
    releaseAllAttachments();
    clearMemory();
    await destroyVault().catch(() => undefined);
    await destroyDb().catch(() => undefined);
    forgetSession();
    forgetCsrfToken();

    set({ phase: 'signed-out', user: null, deviceId: null });
  },

  handleRevoked: async (reason) => {
    /*
     * Reached when another device revoked this session, or a password change
     * invalidated it. The session is already gone server-side, so there is
     * nothing to log out *from* — but this device is still holding decrypted
     * messages and unwrapped keys in memory, and revoking a session has to mean
     * they stop being available here rather than lingering until the next
     * request happens to come back 401.
     */
    if (get().phase !== 'signed-in') return;

    realtime.disconnect();
    releaseAllAttachments();
    clearMemory();
    await destroyVault().catch(() => undefined);
    await destroyDb().catch(() => undefined);
    forgetSession();
    forgetCsrfToken();

    set({ phase: 'signed-out', user: null, deviceId: null });
    useUi
      .getState()
      .toast(
        reason === 'password-changed'
          ? 'You were signed out because the account password changed.'
          : 'This device was signed out from another device.',
        'warning',
      );
  },

  refreshUser: async () => {
    const me = await api.get<{ user: SelfUser; deviceId: string | null }>(
      '/api/auth/me',
    );
    applyAppearanceToDocument(me.user.appearance);
    set({ user: me.user, deviceId: me.deviceId });
  },

  applyAppearance: async (patch) => {
    const user = get().user;
    if (!user) return;

    // Optimistic: the theme must flip instantly, not after a round trip.
    const next = { ...user.appearance, ...patch };
    applyAppearanceToDocument(next);
    set({ user: { ...user, appearance: next } });

    try {
      const response = await api.patch<{ user: SelfUser }>(
        '/api/me/appearance',
        patch,
      );
      set({ user: response.user });
    } catch {
      applyAppearanceToDocument(user.appearance);
      set({ user });
    }
  },

  setUser: (user) => set({ user }),
}));
