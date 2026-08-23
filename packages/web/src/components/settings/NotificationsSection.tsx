/**
 * Notification settings, including Web Push registration.
 *
 * The preview toggle is the interesting one: because the server cannot read
 * messages, the push payload it sends carries no content at all. A preview is
 * assembled by the service worker after it decrypts locally — so turning it on
 * changes what *this device* renders, not what the push service receives.
 */
import { useEffect, useState } from 'react';
import { api } from '../../lib/api.ts';
import { useSession } from '../../store/session.ts';
import { useUi } from '../../store/ui.ts';
import { Button, Toggle } from '../primitives.tsx';
import { BellIcon, LockIcon } from '../icons.tsx';

export function NotificationsSection() {
  const user = useSession((s) => s.user);
  const setUser = useSession((s) => s.setUser);
  const config = useSession((s) => s.config);
  const toast = useUi((s) => s.toast);

  const [permission, setPermission] = useState<NotificationPermission>('default');
  const [subscribed, setSubscribed] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (typeof Notification !== 'undefined') setPermission(Notification.permission);
    void navigator.serviceWorker?.ready
      .then((registration) => registration.pushManager.getSubscription())
      .then((subscription) => setSubscribed(Boolean(subscription)))
      .catch(() => undefined);
  }, []);

  async function update(patch: Record<string, unknown>) {
    if (!user) return;
    try {
      const response = await api.patch<{ user: typeof user }>(
        '/api/me/notifications',
        patch,
      );
      if (response.user) setUser(response.user);
    } catch {
      toast('Could not save that setting', 'danger');
    }
  }

  async function enablePush() {
    if (!config?.vapidPublicKey) {
      toast('Push is not configured on this server', 'warning');
      return;
    }

    setBusy(true);
    try {
      const result = await Notification.requestPermission();
      setPermission(result);
      if (result !== 'granted') {
        toast('Notification permission was declined', 'warning');
        return;
      }

      const registration = await navigator.serviceWorker.ready;
      const subscription = await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(config.vapidPublicKey),
      });

      const json = subscription.toJSON() as {
        endpoint: string;
        keys: { p256dh: string; auth: string };
      };
      await api.post('/api/push/subscribe', {
        endpoint: json.endpoint,
        keys: json.keys,
      });
      setSubscribed(true);
      toast('Push notifications enabled', 'success');
    } catch {
      toast('Could not enable push notifications', 'danger');
    } finally {
      setBusy(false);
    }
  }

  async function disablePush() {
    setBusy(true);
    try {
      const registration = await navigator.serviceWorker.ready;
      const subscription = await registration.pushManager.getSubscription();
      if (subscription) {
        await api.post('/api/push/unsubscribe', { endpoint: subscription.endpoint });
        await subscription.unsubscribe();
      }
      setSubscribed(false);
      toast('Push notifications disabled');
    } catch {
      toast('Could not disable push notifications', 'danger');
    } finally {
      setBusy(false);
    }
  }

  if (!user) return null;
  const settings = user.notifications;

  return (
    <div className="settings-section">
      <h3 className="settings-title">Notifications</h3>

      <section className="settings-block">
        <Toggle
          label="Notifications"
          description="Turning this off silences everything, including calls."
          checked={settings.enabled}
          onChange={(next) => void update({ enabled: next })}
        />
        <Toggle
          label="Show message previews"
          description="Renders the decrypted text in the notification on this device."
          checked={settings.showPreview}
          disabled={!settings.enabled}
          onChange={(next) => void update({ showPreview: next })}
        />
        <Toggle
          label="Sound"
          checked={settings.sound}
          disabled={!settings.enabled}
          onChange={(next) => void update({ sound: next })}
        />
      </section>

      <section className="settings-block">
        <h4 className="settings-subtitle">Push notifications</h4>
        {!config?.pushEnabled ? (
          <p className="settings-hint">
            This server has no push keys configured, so push is unavailable. In-app
            notifications still work while WolffMsg is open.
          </p>
        ) : (
          <>
            <div className="notice" data-tone="accent">
              <LockIcon size={16} />
              <div>
                <strong>Push carries no message content</strong>
                <p>
                  The server cannot read your messages, so it sends only “someone
                  sent you something”. Any preview you see is assembled on this
                  device after decrypting locally.
                </p>
              </div>
            </div>

            {subscribed ? (
              <Button variant="danger" loading={busy} onClick={() => void disablePush()}>
                Disable push on this device
              </Button>
            ) : (
              <Button
                variant="primary"
                icon={<BellIcon size={16} />}
                loading={busy}
                disabled={permission === 'denied'}
                onClick={() => void enablePush()}
              >
                Enable push on this device
              </Button>
            )}

            {permission === 'denied' ? (
              <p className="settings-hint">
                Notifications are blocked for this site in your browser settings.
              </p>
            ) : null}
          </>
        )}
      </section>
    </div>
  );
}

/** VAPID keys are base64url; `PushManager` wants raw bytes. */
function urlBase64ToUint8Array(base64: string): Uint8Array<ArrayBuffer> {
  const padding = '='.repeat((4 - (base64.length % 4)) % 4);
  const normalised = (base64 + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(normalised);
  const output = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i += 1) output[i] = raw.charCodeAt(i);
  return output;
}
