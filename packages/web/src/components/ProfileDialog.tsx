/** Another person's profile, with the actions you can take about them. */
import { useEffect, useState } from 'react';
import type { ContactRecord, PublicUser } from '@wolffmsg/shared';
import { api, ApiError } from '../lib/api.ts';
import { useChats } from '../store/chats.ts';
import { useUi } from '../store/ui.ts';
import { Avatar } from './Avatar.tsx';
import { Badge, Button, Modal, Skeleton } from './primitives.tsx';
import { BlockIcon, PlusIcon, SendIcon, ShieldCheckIcon, TrashIcon } from './icons.tsx';
import { formatLastSeen } from '../lib/format.ts';

export function ProfileDialog({
  userId,
  onClose,
}: {
  userId: string;
  onClose: () => void;
}) {
  const [user, setUser] = useState<PublicUser | null>(null);
  const [contact, setContact] = useState<ContactRecord | null>(null);
  const [blocked, setBlocked] = useState(false);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);

  const openChat = useChats((s) => s.openChat);
  const loadChats = useChats((s) => s.loadChats);
  const openOverlay = useUi((s) => s.openOverlay);
  const toast = useUi((s) => s.toast);

  const refresh = async () => {
    const [userResponse, contactsResponse, blockedResponse] = await Promise.all([
      api.get<{ user: PublicUser }>(`/api/users/${encodeURIComponent(userId)}`),
      api.get<{ contacts: ContactRecord[] }>('/api/contacts'),
      api.get<{ blocked: { user: PublicUser }[] }>('/api/blocked'),
    ]);
    setUser(userResponse.user);
    setContact(contactsResponse.contacts.find((c) => c.user.id === userId) ?? null);
    setBlocked(blockedResponse.blocked.some((b) => b.user.id === userId));
  };

  useEffect(() => {
    let cancelled = false;
    refresh()
      .catch(() => undefined)
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [userId]);

  async function act(work: () => Promise<void>, success?: string) {
    setBusy(true);
    try {
      await work();
      await refresh();
      if (success) toast(success, 'success');
    } catch (err) {
      toast(err instanceof ApiError ? err.message : 'That did not work', 'danger');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal open onClose={onClose} title={user?.displayName ?? 'Profile'} size="sm">
      {loading || !user ? (
        <div className="stack">
          <Skeleton height={96} radius={16} />
          <Skeleton height={40} radius={12} />
        </div>
      ) : (
        <div className="stack profile-body">
          <div className="profile-head">
            <Avatar
              userId={user.id}
              name={user.displayName}
              url={user.avatarUrl}
              size={84}
              shape="circle"
              online={user.online}
            />
            <h3 className="profile-name">{user.displayName}</h3>
            <p className="profile-username">@{user.username}</p>
            {user.online !== null ? (
              <p className="profile-presence">
                {formatLastSeen(user.online, user.lastSeenAt)}
              </p>
            ) : null}
            <div className="profile-badges">
              {contact?.verifiedAt && !contact.identityChangedAt ? (
                <Badge tone="positive">✓ Verified</Badge>
              ) : (
                <Badge tone="warning">⚠ Unverified</Badge>
              )}
              {contact ? <Badge tone="accent">Contact</Badge> : null}
              {blocked ? <Badge tone="danger">Blocked</Badge> : null}
            </div>
          </div>

          {user.bio ? <p className="profile-bio">{user.bio}</p> : null}

          <div className="profile-actions">
            <Button
              variant="primary"
              icon={<SendIcon size={16} />}
              disabled={blocked || busy}
              onClick={() =>
                void act(async () => {
                  const response = await api.post<{ chat: { id: string } }>(
                    '/api/chats/direct',
                    { userId },
                  );
                  await loadChats();
                  await openChat(response.chat.id);
                  onClose();
                })
              }
            >
              Message
            </Button>

            <Button
              icon={<ShieldCheckIcon size={16} />}
              onClick={() => openOverlay({ kind: 'safety-number', userId })}
            >
              Safety number
            </Button>

            {contact ? (
              <Button
                icon={<TrashIcon size={16} />}
                disabled={busy}
                onClick={() =>
                  void act(
                    () => api.delete(`/api/contacts/${encodeURIComponent(userId)}`),
                    'Removed from contacts',
                  )
                }
              >
                Remove contact
              </Button>
            ) : (
              <Button
                icon={<PlusIcon size={16} />}
                disabled={busy || blocked}
                onClick={() =>
                  void act(
                    () => api.post('/api/contacts', { userId, alias: null }),
                    'Added to contacts',
                  )
                }
              >
                Add contact
              </Button>
            )}

            <Button
              variant={blocked ? 'secondary' : 'danger'}
              icon={<BlockIcon size={16} />}
              disabled={busy}
              onClick={() =>
                void act(
                  () =>
                    blocked
                      ? api.delete(`/api/blocked/${encodeURIComponent(userId)}`)
                      : api.post('/api/blocked', { userId }),
                  blocked ? 'Unblocked' : 'Blocked',
                )
              }
            >
              {blocked ? 'Unblock' : 'Block'}
            </Button>
          </div>

          {blocked ? (
            <p className="dialog-note">
              While blocked, neither of you can message the other, and they cannot
              see your presence.
            </p>
          ) : null}
        </div>
      )}
    </Modal>
  );
}
