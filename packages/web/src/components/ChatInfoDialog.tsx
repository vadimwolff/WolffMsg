/**
 * Conversation details.
 *
 * For a group this is also the administration surface. Which controls appear
 * is decided from the caller's real role — and every one of them is re-checked
 * server-side, so hiding a button is a courtesy rather than the enforcement.
 */
import { useState } from 'react';
import { LIMITS, type ChatRole } from '@wolffmsg/shared';
import { api, ApiError } from '../lib/api.ts';
import { useChats } from '../store/chats.ts';
import { useSession } from '../store/session.ts';
import { useUi } from '../store/ui.ts';
import { Avatar } from './Avatar.tsx';
import {
  Badge,
  Button,
  Field,
  Menu,
  Modal,
  TextArea,
  Toggle,
} from './primitives.tsx';
import {
  EditIcon,
  LockIcon,
  LogOutIcon,
  MoreIcon,
  PlusIcon,
  ShieldCheckIcon,
  TrashIcon,
  UsersIcon,
} from './icons.tsx';
import { formatLastSeen } from '../lib/format.ts';

export function ChatInfoDialog({
  chatId,
  onClose,
}: {
  chatId: string;
  onClose: () => void;
}) {
  const chat = useChats((s) => s.chats.find((c) => c.id === chatId));
  const presence = useChats((s) => s.presence);
  const loadChats = useChats((s) => s.loadChats);
  const setChatSetting = useChats((s) => s.setChatSetting);
  const self = useSession((s) => s.user);
  const openOverlay = useUi((s) => s.openOverlay);
  const toast = useUi((s) => s.toast);

  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState(chat?.title ?? '');
  const [description, setDescription] = useState(chat?.description ?? '');
  const [busy, setBusy] = useState(false);
  const [memberMenu, setMemberMenu] = useState<string | null>(null);

  if (!chat) return null;

  const isGroup = chat.type === 'group';
  const isOwner = chat.myRole === 'owner';
  const isAdmin = chat.myRole === 'admin' || isOwner;

  async function act(work: () => Promise<unknown>, success?: string) {
    setBusy(true);
    try {
      await work();
      await loadChats();
      if (success) toast(success, 'success');
    } catch (err) {
      toast(err instanceof ApiError ? err.message : 'That did not work', 'danger');
    } finally {
      setBusy(false);
    }
  }

  const title_ = isGroup ? (chat.title ?? 'Group') : (chat.peer?.displayName ?? '');

  return (
    <Modal
      open
      onClose={onClose}
      title={isGroup ? 'Group info' : 'Conversation info'}
      size="md"
    >
      <div className="stack">
        <div className="info-head">
          <Avatar
            userId={isGroup ? chat.id : (chat.peer?.id ?? chat.id)}
            name={title_}
            url={isGroup ? chat.avatarUrl : chat.peer?.avatarUrl}
            size={80}
            shape={isGroup ? 'rounded' : 'circle'}
          />

          {editing ? (
            <div className="stack" style={{ width: '100%' }}>
              <Field
                label="Group name"
                value={title}
                maxLength={LIMITS.chatTitleMax}
                onChange={(event) => setTitle(event.target.value)}
              />
              <TextArea
                label="Description"
                value={description}
                maxLength={LIMITS.chatDescriptionMax}
                onChange={(event) => setDescription(event.target.value)}
              />
              <div className="row-end">
                <Button onClick={() => setEditing(false)}>Cancel</Button>
                <Button
                  variant="primary"
                  loading={busy}
                  onClick={() =>
                    void act(async () => {
                      await api.patch(`/api/chats/${chatId}`, {
                        title: title.trim(),
                        description: description.trim() || null,
                      });
                      setEditing(false);
                    }, 'Group updated')
                  }
                >
                  Save
                </Button>
              </div>
            </div>
          ) : (
            <>
              <h3 className="info-title">{title_}</h3>
              {isGroup ? (
                <p className="info-subtitle">
                  {chat.members.length} member{chat.members.length === 1 ? '' : 's'}
                </p>
              ) : (
                <>
                  <p className="info-subtitle">@{chat.peer?.username}</p>
                  {chat.peer?.online !== null ? (
                    <p className="info-subtitle">
                      {formatLastSeen(
                        presence[chat.peer?.id ?? '']?.online ?? chat.peer?.online ?? null,
                        presence[chat.peer?.id ?? '']?.lastSeenAt ??
                          chat.peer?.lastSeenAt ??
                          null,
                      )}
                    </p>
                  ) : null}
                </>
              )}
              {chat.description ? (
                <p className="info-description">{chat.description}</p>
              ) : null}
              {isAdmin && isGroup ? (
                <Button
                  size="sm"
                  icon={<EditIcon size={14} />}
                  onClick={() => setEditing(true)}
                >
                  Edit
                </Button>
              ) : null}
            </>
          )}
        </div>

        <div className="notice" data-tone="accent">
          <LockIcon size={16} />
          <div>
            <strong>End-to-end encrypted</strong>
            <p>
              Messages are encrypted on each device before they are sent. The server
              stores only ciphertext.
            </p>
          </div>
        </div>

        <section className="info-section">
          <h4 className="info-section-title">Notifications</h4>
          <Toggle
            label="Mute this conversation"
            description="You still receive messages; they just do not notify you."
            checked={chat.muted}
            onChange={(next) => void setChatSetting(chatId, { muted: next })}
          />
          <Toggle
            label="Pin to the top"
            checked={chat.pinned}
            onChange={(next) => void setChatSetting(chatId, { pinned: next })}
          />
          <Toggle
            label="Archive"
            description="Hides it from the main list until it is unarchived."
            checked={chat.archived}
            onChange={(next) => void setChatSetting(chatId, { archived: next })}
          />
        </section>

        {isGroup && isAdmin ? (
          <section className="info-section">
            <h4 className="info-section-title">Permissions</h4>
            <Toggle
              label="Only admins can post"
              description="Members can still read and react."
              checked={chat.readOnlyForMembers}
              onChange={(next) =>
                void act(
                  () =>
                    api.patch(`/api/chats/${chatId}/permissions`, {
                      readOnlyForMembers: next,
                    }),
                  next ? 'Posting restricted to admins' : 'Everyone can post',
                )
              }
            />
          </section>
        ) : null}

        {isGroup ? (
          <section className="info-section">
            <div className="info-section-head">
              <h4 className="info-section-title">
                <UsersIcon size={15} />
                Members
              </h4>
              {isAdmin ? (
                <Button
                  size="sm"
                  icon={<PlusIcon size={14} />}
                  onClick={() => openOverlay({ kind: 'new-group' })}
                >
                  Add
                </Button>
              ) : null}
            </div>

            <div className="member-list">
              {chat.members.map((member) => {
                const isSelf = member.userId === self?.id;
                const canManage = isAdmin && !isSelf && member.role !== 'owner';
                const canPromote = isOwner && !isSelf && member.role !== 'owner';

                return (
                  <div className="member-row" key={member.userId}>
                    <button
                      type="button"
                      className="member-identity"
                      onClick={() =>
                        !isSelf && openOverlay({ kind: 'profile', userId: member.userId })
                      }
                    >
                      <Avatar
                        userId={member.userId}
                        name={member.user.displayName}
                        url={member.user.avatarUrl}
                        size={36}
                        shape="circle"
                        online={presence[member.userId]?.online ?? member.user.online}
                      />
                      <span className="member-text">
                        <span className="member-name">
                          {member.user.displayName}
                          {isSelf ? ' (you)' : ''}
                        </span>
                        <span className="member-username">@{member.user.username}</span>
                      </span>
                    </button>

                    {member.role !== 'member' ? (
                      <Badge tone={member.role === 'owner' ? 'accent' : 'neutral'}>
                        {member.role}
                      </Badge>
                    ) : null}

                    {canManage || canPromote ? (
                      <div className="menu-anchor">
                        <button
                          type="button"
                          className="icon-btn"
                          data-size="sm"
                          aria-label={`Manage ${member.user.displayName}`}
                          onClick={() =>
                            setMemberMenu((id) =>
                              id === member.userId ? null : member.userId,
                            )
                          }
                        >
                          <MoreIcon size={15} />
                        </button>
                        <Menu
                          open={memberMenu === member.userId}
                          onClose={() => setMemberMenu(null)}
                          label={`Manage ${member.user.displayName}`}
                          items={[
                            ...(canPromote
                              ? [
                                  {
                                    label:
                                      member.role === 'admin'
                                        ? 'Remove admin'
                                        : 'Make admin',
                                    icon: <ShieldCheckIcon size={16} />,
                                    onSelect: () =>
                                      void act(
                                        () =>
                                          api.patch(
                                            `/api/chats/${chatId}/members/${member.userId}/role`,
                                            {
                                              role:
                                                member.role === 'admin'
                                                  ? 'member'
                                                  : ('admin' as ChatRole),
                                            },
                                          ),
                                        'Role updated',
                                      ),
                                  },
                                  {
                                    label: 'Transfer ownership',
                                    icon: <ShieldCheckIcon size={16} />,
                                    onSelect: () =>
                                      void act(
                                        () =>
                                          api.post(
                                            `/api/chats/${chatId}/transfer-ownership`,
                                            { userId: member.userId },
                                          ),
                                        'Ownership transferred',
                                      ),
                                  },
                                ]
                              : []),
                            ...(canManage
                              ? [
                                  {
                                    label: 'Remove from group',
                                    icon: <TrashIcon size={16} />,
                                    tone: 'danger' as const,
                                    onSelect: () =>
                                      void act(
                                        () =>
                                          api.delete(
                                            `/api/chats/${chatId}/members/${member.userId}`,
                                          ),
                                        'Removed from the group',
                                      ),
                                  },
                                ]
                              : []),
                          ]}
                        />
                      </div>
                    ) : null}
                  </div>
                );
              })}
            </div>
          </section>
        ) : null}

        <section className="info-section">
          <h4 className="info-section-title">Security</h4>
          {chat.peer ? (
            <Button
              icon={<ShieldCheckIcon size={16} />}
              onClick={() =>
                openOverlay({ kind: 'safety-number', userId: chat.peer!.id })
              }
            >
              Verify safety number
            </Button>
          ) : (
            <p className="dialog-note">
              Verify each member individually from their profile. A group has no
              single safety number, because it has more than two sets of keys.
            </p>
          )}
        </section>

        <section className="info-section">
          {isGroup ? (
            <>
              <Button
                variant="danger"
                icon={<LogOutIcon size={16} />}
                loading={busy}
                onClick={() =>
                  void act(async () => {
                    await api.post(`/api/chats/${chatId}/leave`);
                    onClose();
                  }, 'You left the group')
                }
              >
                Leave group
              </Button>
              {isOwner ? (
                <Button
                  variant="danger"
                  icon={<TrashIcon size={16} />}
                  loading={busy}
                  onClick={() =>
                    void act(async () => {
                      await api.delete(`/api/chats/${chatId}`);
                      onClose();
                    }, 'Group deleted')
                  }
                >
                  Delete group
                </Button>
              ) : null}
            </>
          ) : chat.peer ? (
            <Button
              variant="danger"
              onClick={() => openOverlay({ kind: 'profile', userId: chat.peer!.id })}
            >
              Block or report
            </Button>
          ) : null}
        </section>
      </div>
    </Modal>
  );
}
