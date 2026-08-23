/**
 * Command palette (⌘K / Ctrl+K).
 *
 * Commands and conversations in one list, filtered by a fuzzy subsequence
 * match so "nwgp" finds "New group". Arrow keys move, Enter runs, Escape
 * closes.
 */
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { usePresence } from '../hooks/usePresence.ts';
import { Avatar } from './Avatar.tsx';
import {
  ArchiveIcon,
  LogOutIcon,
  PaletteIcon,
  PlusIcon,
  SearchIcon,
  SettingsIcon,
  ShieldIcon,
  UserIcon,
  UsersIcon,
} from './icons.tsx';
import { useChats } from '../store/chats.ts';
import { useSession } from '../store/session.ts';
import { useUi } from '../store/ui.ts';

interface Command {
  id: string;
  label: string;
  hint?: string;
  icon: ReactNode;
  keywords: string;
  run: () => void;
}

/**
 * Subsequence match: every character of the query must appear in order.
 * Returns a score (lower is better) or `null` when it does not match.
 */
function fuzzyScore(haystack: string, needle: string): number | null {
  if (!needle) return 0;
  let score = 0;
  let index = 0;
  let lastMatch = -1;

  for (const char of needle) {
    const found = haystack.indexOf(char, index);
    if (found === -1) return null;
    // Consecutive matches score better than scattered ones.
    score += found - lastMatch - 1;
    lastMatch = found;
    index = found + 1;
  }
  return score;
}

export function CommandPalette({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  const chats = useChats((s) => s.chats);
  const openChat = useChats((s) => s.openChat);
  const openOverlay = useUi((s) => s.openOverlay);
  const signOut = useSession((s) => s.signOut);
  const user = useSession((s) => s.user);
  const applyAppearance = useSession((s) => s.applyAppearance);

  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    setQuery('');
    setActive(0);
    window.setTimeout(() => inputRef.current?.focus(), 40);
  }, [open]);

  const commands = useMemo<Command[]>(() => {
    const theme = user?.appearance.theme === 'light' ? 'dark' : 'light';
    return [
      {
        id: 'new-message',
        label: 'New message',
        icon: <PlusIcon size={16} />,
        keywords: 'new message chat conversation start dm',
        run: () => openOverlay({ kind: 'new-chat' }),
      },
      {
        id: 'new-group',
        label: 'New group',
        icon: <UsersIcon size={16} />,
        keywords: 'new group create',
        run: () => openOverlay({ kind: 'new-group' }),
      },
      {
        id: 'search',
        label: 'Search messages',
        hint: '⌘F',
        icon: <SearchIcon size={16} />,
        keywords: 'search find messages',
        run: () => openOverlay({ kind: 'search' }),
      },
      {
        id: 'settings',
        label: 'Settings',
        icon: <SettingsIcon size={16} />,
        keywords: 'settings preferences options',
        run: () => openOverlay({ kind: 'settings' }),
      },
      {
        id: 'profile',
        label: 'Your profile',
        icon: <UserIcon size={16} />,
        keywords: 'profile account me avatar name',
        run: () => openOverlay({ kind: 'settings', section: 'account' }),
      },
      {
        id: 'security',
        label: 'Security Center',
        icon: <ShieldIcon size={16} />,
        keywords: 'security encryption keys devices verification',
        run: () => openOverlay({ kind: 'settings', section: 'security' }),
      },
      {
        id: 'theme',
        label: `Switch to ${theme} theme`,
        icon: <PaletteIcon size={16} />,
        keywords: 'theme dark light appearance toggle',
        run: () => void applyAppearance({ theme }),
      },
      {
        id: 'devices',
        label: 'Active sessions',
        icon: <ArchiveIcon size={16} />,
        keywords: 'devices sessions active logout revoke',
        run: () => openOverlay({ kind: 'settings', section: 'devices' }),
      },
      {
        id: 'logout',
        label: 'Sign out',
        icon: <LogOutIcon size={16} />,
        keywords: 'logout sign out quit leave',
        run: () => void signOut(),
      },
    ];
  }, [openOverlay, signOut, applyAppearance, user?.appearance.theme]);

  const results = useMemo(() => {
    const needle = query.trim().toLowerCase();

    const commandHits = commands
      .map((command) => ({
        kind: 'command' as const,
        command,
        score: fuzzyScore(`${command.label} ${command.keywords}`.toLowerCase(), needle),
      }))
      .filter((hit) => hit.score !== null)
      .sort((a, b) => (a.score ?? 0) - (b.score ?? 0));

    const chatHits = needle
      ? chats
          .map((chat) => {
            const title =
              chat.type === 'group'
                ? (chat.title ?? '')
                : (chat.peer?.displayName ?? '');
            const username = chat.peer?.username ?? '';
            return {
              kind: 'chat' as const,
              chat,
              title,
              score: fuzzyScore(`${title} ${username}`.toLowerCase(), needle),
            };
          })
          .filter((hit) => hit.score !== null)
          .sort((a, b) => (a.score ?? 0) - (b.score ?? 0))
          .slice(0, 6)
      : [];

    return [...chatHits, ...commandHits];
  }, [commands, chats, query]);

  useEffect(() => {
    setActive(0);
  }, [query]);

  // Keep the highlighted row in view as the arrow keys move through it.
  useEffect(() => {
    listRef.current
      ?.querySelector<HTMLElement>('[data-active="true"]')
      ?.scrollIntoView({ block: 'nearest' });
  }, [active]);

  // Presence is timer-driven; see `usePresence`.
  const { mounted, leaving } = usePresence(open, 160);

  function runAt(index: number) {
    const hit = results[index];
    if (!hit) return;
    if (hit.kind === 'command') hit.command.run();
    else void openChat(hit.chat.id);
    onClose();
  }

  if (!mounted) return null;

  return (
    <div className="palette-root" data-leaving={leaving || undefined}>
      <div className="modal-scrim" onClick={onClose} />
      <div className="palette" role="dialog" aria-modal="true" aria-label="Command palette">
            <div className="palette-input-row">
              <SearchIcon size={17} />
              <input
                ref={inputRef}
                className="palette-input"
                placeholder="Search commands and conversations"
                aria-label="Search commands and conversations"
                aria-controls="palette-results"
                aria-activedescendant={`palette-item-${active}`}
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'ArrowDown') {
                    event.preventDefault();
                    setActive((i) => (i + 1) % Math.max(results.length, 1));
                  }
                  if (event.key === 'ArrowUp') {
                    event.preventDefault();
                    setActive(
                      (i) => (i - 1 + results.length) % Math.max(results.length, 1),
                    );
                  }
                  if (event.key === 'Enter') {
                    event.preventDefault();
                    runAt(active);
                  }
                  if (event.key === 'Escape') onClose();
                }}
              />
              <kbd className="palette-kbd">esc</kbd>
            </div>

            <div className="palette-results" id="palette-results" ref={listRef} role="listbox">
              {results.length === 0 ? (
                <p className="palette-empty">No matches.</p>
              ) : (
                results.map((hit, index) => (
                  <button
                    key={hit.kind === 'command' ? hit.command.id : hit.chat.id}
                    id={`palette-item-${index}`}
                    type="button"
                    role="option"
                    aria-selected={index === active}
                    className="palette-item"
                    data-active={index === active ? 'true' : undefined}
                    onMouseEnter={() => setActive(index)}
                    onClick={() => runAt(index)}
                  >
                    {hit.kind === 'command' ? (
                      <>
                        <span className="palette-item-icon">{hit.command.icon}</span>
                        <span className="palette-item-label">{hit.command.label}</span>
                        {hit.command.hint ? (
                          <kbd className="palette-kbd">{hit.command.hint}</kbd>
                        ) : null}
                      </>
                    ) : (
                      <>
                        <Avatar
                          userId={hit.chat.peer?.id ?? hit.chat.id}
                          name={hit.title}
                          url={
                            hit.chat.type === 'group'
                              ? hit.chat.avatarUrl
                              : hit.chat.peer?.avatarUrl
                          }
                          size={24}
                          shape={hit.chat.type === 'group' ? 'rounded' : 'circle'}
                        />
                        <span className="palette-item-label">{hit.title}</span>
                        <span className="palette-item-hint">
                          {hit.chat.type === 'group' ? 'Group' : 'Conversation'}
                        </span>
                      </>
                    )}
                  </button>
                ))
              )}
            </div>

            <footer className="palette-footer">
              <span>
                <kbd className="palette-kbd">↑</kbd>
                <kbd className="palette-kbd">↓</kbd> navigate
              </span>
              <span>
                <kbd className="palette-kbd">↵</kbd> select
              </span>
        </footer>
      </div>
    </div>
  );
}