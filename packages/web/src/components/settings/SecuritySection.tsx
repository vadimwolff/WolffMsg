/**
 * The Security Center.
 *
 * The honest answer to "how protected am I, right now" — assembled from real
 * state rather than reassuring copy: this device's actual fingerprint, how
 * many one-time keys remain, which contacts are verified, and the audit trail.
 */
import { useEffect, useState } from 'react';
import {
  deviceFingerprint,
  type ContactRecord,
  type DeviceSummary,
  type SecurityEventRecord,
  type SessionSummary,
} from '@wolffmsg/shared';
import { api } from '../../lib/api.ts';
import { useSession } from '../../store/session.ts';
import { useUi } from '../../store/ui.ts';
import { currentSecrets, ensurePreKeySupply } from '../../crypto/session.ts';
import { verifyKeyIsNonExtractable } from '../../crypto/keyVault.ts';
import { Avatar } from '../Avatar.tsx';
import { Badge, Button, Skeleton } from '../primitives.tsx';
import {
  AlertIcon,
  CheckIcon,
  DeviceIcon,
  KeyIcon,
  LockIcon,
  ShieldCheckIcon,
  ShieldIcon,
} from '../icons.tsx';
import { formatFullDateTime } from '../../lib/format.ts';

export function SecuritySection() {
  const deviceId = useSession((s) => s.deviceId);
  const openOverlay = useUi((s) => s.openOverlay);
  const toast = useUi((s) => s.toast);

  const [devices, setDevices] = useState<DeviceSummary[]>([]);
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [contacts, setContacts] = useState<ContactRecord[]>([]);
  const [events, setEvents] = useState<SecurityEventRecord[]>([]);
  const [keyStatus, setKeyStatus] = useState<{ remaining: number } | null>(null);
  const [vaultSafe, setVaultSafe] = useState<boolean | null>(null);
  const [loading, setLoading] = useState(true);
  const [toppingUp, setToppingUp] = useState(false);

  async function refresh() {
    const [d, s, c, e, k] = await Promise.all([
      api.get<{ devices: DeviceSummary[] }>('/api/devices'),
      api.get<{ sessions: SessionSummary[] }>('/api/auth/sessions'),
      api.get<{ contacts: ContactRecord[] }>('/api/contacts'),
      api.get<{ events: SecurityEventRecord[] }>('/api/me/security-events'),
      api.get<{ remaining: number }>('/api/keys/status'),
    ]);
    setDevices(d.devices);
    setSessions(s.sessions);
    setContacts(c.contacts);
    setEvents(e.events);
    setKeyStatus(k);
  }

  useEffect(() => {
    let cancelled = false;
    void verifyKeyIsNonExtractable().then((safe) => {
      if (!cancelled) setVaultSafe(safe);
    });
    refresh()
      .catch(() => undefined)
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const secrets = currentSecrets();
  const thisDevice = devices.find((d) => d.id === deviceId);
  const verifiedContacts = contacts.filter(
    (c) => c.verifiedAt && !c.identityChangedAt,
  ).length;
  const changedContacts = contacts.filter((c) => c.identityChangedAt);
  const lowOnKeys = (keyStatus?.remaining ?? 0) < 25;

  if (loading) {
    return (
      <div className="settings-section">
        <h3 className="settings-title">Security</h3>
        <Skeleton height={120} radius={16} />
        <Skeleton height={90} radius={16} />
      </div>
    );
  }

  return (
    <div className="settings-section">
      <div className="security-hero">
        <ShieldCheckIcon size={28} />
        <div>
          <h3 className="settings-title" style={{ margin: 0 }}>
            Security Center
          </h3>
          <p className="settings-hint" style={{ margin: 0 }}>
            What is protecting this account, as it stands right now.
          </p>
        </div>
      </div>

      <div className="security-grid">
        <StatCard
          icon={<LockIcon size={18} />}
          label="End-to-end encryption"
          value="Active"
          tone="positive"
          detail="XChaCha20-Poly1305 with X25519 sealed keys"
        />
        <StatCard
          icon={<DeviceIcon size={18} />}
          label="Devices"
          value={`${devices.length}`}
          detail={devices.length === 1 ? 'Only this one' : 'Review them below'}
        />
        <StatCard
          icon={<ShieldIcon size={18} />}
          label="Active sessions"
          value={`${sessions.length}`}
          detail="Signed in right now"
        />
        <StatCard
          icon={<KeyIcon size={18} />}
          label="One-time keys"
          value={`${keyStatus?.remaining ?? 0}`}
          tone={lowOnKeys ? 'warning' : 'positive'}
          detail={
            lowOnKeys
              ? 'Running low — top up to keep forward secrecy'
              : 'Each one is used once, then destroyed'
          }
        />
      </div>

      {changedContacts.length > 0 ? (
        <div className="notice" data-tone="danger" role="alert">
          <AlertIcon size={18} />
          <div>
            <strong>
              {changedContacts.length} contact
              {changedContacts.length === 1 ? '’s' : 's’'} safety number changed
            </strong>
            <p>
              This happens on a reinstall — and it is also what interception looks
              like. Verify before sending anything sensitive.
            </p>
            <div className="chip-row" style={{ marginTop: 8 }}>
              {changedContacts.map((contact) => (
                <button
                  key={contact.user.id}
                  type="button"
                  className="chip"
                  onClick={() =>
                    openOverlay({ kind: 'safety-number', userId: contact.user.id })
                  }
                >
                  <Avatar
                    userId={contact.user.id}
                    name={contact.user.displayName}
                    url={contact.user.avatarUrl}
                    size={18}
                    shape="circle"
                  />
                  {contact.user.displayName}
                </button>
              ))}
            </div>
          </div>
        </div>
      ) : null}

      {vaultSafe === false ? (
        <div className="notice" data-tone="warning">
          <AlertIcon size={18} />
          <div>
            <strong>This browser allowed the vault key to be exported.</strong>
            <p>
              WolffMsg stores your private keys wrapped by a key the browser is
              supposed to refuse to hand back. Here it did not, which weakens the
              protection against a script running on this page.
            </p>
          </div>
        </div>
      ) : null}

      {lowOnKeys ? (
        <div className="notice" data-tone="warning">
          <KeyIcon size={18} />
          <div>
            <strong>One-time keys are running low</strong>
            <p>
              When they run out, new messages fall back to a longer-lived key and
              lose per-message forward secrecy until more are published.
            </p>
            <Button
              size="sm"
              loading={toppingUp}
              style={{ marginTop: 8 }}
              onClick={async () => {
                setToppingUp(true);
                try {
                  await ensurePreKeySupply();
                  await refresh();
                  toast('Published a fresh batch of keys', 'success');
                } finally {
                  setToppingUp(false);
                }
              }}
            >
              Publish more keys
            </Button>
          </div>
        </div>
      ) : null}

      <section className="settings-block">
        <h4 className="settings-subtitle">This device</h4>
        {secrets && thisDevice ? (
          <div className="fingerprint-card">
            <div className="fingerprint-head">
              <DeviceIcon size={16} />
              <span>
                {thisDevice.name} · {thisDevice.platform}
              </span>
              <Badge tone="accent">This device</Badge>
            </div>
            <p className="settings-hint">
              Its identity fingerprint. Anyone comparing safety numbers with you is
              ultimately comparing this.
            </p>
            <code className="fingerprint-value">
              {deviceFingerprint(secrets.identityPublicKey)}
            </code>
            <p className="settings-hint">
              Private keys are stored in this browser, sealed under a key the
              browser will not let any script read. They are never sent anywhere.
            </p>
          </div>
        ) : (
          <p className="settings-hint">
            This session has no encryption identity. Sign out and back in to create
            one.
          </p>
        )}
      </section>

      <section className="settings-block">
        <h4 className="settings-subtitle">Verification</h4>
        <p className="settings-hint">
          {verifiedContacts} of {contacts.length} contact
          {contacts.length === 1 ? '' : 's'} verified.
        </p>
        <div className="verify-list">
          {contacts.length === 0 ? (
            <p className="settings-hint">
              You have no contacts yet. Verification is per person and happens from
              their profile.
            </p>
          ) : (
            contacts.map((contact) => (
              <button
                key={contact.user.id}
                type="button"
                className="people-row"
                onClick={() =>
                  openOverlay({ kind: 'safety-number', userId: contact.user.id })
                }
              >
                <Avatar
                  userId={contact.user.id}
                  name={contact.user.displayName}
                  url={contact.user.avatarUrl}
                  size={34}
                  shape="circle"
                />
                <span className="people-row-text">
                  <span className="people-row-name">{contact.user.displayName}</span>
                  <span className="people-row-username">@{contact.user.username}</span>
                </span>
                {contact.identityChangedAt ? (
                  <Badge tone="danger">Key changed</Badge>
                ) : contact.verifiedAt ? (
                  <Badge tone="positive">
                    <CheckIcon size={11} /> Verified
                  </Badge>
                ) : (
                  <Badge tone="warning">Unverified</Badge>
                )}
              </button>
            ))
          )}
        </div>
      </section>

      <section className="settings-block">
        <h4 className="settings-subtitle">Security events</h4>
        <p className="settings-hint">
          Recorded by the server. Contains no message content and no keys.
        </p>
        <ul className="event-list">
          {events.length === 0 ? (
            <li className="settings-hint">Nothing recorded yet.</li>
          ) : (
            events.map((event) => (
              <li key={event.id} className="event-row">
                <span className="event-dot" data-kind={event.kind} />
                <span className="event-body">
                  <span className="event-detail">{event.detail}</span>
                  <span className="event-meta">
                    {formatFullDateTime(event.createdAt)}
                    {event.ipHint ? ` · ${event.ipHint}` : ''}
                  </span>
                </span>
              </li>
            ))
          )}
        </ul>
      </section>
    </div>
  );
}

function StatCard({
  icon,
  label,
  value,
  detail,
  tone = 'neutral',
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
  detail?: string;
  tone?: 'neutral' | 'positive' | 'warning';
}) {
  return (
    <div className="stat-card" data-tone={tone}>
      <span className="stat-icon">{icon}</span>
      <span className="stat-value">{value}</span>
      <span className="stat-label">{label}</span>
      {detail ? <span className="stat-detail">{detail}</span> : null}
    </div>
  );
}
