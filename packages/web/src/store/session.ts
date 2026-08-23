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
import { api } from '../lib/api.ts';
import { realtime, type ConnectionState } from '../lib/socket.ts';
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

export interface ServerConfig {
  registrationOpen: boolean;
  pushEnabled: boolean;
  vapidPublicKey: string | null;
  maxAttachmentBytes: number;
  maxAvatarBytes: number;
  callsEnabled: boolean;
  turnConfigured: boolean;
}

type Phase = 'booting' | 'signed-out' | 'signed-in' | 'unsupported';

interface SessionState {
  phase: Phase;
  user: SelfUser | null;
  deviceId: string | null;
  config: ServerConfig | null;
  connection: ConnectionState;
  /** Set when the browser cannot support the security model at all. */
  blockingError: string | null;

  boot: () => Promise<void>;
  register: (input: {
    username: string;
    password: string;
    displayName: string;
  }) => Promise<void>;
  signIn: (input: { username: string; password: string }) => Promise<void>;
  signOut: () => Promise<void>;
  refreshUser: () => Promise<void>;
  applyAppearance: (appearance: Partial<AppearanceSettings>) => Promise<void>;
  setUser: (user: SelfUser) => void;
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

    try {
      const config = await api.get<ServerConfig>('/api/config');
      set({ config });
    } catch {
      // Not fatal — the sign-in screen can still render.
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

    set({ phase: 'signed-out', user: null, deviceId: null });
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
