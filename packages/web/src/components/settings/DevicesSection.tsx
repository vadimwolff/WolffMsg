/**
 * Devices and active sessions.
 *
 * Two different lists that are easy to conflate: a *device* holds encryption
 * keys, a *session* is a signed-in browser. Removing a device destroys its
 * keys; revoking a session just signs it out. The copy here says which is
 * which, because getting it wrong loses message history.
 */
import { useEffect, useState } from 'react';
import {
  deviceFingerprint,
  type DeviceSummary,
  type SessionSummary,
} from '@wolffmsg/shared';
import { api } from '../../lib/api.ts';
import { useUi } from '../../store/ui.ts';
import { Badge, Button, Skeleton } from '../primitives.tsx';
import { DeviceIcon, KeyIcon, LogOutIcon, TrashIcon } from '../icons.tsx';
import { formatFullDateTime } from '../../lib/format.ts';

export function DevicesSection() {
  const toast = useUi((s) => s.toast);

  const [devices, setDevices] = useState<DeviceSummary[]>([]);
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);

  async function refresh() {
    const [d, s] = await Promise.all([
      api.get<{ devices: DeviceSummary[] }>('/api/devices'),
      api.get<{ sessions: SessionSummary[] }>('/api/auth/sessions'),
    ]);
    setDevices(d.devices);
    setSessions(s.sessions);
  }

  useEffect(() => {
    refresh()
      .catch(() => undefined)
      .finally(() => setLoading(false));
  }, []);

  if (loading) {
    return (
      <div className="settings-section">
        <h3 className="settings-title">Devices</h3>
        <Skeleton height={80} radius={16} />
        <Skeleton height={80} radius={16} />
      </div>
    );
  }

  const otherSessions = sessions.filter((s) => !s.current);

  return (
    <div className="settings-section">
      <h3 className="settings-title">Devices</h3>

      <section className="settings-block">
        <h4 className="settings-subtitle">
          <KeyIcon size={15} /> Encryption devices
        </h4>
        <p className="settings-hint">
          Each holds its own key pair. Messages are encrypted separately for
          every one of them.
        </p>

        <div className="device-list">
          {devices.map((device) => (
            <div className="device-card" key={device.id}>
              <span className="device-icon">
                <DeviceIcon size={18} />
              </span>
              <div className="device-body">
                <div className="device-head">
                  <span className="device-name">{device.name}</span>
                  <span className="device-platform">{device.platform}</span>
                  {device.current ? <Badge tone="accent">This device</Badge> : null}
                </div>
                <p className="device-meta">
                  Added {formatFullDateTime(device.createdAt)}
                  {device.lastIpHint ? ` · ${device.lastIpHint}` : ''}
                </p>
                <p className="device-meta">
                  Last active {formatFullDateTime(device.lastActiveAt)} ·{' '}
                  {device.oneTimePreKeysRemaining} one-time keys available
                </p>
                <code className="fingerprint-value">
                  {deviceFingerprint(device.identityPublicKey)}
                </code>
              </div>
              {!device.current ? (
                <Button
                  size="sm"
                  variant="danger"
                  icon={<TrashIcon size={14} />}
                  loading={busy === device.id}
                  onClick={async () => {
                    setBusy(device.id);
                    try {
                      await api.delete(`/api/devices/${device.id}`);
                      await refresh();
                      toast('Device removed and its keys destroyed', 'success');
                    } catch {
                      toast('Could not remove that device', 'danger');
                    } finally {
                      setBusy(null);
                    }
                  }}
                >
                  Remove
                </Button>
              ) : null}
            </div>
          ))}
        </div>

        <p className="settings-hint">
          Removing a device deletes its published keys, signs it out, and stops
          new messages being encrypted to it. Messages already delivered there
          stay readable on that device until it is signed out.
        </p>
      </section>

      <section className="settings-block">
        <h4 className="settings-subtitle">Active sessions</h4>
        <p className="settings-hint">
          Where this account is signed in. Revoking a session takes effect
          immediately, including on any open socket.
        </p>

        <div className="device-list">
          {sessions.map((session) => (
            <div className="device-card" key={session.id}>
              <span className="device-icon">
                <DeviceIcon size={18} />
              </span>
              <div className="device-body">
                <div className="device-head">
                  <span className="device-name">{session.deviceName}</span>
                  <span className="device-platform">{session.platform}</span>
                  {session.current ? <Badge tone="accent">Current</Badge> : null}
                </div>
                <p className="device-meta">
                  Signed in {formatFullDateTime(session.createdAt)}
                  {session.ipHint ? ` · ${session.ipHint}` : ''}
                </p>
                <p className="device-meta">
                  Last seen {formatFullDateTime(session.lastActiveAt)}
                </p>
              </div>
              {!session.current ? (
                <Button
                  size="sm"
                  variant="danger"
                  icon={<LogOutIcon size={14} />}
                  loading={busy === session.id}
                  onClick={async () => {
                    setBusy(session.id);
                    try {
                      await api.delete(`/api/auth/sessions/${session.id}`);
                      await refresh();
                      toast('Session signed out', 'success');
                    } catch {
                      toast('Could not revoke that session', 'danger');
                    } finally {
                      setBusy(null);
                    }
                  }}
                >
                  Log out
                </Button>
              ) : null}
            </div>
          ))}
        </div>

        {otherSessions.length > 0 ? (
          <Button
            variant="danger"
            icon={<LogOutIcon size={16} />}
            loading={busy === 'all'}
            onClick={async () => {
              setBusy('all');
              try {
                const response = await api.post<{ revoked: number }>(
                  '/api/auth/sessions/revoke-others',
                );
                await refresh();
                toast(
                  `Signed out ${response.revoked} other session${
                    response.revoked === 1 ? '' : 's'
                  }`,
                  'success',
                );
              } catch {
                toast('Could not sign out the other sessions', 'danger');
              } finally {
                setBusy(null);
              }
            }}
          >
            Log out all other devices
          </Button>
        ) : null}
      </section>
    </div>
  );
}
