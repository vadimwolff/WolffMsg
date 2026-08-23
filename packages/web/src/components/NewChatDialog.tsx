/**
 * Find someone and open a conversation.
 *
 * Search is prefix-only server-side, so this is a directory lookup rather than
 * a way to enumerate the user base.
 */
import { useEffect, useState } from 'react';
import type { PublicUser } from '@wolffmsg/shared';
import { api, ApiError } from '../lib/api.ts';
import { useChats } from '../store/chats.ts';
import { useUi } from '../store/ui.ts';
import { Avatar } from './Avatar.tsx';
import { EmptyState, Modal, Skeleton } from './primitives.tsx';
import { SearchIcon, UserIcon } from './icons.tsx';

export function NewChatDialog({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<PublicUser[]>([]);
  const [searching, setSearching] = useState(false);
  const [opening, setOpening] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const openChat = useChats((s) => s.openChat);
  const loadChats = useChats((s) => s.loadChats);
  const toast = useUi((s) => s.toast);

  useEffect(() => {
    if (!open) {
      setQuery('');
      setResults([]);
      setError(null);
    }
  }, [open]);

  useEffect(() => {
    const needle = query.trim();
    if (needle.length < 2) {
      setResults([]);
      return;
    }

    setSearching(true);
    const controller = new AbortController();
    const timer = window.setTimeout(async () => {
      try {
        const response = await api.get<{ users: PublicUser[] }>(
          `/api/users/search?q=${encodeURIComponent(needle)}`,
          controller.signal,
        );
        setResults(response.users);
      } catch (err) {
        if ((err as Error).name !== 'AbortError') setResults([]);
      } finally {
        setSearching(false);
      }
    }, 280);

    return () => {
      controller.abort();
      window.clearTimeout(timer);
    };
  }, [query]);

  async function start(user: PublicUser) {
    setOpening(user.id);
    setError(null);
    try {
      const response = await api.post<{ chat: { id: string } }>('/api/chats/direct', {
        userId: user.id,
      });
      await loadChats();
      await openChat(response.chat.id);
      onClose();
    } catch (err) {
      const message =
        err instanceof ApiError ? err.message : 'Could not start that conversation';
      setError(message);
      toast(message, 'danger');
    } finally {
      setOpening(null);
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="New conversation"
      description="Search by username or display name."
    >
      <div className="dialog-search">
        <SearchIcon size={16} />
        <input
          data-autofocus
          className="dialog-search-input"
          type="search"
          placeholder="Search people"
          aria-label="Search people"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
      </div>

      {error ? (
        <p className="dialog-error" role="alert">
          {error}
        </p>
      ) : null}

      <div className="people-list">
        {searching ? (
          <>
            {[0, 1, 2].map((i) => (
              <div className="people-row" key={i}>
                <Skeleton width={40} height={40} radius={20} />
                <div style={{ flex: 1 }}>
                  <Skeleton width="45%" height={11} />
                </div>
              </div>
            ))}
          </>
        ) : results.length === 0 ? (
          query.trim().length >= 2 ? (
            <EmptyState
              icon={<UserIcon size={26} />}
              title="No one found"
              description="Check the spelling, or ask them for their exact username."
            />
          ) : (
            <p className="dialog-hint">Type at least two characters to search.</p>
          )
        ) : (
          results.map((user) => (
            <button
              key={user.id}
              type="button"
              className="people-row"
              onClick={() => void start(user)}
              disabled={opening === user.id}
            >
              <Avatar
                userId={user.id}
                name={user.displayName}
                url={user.avatarUrl}
                size={40}
                shape="circle"
                online={user.online}
              />
              <span className="people-row-text">
                <span className="people-row-name">{user.displayName}</span>
                <span className="people-row-username">@{user.username}</span>
              </span>
              {opening === user.id ? (
                <span className="people-row-status">Opening…</span>
              ) : null}
            </button>
          ))
        )}
      </div>
    </Modal>
  );
}
