/**
 * Safety number verification.
 *
 * The number is derived from both parties' identity keys. If it matches on
 * both screens, no one is sitting in the middle. If it changed since you last
 * verified, that is exactly what this screen exists to tell you.
 */
import { useEffect, useState } from 'react';
import {
  deviceFingerprint,
  safetyNumber,
  type ContactRecord,
  type PublicUser,
} from '@wolffmsg/shared';
import { api } from '../lib/api.ts';
import { useSession } from '../store/session.ts';
import { useUi } from '../store/ui.ts';
import { currentSecrets } from '../crypto/session.ts';
import { Avatar } from './Avatar.tsx';
import { Badge, Button, Modal, Skeleton } from './primitives.tsx';
import { AlertIcon, ShieldCheckIcon, ShieldIcon } from './icons.tsx';

interface PeerDevice {
  deviceId: string;
  identityPublicKey: string;
  name: string;
}

export function SafetyNumberDialog({
  userId,
  onClose,
}: {
  userId: string;
  onClose: () => void;
}) {
  const self = useSession((s) => s.user);
  const toast = useUi((s) => s.toast);

  const [peer, setPeer] = useState<PublicUser | null>(null);
  const [devices, setDevices] = useState<PeerDevice[]>([]);
  const [contact, setContact] = useState<ContactRecord | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;

    (async () => {
      try {
        const [userResponse, identityResponse, contactsResponse] = await Promise.all([
          api.get<{ user: PublicUser }>(`/api/users/${encodeURIComponent(userId)}`),
          api.get<{ devices: PeerDevice[] }>(
            `/api/users/${encodeURIComponent(userId)}/identity`,
          ),
          api.get<{ contacts: ContactRecord[] }>('/api/contacts'),
        ]);
        if (cancelled) return;
        setPeer(userResponse.user);
        setDevices(identityResponse.devices);
        setContact(
          contactsResponse.contacts.find((c) => c.user.id === userId) ?? null,
        );
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [userId]);

  const mine = currentSecrets();
  const primaryPeerKey = devices[0]?.identityPublicKey ?? null;

  const number =
    mine && self && primaryPeerKey
      ? safetyNumber(
          { userId: self.id, identityPublicKey: mine.identityPublicKey },
          { userId, identityPublicKey: primaryPeerKey },
        )
      : null;

  const verified = Boolean(contact?.verifiedAt) && !contact?.identityChangedAt;
  const changed = Boolean(contact?.identityChangedAt);

  async function setVerified(next: boolean) {
    if (!primaryPeerKey) return;
    setBusy(true);
    try {
      if (next) {
        // Adding to contacts first, because verification is recorded against
        // the contact row.
        await api.post('/api/contacts', { userId, alias: null }).catch(() => undefined);
        await api.post(`/api/contacts/${encodeURIComponent(userId)}/verify`, {
          identityPublicKey: primaryPeerKey,
        });
        toast('Marked as verified', 'success');
      } else {
        await api.delete(`/api/contacts/${encodeURIComponent(userId)}/verify`);
        toast('Verification cleared');
      }
      const refreshed = await api.get<{ contacts: ContactRecord[] }>('/api/contacts');
      setContact(refreshed.contacts.find((c) => c.user.id === userId) ?? null);
    } catch {
      toast('Could not update verification', 'danger');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      open
      onClose={onClose}
      title="Safety number"
      description="Compare these digits with the other person, in a channel you already trust."
      footer={
        <>
          <Button onClick={onClose}>Close</Button>
          {verified ? (
            <Button variant="danger" loading={busy} onClick={() => void setVerified(false)}>
              Clear verification
            </Button>
          ) : (
            <Button
              variant="primary"
              loading={busy}
              disabled={!primaryPeerKey}
              onClick={() => void setVerified(true)}
            >
              Mark as verified
            </Button>
          )}
        </>
      }
    >
      {loading ? (
        <div className="stack">
          <Skeleton height={80} radius={16} />
          <Skeleton height={120} radius={16} />
        </div>
      ) : (
        <div className="stack">
          {changed ? (
            <div className="notice" data-tone="danger" role="alert">
              <AlertIcon size={18} />
              <div>
                <strong>This person’s safety number has changed.</strong>
                <p>
                  That happens when they reinstall or add a device — but it is also
                  what an interception attempt looks like. Verify again before
                  sending anything sensitive.
                </p>
              </div>
            </div>
          ) : null}

          <div className="verify-parties">
            <div className="verify-party">
              <Avatar
                userId={self?.id ?? ''}
                name={self?.displayName ?? 'You'}
                url={self?.avatarUrl ?? null}
                size={44}
                shape="circle"
              />
              <span>You</span>
            </div>
            <div className="verify-link" aria-hidden="true">
              {verified ? <ShieldCheckIcon size={20} /> : <ShieldIcon size={20} />}
            </div>
            <div className="verify-party">
              <Avatar
                userId={userId}
                name={peer?.displayName ?? 'Them'}
                url={peer?.avatarUrl ?? null}
                size={44}
                shape="circle"
              />
              <span>{peer?.displayName ?? 'Them'}</span>
            </div>
          </div>

          <div className="verify-status">
            {verified ? (
              <Badge tone="positive">✓ Verified</Badge>
            ) : (
              <Badge tone="warning">⚠ Unverified</Badge>
            )}
          </div>

          {number ? (
            <div className="safety-number" aria-label="Safety number">
              {number.split(' ').map((group, index) => (
                <span className="safety-group" key={index}>
                  {group}
                </span>
              ))}
            </div>
          ) : (
            <p className="dialog-hint">
              This person has no device that can receive encrypted messages yet.
            </p>
          )}

          <details className="details">
            <summary>Device fingerprints</summary>
            <ul className="fingerprint-list">
              {devices.map((device) => (
                <li key={device.deviceId}>
                  <span className="fingerprint-name">{device.name}</span>
                  <code className="fingerprint-value">
                    {deviceFingerprint(device.identityPublicKey)}
                  </code>
                </li>
              ))}
            </ul>
          </details>

          <p className="dialog-note">
            Marking this verified records the key you compared. If it ever changes,
            WolffMsg will say so rather than quietly accepting the new one.
          </p>
        </div>
      )}
    </Modal>
  );
}
