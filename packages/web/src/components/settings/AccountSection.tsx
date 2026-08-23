import { useRef, useState } from 'react';
import { LIMITS, validateDisplayName, validatePassword } from '@wolffmsg/shared';
import { api, ApiError } from '../../lib/api.ts';
import { useSession } from '../../store/session.ts';
import { useUi } from '../../store/ui.ts';
import { Avatar } from '../Avatar.tsx';
import { Button, Field, TextArea } from '../primitives.tsx';
import { LogOutIcon, TrashIcon, UserIcon } from '../icons.tsx';

export function AccountSection() {
  const user = useSession((s) => s.user);
  const setUser = useSession((s) => s.setUser);
  const signOut = useSession((s) => s.signOut);
  const config = useSession((s) => s.config);
  const toast = useUi((s) => s.toast);

  const [displayName, setDisplayName] = useState(user?.displayName ?? '');
  const [bio, setBio] = useState(user?.bio ?? '');
  const [profileError, setProfileError] = useState<string | null>(null);
  const [savingProfile, setSavingProfile] = useState(false);
  const [uploading, setUploading] = useState(false);

  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [passwordErrors, setPasswordErrors] = useState<Record<string, string>>({});
  const [changingPassword, setChangingPassword] = useState(false);

  const fileRef = useRef<HTMLInputElement>(null);

  async function saveProfile() {
    const problem = validateDisplayName(displayName);
    if (problem) {
      setProfileError(problem.message);
      return;
    }

    setSavingProfile(true);
    setProfileError(null);
    try {
      const response = await api.patch<{ user: typeof user }>('/api/me/profile', {
        displayName: displayName.trim(),
        bio: bio.trim() || null,
      });
      if (response.user) setUser(response.user);
      toast('Profile saved', 'success');
    } catch (err) {
      setProfileError(err instanceof ApiError ? err.message : 'Could not save that');
    } finally {
      setSavingProfile(false);
    }
  }

  async function uploadAvatar(file: File) {
    const limit = config?.maxAvatarBytes ?? 4 * 1024 * 1024;
    if (file.size > limit) {
      toast('That image is too large', 'warning');
      return;
    }

    setUploading(true);
    try {
      const handle = api.upload<{ user: typeof user }>('/api/me/avatar', file, {
        filename: 'avatar',
      });
      const response = await handle.promise;
      if (response.user) setUser(response.user);
      toast('Picture updated', 'success');
    } catch (err) {
      toast(err instanceof ApiError ? err.message : 'Could not upload that', 'danger');
    } finally {
      setUploading(false);
    }
  }

  async function changePassword() {
    const errors: Record<string, string> = {};
    const problem = validatePassword(newPassword);
    if (problem) errors.newPassword = problem.message;
    if (newPassword !== confirmPassword) {
      errors.confirmPassword = 'Those do not match';
    }
    if (!currentPassword) errors.currentPassword = 'Required';

    setPasswordErrors(errors);
    if (Object.keys(errors).length > 0) return;

    setChangingPassword(true);
    try {
      await api.post('/api/auth/password', {
        currentPassword,
        newPassword,
        revokeOtherSessions: true,
      });
      setCurrentPassword('');
      setNewPassword('');
      setConfirmPassword('');
      toast('Password changed. Other devices were signed out.', 'success');
    } catch (err) {
      if (err instanceof ApiError) {
        setPasswordErrors(err.fields ?? { currentPassword: err.message });
      } else {
        setPasswordErrors({ currentPassword: 'Could not change your password' });
      }
    } finally {
      setChangingPassword(false);
    }
  }

  if (!user) return null;

  return (
    <div className="settings-section">
      <h3 className="settings-title">Account</h3>

      <section className="settings-block">
        <div className="avatar-editor">
          <Avatar
            userId={user.id}
            name={user.displayName}
            url={user.avatarUrl}
            size={88}
            shape="circle"
          />
          <div className="avatar-editor-actions">
            <Button
              icon={<UserIcon size={16} />}
              loading={uploading}
              onClick={() => fileRef.current?.click()}
            >
              Change picture
            </Button>
            {user.avatarUrl ? (
              <Button
                variant="ghost"
                icon={<TrashIcon size={16} />}
                onClick={async () => {
                  const response = await api.delete<{ user: typeof user }>(
                    '/api/me/avatar',
                  );
                  if (response.user) setUser(response.user);
                }}
              >
                Remove
              </Button>
            ) : null}
            <p className="settings-hint">JPEG, PNG or WebP, up to 4 MB.</p>
          </div>
          <input
            ref={fileRef}
            type="file"
            accept="image/jpeg,image/png,image/webp"
            className="sr-only"
            onChange={(event) => {
              const file = event.target.files?.[0];
              if (file) void uploadAvatar(file);
              event.target.value = '';
            }}
          />
        </div>
      </section>

      <section className="settings-block">
        <Field
          label="Username"
          value={user.username}
          readOnly
          disabled
          hint="Usernames cannot be changed. This is how people find you."
        />
        <Field
          label="Display name"
          value={displayName}
          maxLength={LIMITS.displayNameMax}
          onChange={(event) => setDisplayName(event.target.value)}
          error={profileError}
        />
        <TextArea
          label="Bio"
          value={bio}
          maxLength={LIMITS.bioMax}
          onChange={(event) => setBio(event.target.value)}
          hint={`${bio.length} / ${LIMITS.bioMax}`}
        />
        <div className="row-end">
          <Button variant="primary" loading={savingProfile} onClick={() => void saveProfile()}>
            Save changes
          </Button>
        </div>
      </section>

      <section className="settings-block">
        <h4 className="settings-subtitle">Change password</h4>
        <p className="settings-hint">
          Changing your password signs out every other device. Your message
          history stays readable on this one.
        </p>
        <Field
          label="Current password"
          type="password"
          autoComplete="current-password"
          value={currentPassword}
          onChange={(event) => setCurrentPassword(event.target.value)}
          error={passwordErrors.currentPassword ?? null}
        />
        <Field
          label="New password"
          type="password"
          autoComplete="new-password"
          value={newPassword}
          onChange={(event) => setNewPassword(event.target.value)}
          error={passwordErrors.newPassword ?? null}
        />
        <Field
          label="Confirm new password"
          type="password"
          autoComplete="new-password"
          value={confirmPassword}
          onChange={(event) => setConfirmPassword(event.target.value)}
          error={passwordErrors.confirmPassword ?? null}
        />
        <div className="row-end">
          <Button
            variant="primary"
            loading={changingPassword}
            disabled={!currentPassword || !newPassword}
            onClick={() => void changePassword()}
          >
            Change password
          </Button>
        </div>
      </section>

      <section className="settings-block">
        <h4 className="settings-subtitle">Sign out</h4>
        <p className="settings-hint">
          Signing out erases this device’s keys and its decrypted message cache.
          You will need your password to sign back in, and this device will
          generate a new identity.
        </p>
        <Button
          variant="danger"
          icon={<LogOutIcon size={16} />}
          onClick={() => void signOut()}
        >
          Sign out of this device
        </Button>
      </section>
    </div>
  );
}
