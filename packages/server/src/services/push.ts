import webpush from 'web-push';
import { prisma } from '../db.js';
import { env } from '../env.js';
import { logger } from '../logger.js';
import { badRequest } from '../errors.js';

/**
 * Web Push.
 *
 * The payload is deliberately content-free: a display name, the fact that
 * something arrived, and the chat id. Push goes through a third-party push
 * service, so putting message text in it would hand plaintext to exactly the
 * party end-to-end encryption exists to exclude. The service worker fetches
 * and decrypts locally before deciding what the notification actually says.
 */

let configured = false;

function ensureConfigured(): boolean {
  if (!env.pushEnabled) return false;
  if (!configured) {
    webpush.setVapidDetails(
      env.VAPID_SUBJECT,
      env.VAPID_PUBLIC_KEY,
      env.VAPID_PRIVATE_KEY,
    );
    configured = true;
  }
  return true;
}

export interface PushPayload {
  title: string;
  /** Never message content. */
  body: string;
  chatId: string;
  messageId: string | null;
  urgent?: boolean;
}

const MAX_FAILURES = 5;

export async function sendPushToUser(
  userId: string,
  payload: PushPayload,
): Promise<void> {
  if (!ensureConfigured()) return;

  const settings = await prisma.userSettings.findUnique({
    where: { userId },
    select: { notificationsEnabled: true, mutedUntil: true },
  });
  if (settings?.notificationsEnabled === false) return;
  if (settings?.mutedUntil && settings.mutedUntil.getTime() > Date.now()) return;

  const subscriptions = await prisma.pushSubscription.findMany({
    where: { userId, failureCount: { lt: MAX_FAILURES } },
  });
  if (subscriptions.length === 0) return;

  const body = JSON.stringify({
    title: payload.title,
    body: payload.body,
    chatId: payload.chatId,
    messageId: payload.messageId,
  });

  await Promise.all(
    subscriptions.map(async (sub) => {
      try {
        await webpush.sendNotification(
          {
            endpoint: sub.endpoint,
            keys: { p256dh: sub.p256dh, auth: sub.auth },
          },
          body,
          { TTL: payload.urgent ? 60 : 3_600, urgency: payload.urgent ? 'high' : 'normal' },
        );
        await prisma.pushSubscription.update({
          where: { id: sub.id },
          data: { lastUsedAt: new Date(), failureCount: 0 },
        });
      } catch (err) {
        const statusCode = (err as { statusCode?: number }).statusCode;
        // 404/410 mean the browser dropped the subscription for good.
        if (statusCode === 404 || statusCode === 410) {
          await prisma.pushSubscription
            .delete({ where: { id: sub.id } })
            .catch(() => undefined);
          return;
        }
        await prisma.pushSubscription
          .update({
            where: { id: sub.id },
            data: { failureCount: { increment: 1 } },
          })
          .catch(() => undefined);
        logger.warn({ statusCode }, 'web push delivery failed');
      }
    }),
  );
}

/** Basic shape and origin checks on a browser-supplied subscription. */
export async function savePushSubscription(
  userId: string,
  deviceId: string | null,
  subscription: { endpoint: string; keys: { p256dh: string; auth: string } },
): Promise<void> {
  const endpoint = subscription?.endpoint;
  if (typeof endpoint !== 'string' || endpoint.length > 1_000) {
    throw badRequest('Invalid push subscription');
  }

  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    throw badRequest('Invalid push subscription');
  }
  // Only https endpoints, and never a loopback/link-local address — this
  // endpoint is fetched by the server, so an unchecked URL would be an SSRF.
  if (url.protocol !== 'https:') {
    throw badRequest('Push endpoints must use HTTPS');
  }
  if (isPrivateHost(url.hostname)) {
    throw badRequest('That push endpoint is not reachable');
  }

  const { p256dh, auth } = subscription.keys ?? {};
  if (
    typeof p256dh !== 'string' ||
    typeof auth !== 'string' ||
    p256dh.length > 200 ||
    auth.length > 200
  ) {
    throw badRequest('Invalid push subscription');
  }

  await prisma.pushSubscription.upsert({
    where: { endpoint },
    create: { userId, deviceId, endpoint, p256dh, auth },
    update: { userId, deviceId, p256dh, auth, failureCount: 0 },
  });
}

/**
 * Reject hosts that resolve inside the deployment's own network. Together
 * with the https-only rule this keeps the push endpoint from being turned
 * into a server-side request forgery primitive.
 */
function isPrivateHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.internal')) {
    return true;
  }
  if (/^\[?::1\]?$/.test(host)) return true;
  if (/^\[?f[cd][0-9a-f]{2}:/i.test(host)) return true;
  if (/^\[?fe80:/i.test(host)) return true;

  const ipv4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!ipv4) return false;
  const [a, b] = [Number(ipv4[1]), Number(ipv4[2])];
  if (a === 10 || a === 127 || a === 0) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  return false;
}

export async function removePushSubscription(
  userId: string,
  endpoint: string,
): Promise<void> {
  await prisma.pushSubscription
    .deleteMany({ where: { userId, endpoint } })
    .catch(() => undefined);
}

export function vapidPublicKey(): string | null {
  return env.pushEnabled ? env.VAPID_PUBLIC_KEY : null;
}
