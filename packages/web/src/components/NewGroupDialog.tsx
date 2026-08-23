/** Create a group: name it, then pick who joins. */
import { useEffect, useState } from 'react';
import { LIMITS, validateChatTitle, type PublicUser } from '@wolffmsg/shared';
import { api, ApiError } from '../lib/api.ts';
import { useChats } from '../store/chats.ts';
import { useUi } from '../store/ui.ts';
import { Avatar } from './Avatar.tsx';
import { Button, Field, Modal, TextArea } from './primitives.tsx';
import { CheckIcon, SearchIcon } from './icons.tsx';

export function NewGroupDialog({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<PublicUser[]>([]);
  const [selected, setSelected] = useState<PublicUser[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const openChat = useChats((s) => s.openChat);
  const loadChats = useChats((s) => s.loadChats);
  const toast = useUi((s) => s.toast);

  useEffect(() => {
    if (open) return;
    setTitle('');
    setDescription('');
    setQuery('');
    setResults([]);
    setSelected([]);
    setError(null);
  }, [open]);

  useEffect(() => {
    const needle = query.trim();
    if (needle.length < 2) {
      setResults([]);
      return;
    }
    const controller = new AbortController();
    const timer = window.setTimeout(async () => {
      try {
        const response = await api.get<{ users: PublicUser[] }>(
          `/api/users/search?q=${encodeURIComponent(needle)}`,
          controller.signal,
        );
        setResults(response.users);
      } catch {
        setResults([]);
      }
    }, 280);
    return () => {
      controller.abort();
      window.clearTimeout(timer);
    };
  }, [query]);

  function toggle(user: PublicUser) {
    setSelected((prev) =>
      prev.some((p) => p.id === user.id)
        ? prev.filter((p) => p.id !== user.id)
        : [...prev, user],
    );
  }

  async function create() {
    const problem = validateChatTitle(title);
    if (problem) {
      setError(problem.message);
      return;
    }

    setBusy(true);
    setError(null);
    try {
      const response = await api.post<{ chat: { id: string } }>('/api/chats/group', {
        title: title.trim(),
        description: description.trim() || null,
        memberIds: selected.map((u) => u.id),
      });
      await loadChats();
      await openChat(response.chat.id);
      onClose();
    } catch (err) {
      const message =
        err instanceof ApiError ? err.message : 'Could not create that group';
      setError(message);
      toast(message, 'danger');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="New group"
      description="Everyone you add can read messages sent from the moment they join."
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button
            variant="primary"
            loading={busy}
            disabled={!title.trim()}
            onClick={() => void create()}
          >
            Create group
          </Button>
        </>
      }
    >
      <div className="stack">
        <Field
          data-autofocus
          label="Group name"
          value={title}
          maxLength={LIMITS.chatTitleMax}
          onChange={(event) => setTitle(event.target.value)}
          error={error}
        />

        <TextArea
          label="Description"
          value={description}
          maxLength={LIMITS.chatDescriptionMax}
          onChange={(event) => setDescription(event.target.value)}
          hint="Optional. Visible to everyone in the group."
        />

        {selected.length > 0 ? (
          <div className="chip-row">
            {selected.map((user) => (
              <button
                key={user.id}
                type="button"
                className="chip"
                onClick={() => toggle(user)}
                aria-label={`Remove ${user.displayName}`}
              >
                <Avatar
                  userId={user.id}
                  name={user.displayName}
                  url={user.avatarUrl}
                  size={18}
                  shape="circle"
                />
                {user.displayName}
                <span aria-hidden="true">✕</span>
              </button>
            ))}
          </div>
        ) : null}

        <div className="dialog-search">
          <SearchIcon size={16} />
          <input
            className="dialog-search-input"
            type="search"
            placeholder="Add people"
            aria-label="Search people to add"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        </div>

        <div className="people-list">
          {results.map((user) => {
            const chosen = selected.some((p) => p.id === user.id);
            return (
              <button
                key={user.id}
                type="button"
                className="people-row"
                data-selected={chosen ? 'true' : undefined}
                onClick={() => toggle(user)}
                aria-pressed={chosen}
              >
                <Avatar
                  userId={user.id}
                  name={user.displayName}
                  url={user.avatarUrl}
                  size={36}
                  shape="circle"
                />
                <span className="people-row-text">
                  <span className="people-row-name">{user.displayName}</span>
                  <span className="people-row-username">@{user.username}</span>
                </span>
                {chosen ? (
                  <span className="people-row-check">
                    <CheckIcon size={16} />
                  </span>
                ) : null}
              </button>
            );
          })}
        </div>
      </div>
    </Modal>
  );
}
