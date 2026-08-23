import { useState } from 'react';
import type { PrivacyAudience, PublicUser } from '@wolffmsg/shared';
import { api } from '../../lib/api.ts';
import { useSession } from '../../store/session.ts';
import { useUi } from '../../store/ui.ts';
import { Avatar } from '../Avatar.tsx';
import { Button, Segmented, Toggle } from '../primitives.tsx';
import { BlockIcon } from '../icons.tsx';
import { useEffect } from 'react';
import { onAsync } from '../../lib/async.ts';

const AUDIENCE_OPTIONS: { value: PrivacyAudience; label: string }[] = [
  { value: 'everyone', label: 'Everyone' },
  { value: 'contacts', label: 'Contacts' },
  { value: 'nobody', label: 'Nobody' },
];

export function PrivacySection() {
  const user = useSession((s) => s.user);
  const setUser = useSession((s) => s.setUser);
  const toast = useUi((s) => s.toast);

  const [blocked, setBlocked] = useState<{ user: PublicUser }[]>([]);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    void api
      .get<{ blocked: { user: PublicUser }[] }>('/api/blocked')
      .then((response) => setBlocked(response.blocked))
      .catch(() => undefined);
  }, []);

  async function update(patch: Record<string, unknown>) {
    if (!user) return;
    setSaving(true);
    // Optimistic, so a toggle responds instantly; reverted if the call fails.
    const previous = user;
    setUser({ ...user, privacy: { ...user.privacy, ...patch } });
    try {
      const response = await api.patch<{ user: typeof user }>('/api/me/privacy', patch);
      if (response.user) setUser(response.user);
    } catch {
      setUser(previous);
      toast('Could not save that setting', 'danger');
    } finally {
      setSaving(false);
    }
  }

  if (!user) return null;
  const privacy = user.privacy;

  return (
    <div className="settings-section">
      <h3 className="settings-title">Privacy</h3>
      <p className="settings-hint">
        Every one of these is enforced on the server, not just hidden in the
        interface.
      </p>

      <section className="settings-block">
        <h4 className="settings-subtitle">Who can see</h4>

        <div className="audience-row">
          <div>
            <span className="audience-label">Last seen and online status</span>
            <p className="audience-hint">
              Only ever shown to people you already share a conversation with.
            </p>
          </div>
          <Segmented
            label="Last seen visibility"
            value={privacy.lastSeenVisibility}
            options={AUDIENCE_OPTIONS}
            onChange={(value) => void update({ lastSeenVisibility: value })}
          />
        </div>

        <div className="audience-row">
          <div>
            <span className="audience-label">Profile picture</span>
          </div>
          <Segmented
            label="Avatar visibility"
            value={privacy.avatarVisibility}
            options={AUDIENCE_OPTIONS}
            onChange={(value) => void update({ avatarVisibility: value })}
          />
        </div>

        <div className="audience-row">
          <div>
            <span className="audience-label">Bio</span>
          </div>
          <Segmented
            label="Bio visibility"
            value={privacy.bioVisibility}
            options={AUDIENCE_OPTIONS}
            onChange={(value) => void update({ bioVisibility: value })}
          />
        </div>
      </section>

      <section className="settings-block">
        <h4 className="settings-subtitle">Who can reach you</h4>

        <div className="audience-row">
          <div>
            <span className="audience-label">Send you messages</span>
            <p className="audience-hint">
              People already in a conversation with you can always continue it.
            </p>
          </div>
          <Segmented
            label="Who can message you"
            value={privacy.whoCanMessage}
            options={AUDIENCE_OPTIONS}
            onChange={(value) => void update({ whoCanMessage: value })}
          />
        </div>

        <div className="audience-row">
          <div>
            <span className="audience-label">Add you to groups</span>
          </div>
          <Segmented
            label="Who can add you to groups"
            value={privacy.whoCanAddToGroups}
            options={AUDIENCE_OPTIONS}
            onChange={(value) => void update({ whoCanAddToGroups: value })}
          />
        </div>
      </section>

      <section className="settings-block">
        <h4 className="settings-subtitle">What you share back</h4>
        <Toggle
          label="Read receipts"
          description="When off, others are not told that you read their messages — and you stop seeing theirs."
          checked={privacy.readReceipts}
          disabled={saving}
          onChange={(next) => void update({ readReceipts: next })}
        />
        <Toggle
          label="Typing indicators"
          description="When off, no one sees that you are typing."
          checked={privacy.typingIndicators}
          disabled={saving}
          onChange={(next) => void update({ typingIndicators: next })}
        />
      </section>

      <section className="settings-block">
        <h4 className="settings-subtitle">Blocked people</h4>
        {blocked.length === 0 ? (
          <p className="settings-hint">You have not blocked anyone.</p>
        ) : (
          <div className="people-list">
            {blocked.map((entry) => (
              <div className="people-row" key={entry.user.id}>
                <Avatar
                  userId={entry.user.id}
                  name={entry.user.displayName}
                  url={entry.user.avatarUrl}
                  size={34}
                  shape="circle"
                />
                <span className="people-row-text">
                  <span className="people-row-name">{entry.user.displayName}</span>
                  <span className="people-row-username">@{entry.user.username}</span>
                </span>
                <Button
                  size="sm"
                  icon={<BlockIcon size={14} />}
                  onClick={onAsync(async () => {
                    await api.delete(`/api/blocked/${entry.user.id}`);
                    setBlocked((prev) => prev.filter((b) => b.user.id !== entry.user.id));
                    toast('Unblocked', 'success');
                  })}
                >
                  Unblock
                </Button>
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
