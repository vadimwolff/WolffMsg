/**
 * Search.
 *
 * Message search runs entirely on this device against the local decrypted
 * cache — the server holds ciphertext and could not answer the query even if
 * we asked it to. People search does go to the server, because usernames are
 * not secret.
 */
import { useEffect, useState } from 'react';
import type { PublicUser } from '@wolffmsg/shared';
import { api } from '../lib/api.ts';
import { searchMessages, type SearchHit } from '../crypto/messageCache.ts';
import { useChats } from '../store/chats.ts';
import { useUi } from '../store/ui.ts';
import { Avatar } from './Avatar.tsx';
import { EmptyState, Modal, Segmented } from './primitives.tsx';
import { LockIcon, SearchIcon } from './icons.tsx';
import { formatListTimestamp } from '../lib/format.ts';
import { onAsync } from '../lib/async.ts';

type Scope = 'messages' | 'people';

export function SearchDialog({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  const [scope, setScope] = useState<Scope>('messages');
  const [query, setQuery] = useState('');
  const [hits, setHits] = useState<SearchHit[]>([]);
  const [people, setPeople] = useState<PublicUser[]>([]);
  const [searching, setSearching] = useState(false);

  const chats = useChats((s) => s.chats);
  const knownPeople = useChats((s) => s.people);
  const openChat = useChats((s) => s.openChat);
  const openOverlay = useUi((s) => s.openOverlay);

  useEffect(() => {
    if (open) return;
    setQuery('');
    setHits([]);
    setPeople([]);
  }, [open]);

  useEffect(() => {
    const needle = query.trim();
    if (needle.length < 2) {
      setHits([]);
      setPeople([]);
      return;
    }

    setSearching(true);
    const controller = new AbortController();
    const timer = window.setTimeout(onAsync(async () => {
      try {
        if (scope === 'messages') {
          setHits(await searchMessages(needle));
        } else {
          const response = await api.get<{ users: PublicUser[] }>(
            `/api/users/search?q=${encodeURIComponent(needle)}`,
            controller.signal,
          );
          setPeople(response.users);
        }
      } catch {
        /* leave the previous results in place */
      } finally {
        setSearching(false);
      }
    }), 200);

    return () => {
      controller.abort();
      window.clearTimeout(timer);
    };
  }, [query, scope]);

  return (
    <Modal open={open} onClose={onClose} title="Search" size="lg">
      <div className="stack">
        <Segmented
          label="Search scope"
          value={scope}
          onChange={(next) => setScope(next)}
          options={[
            { value: 'messages', label: 'Messages' },
            { value: 'people', label: 'People' },
          ]}
        />

        <div className="dialog-search">
          <SearchIcon size={16} />
          <input
            data-autofocus
            className="dialog-search-input"
            type="search"
            placeholder={scope === 'messages' ? 'Search your messages' : 'Search people'}
            aria-label={scope === 'messages' ? 'Search messages' : 'Search people'}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        </div>

        {scope === 'messages' ? (
          <p className="dialog-note">
            <LockIcon size={12} />
            Searched on this device only. The server stores ciphertext and cannot
            read your messages.
          </p>
        ) : null}

        {query.trim().length < 2 ? (
          <p className="dialog-hint">Type at least two characters.</p>
        ) : scope === 'messages' ? (
          hits.length === 0 && !searching ? (
            <EmptyState
              icon={<SearchIcon size={26} />}
              title="Nothing found"
              description="Only messages this device has decrypted can be searched."
            />
          ) : (
            <div className="search-results">
              {hits.map((hit) => {
                const chat = chats.find((c) => c.id === hit.message.chatId);
                const sender = knownPeople[hit.message.senderId];
                const title =
                  chat?.type === 'group'
                    ? (chat.title ?? 'Group')
                    : (chat?.peer?.displayName ?? 'Conversation');

                return (
                  <button
                    key={hit.message.id}
                    type="button"
                    className="search-result"
                    onClick={() => {
                      void openChat(hit.message.chatId);
                      onClose();
                    }}
                  >
                    <span className="search-result-head">
                      <span className="search-result-chat">{title}</span>
                      <span className="search-result-time">
                        {formatListTimestamp(hit.message.createdAt)}
                      </span>
                    </span>
                    <span className="search-result-body">
                      {sender ? (
                        <span className="search-result-sender">
                          {sender.displayName}:{' '}
                        </span>
                      ) : null}
                      <Excerpt text={hit.message.body} offset={hit.offset} length={query.trim().length} />
                    </span>
                  </button>
                );
              })}
            </div>
          )
        ) : people.length === 0 && !searching ? (
          <EmptyState
            icon={<SearchIcon size={26} />}
            title="No one found"
            description="Try their exact username."
          />
        ) : (
          <div className="people-list">
            {people.map((user) => (
              <button
                key={user.id}
                type="button"
                className="people-row"
                onClick={() => {
                  openOverlay({ kind: 'profile', userId: user.id });
                }}
              >
                <Avatar
                  userId={user.id}
                  name={user.displayName}
                  url={user.avatarUrl}
                  size={38}
                  shape="circle"
                  online={user.online}
                />
                <span className="people-row-text">
                  <span className="people-row-name">{user.displayName}</span>
                  <span className="people-row-username">@{user.username}</span>
                </span>
              </button>
            ))}
          </div>
        )}
      </div>
    </Modal>
  );
}

/** Show the match in context with the hit itself marked. */
function Excerpt({
  text,
  offset,
  length,
}: {
  text: string;
  offset: number;
  length: number;
}) {
  const start = Math.max(0, offset - 36);
  const end = Math.min(text.length, offset + length + 60);

  return (
    <>
      {start > 0 ? '…' : ''}
      {text.slice(start, offset)}
      <mark className="search-mark">{text.slice(offset, offset + length)}</mark>
      {text.slice(offset + length, end)}
      {end < text.length ? '…' : ''}
    </>
  );
}
