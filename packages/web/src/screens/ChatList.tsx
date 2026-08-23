/**
 * The conversation list.
 *
 * Sorted pinned-first, then by recency. Each row has to answer four questions
 * at a glance — who, what, when, and how many unread — without becoming noisy,
 * so the secondary indicators (mute, pin) are quiet glyphs rather than badges.
 */
import { useMemo, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import type { ChatSummary } from '@wolffmsg/shared';
import { Avatar } from '../components/Avatar.tsx';
import { Logo } from '../components/Logo.tsx';
import {
  Button,
  ChatListSkeleton,
  EmptyState,
  IconButton,
  Menu,
} from '../components/primitives.tsx';
import {
  ArchiveIcon,
  BellOffIcon,
  MoreIcon,
  PinIcon,
  PlusIcon,
  SearchIcon,
  SettingsIcon,
  UsersIcon,
} from '../components/icons.tsx';
import { useChats } from '../store/chats.ts';
import { useSession } from '../store/session.ts';
import { useUi } from '../store/ui.ts';
import { formatListTimestamp, truncate } from '../lib/format.ts';
import { recallPlaintext } from '../crypto/messageCache.ts';

export function ChatList() {
  const chats = useChats((s) => s.chats);
  const loading = useChats((s) => s.loadingChats);
  const activeChatId = useChats((s) => s.activeChatId);
  const openChat = useChats((s) => s.openChat);
  const presence = useChats((s) => s.presence);
  const typing = useChats((s) => s.typing);
  const user = useSession((s) => s.user);
  const openOverlay = useUi((s) => s.openOverlay);

  const [filter, setFilter] = useState('');
  const [showArchived, setShowArchived] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);

  const visible = useMemo(() => {
    const needle = filter.trim().toLowerCase();
    return chats
      .filter((chat) => (showArchived ? chat.archived : !chat.archived))
      .filter((chat) => {
        if (!needle) return true;
        const title = titleOf(chat).toLowerCase();
        const username = chat.peer?.username.toLowerCase() ?? '';
        return title.includes(needle) || username.includes(needle);
      });
  }, [chats, filter, showArchived]);

  const archivedCount = chats.filter((c) => c.archived).length;
  const totalUnread = chats.reduce((sum, chat) => sum + chat.unreadCount, 0);

  return (
    <div className="chat-list">
      <header className="sidebar-header">
        <button
          type="button"
          className="sidebar-identity"
          onClick={() => openOverlay({ kind: 'settings', section: 'account' })}
          aria-label="Your profile and settings"
        >
          <Logo size={26} />
          <span className="sidebar-wordmark">
            WOLFF<span className="logo-wordmark-accent">MSG</span>
          </span>
        </button>

        <div className="sidebar-header-actions">
          <IconButton
            label="New conversation"
            onClick={() => openOverlay({ kind: 'new-chat' })}
          >
            <PlusIcon />
          </IconButton>
          <div className="menu-anchor">
            <IconButton label="Menu" onClick={() => setMenuOpen((v) => !v)}>
              <MoreIcon />
            </IconButton>
            <Menu
              open={menuOpen}
              onClose={() => setMenuOpen(false)}
              label="Application menu"
              items={[
                {
                  label: 'New group',
                  icon: <UsersIcon size={16} />,
                  onSelect: () => openOverlay({ kind: 'new-group' }),
                },
                {
                  label: 'Search messages',
                  icon: <SearchIcon size={16} />,
                  onSelect: () => openOverlay({ kind: 'search' }),
                },
                {
                  label: showArchived ? 'Show active chats' : 'Show archived',
                  icon: <ArchiveIcon size={16} />,
                  onSelect: () => setShowArchived((v) => !v),
                },
                {
                  label: 'Settings',
                  icon: <SettingsIcon size={16} />,
                  onSelect: () => openOverlay({ kind: 'settings' }),
                },
              ]}
            />
          </div>
        </div>
      </header>

      <div className="sidebar-search">
        <SearchIcon size={16} />
        <input
          type="search"
          className="sidebar-search-input"
          placeholder="Search conversations"
          aria-label="Search conversations"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        />
        {filter ? (
          <button
            type="button"
            className="sidebar-search-clear"
            onClick={() => setFilter('')}
            aria-label="Clear search"
          >
            ✕
          </button>
        ) : null}
      </div>

      {showArchived ? (
        <button
          type="button"
          className="sidebar-back-to-active"
          onClick={() => setShowArchived(false)}
        >
          ← Back to active conversations
        </button>
      ) : null}

      <div className="chat-scroll" role="list">
        {loading && chats.length === 0 ? (
          <ChatListSkeleton />
        ) : visible.length === 0 ? (
          filter ? (
            <EmptyState
              icon={<SearchIcon size={28} />}
              title="No matches"
              description={`Nothing here matches “${truncate(filter, 24)}”.`}
            />
          ) : showArchived ? (
            <EmptyState
              icon={<ArchiveIcon size={28} />}
              title="Nothing archived"
              description="Conversations you archive will collect here."
            />
          ) : (
            // Compact on purpose: the main pane already carries the full empty
            // state, and repeating it twice on one screen reads as a rendering
            // bug rather than as emphasis.
            <div className="chat-list-empty">
              <p className="chat-list-empty-text">No conversations yet</p>
              <Button
                size="sm"
                icon={<PlusIcon size={14} />}
                onClick={() => openOverlay({ kind: 'new-chat' })}
              >
                New message
              </Button>
            </div>
          )
        ) : (
          <AnimatePresence initial={false}>
            {visible.map((chat) => (
              <ChatRow
                key={chat.id}
                chat={chat}
                active={chat.id === activeChatId}
                selfId={user?.id ?? ''}
                online={
                  chat.peer
                    ? (presence[chat.peer.id]?.online ?? chat.peer.online)
                    : null
                }
                typingUserIds={typing[chat.id] ?? []}
                onOpen={() => void openChat(chat.id)}
              />
            ))}
          </AnimatePresence>
        )}
      </div>

      {archivedCount > 0 && !showArchived ? (
        <button
          type="button"
          className="sidebar-archived-link"
          onClick={() => setShowArchived(true)}
        >
          <ArchiveIcon size={15} />
          Archived
          <span className="sidebar-archived-count">{archivedCount}</span>
        </button>
      ) : null}

      {totalUnread > 0 ? (
        <span className="sr-only" aria-live="polite">
          {totalUnread} unread message{totalUnread === 1 ? '' : 's'}
        </span>
      ) : null}
    </div>
  );
}

function titleOf(chat: ChatSummary): string {
  if (chat.type === 'group') return chat.title ?? 'Group';
  return chat.peer?.displayName ?? 'Conversation';
}

function ChatRow({
  chat,
  active,
  selfId,
  online,
  typingUserIds,
  onOpen,
}: {
  chat: ChatSummary;
  active: boolean;
  selfId: string;
  online: boolean | null;
  typingUserIds: string[];
  onOpen: () => void;
}) {
  const title = titleOf(chat);
  const preview = usePreview(chat, selfId, typingUserIds);

  return (
    <motion.button
      type="button"
      role="listitem"
      layout
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0, height: 0 }}
      transition={{ duration: 0.18 }}
      className="chat-row"
      data-active={active ? 'true' : undefined}
      data-unread={chat.unreadCount > 0 ? 'true' : undefined}
      onClick={onOpen}
      aria-current={active ? 'true' : undefined}
    >
      <Avatar
        userId={chat.type === 'group' ? chat.id : (chat.peer?.id ?? chat.id)}
        name={title}
        url={chat.type === 'group' ? chat.avatarUrl : chat.peer?.avatarUrl}
        size={46}
        online={chat.type === 'direct' ? online : null}
        shape={chat.type === 'group' ? 'rounded' : 'circle'}
      />

      <span className="chat-row-body">
        <span className="chat-row-top">
          <span className="chat-row-title">
            {chat.pinned ? <PinIcon size={12} className="chat-row-pin" /> : null}
            {title}
          </span>
          <span className="chat-row-time">
            {chat.lastMessage
              ? formatListTimestamp(chat.lastMessage.createdAt)
              : formatListTimestamp(chat.createdAt)}
          </span>
        </span>

        <span className="chat-row-bottom">
          <span className="chat-row-preview" data-typing={preview.typing || undefined}>
            {preview.text}
          </span>
          <span className="chat-row-markers">
            {chat.muted ? (
              <BellOffIcon size={13} className="chat-row-muted" aria-label="Muted" />
            ) : null}
            {chat.unreadCount > 0 ? (
              <span className="chat-row-badge" data-muted={chat.muted || undefined}>
                {chat.unreadCount > 99 ? '99+' : chat.unreadCount}
              </span>
            ) : null}
          </span>
        </span>
      </span>
    </motion.button>
  );
}

/**
 * The preview line.
 *
 * The last message is ciphertext until this device decrypts it, so the preview
 * reads from the local plaintext cache and falls back to a neutral description
 * rather than showing nothing.
 */
function usePreview(
  chat: ChatSummary,
  selfId: string,
  typingUserIds: string[],
): { text: string; typing: boolean } {
  const people = useChats((s) => s.people);

  if (typingUserIds.length > 0) {
    if (chat.type === 'direct') return { text: 'typing…', typing: true };
    const names = typingUserIds
      .map((id) => people[id]?.displayName.split(' ')[0] ?? 'Someone')
      .slice(0, 2);
    return { text: `${names.join(', ')} typing…`, typing: true };
  }

  const last = chat.lastMessage;
  if (!last) return { text: 'No messages yet', typing: false };

  if (last.system) return { text: describeSystemEvent(last.system, people), typing: false };
  if (last.deletedAt) return { text: 'Message deleted', typing: false };

  const prefix =
    chat.type === 'group' && last.senderId !== selfId
      ? `${people[last.senderId]?.displayName.split(' ')[0] ?? 'Someone'}: `
      : last.senderId === selfId
        ? 'You: '
        : '';

  const plaintext = recallPlaintext(last.id);
  if (plaintext) {
    if (plaintext.voice) return { text: `${prefix}🎙 Voice message`, typing: false };
    if (plaintext.body.trim()) {
      return { text: prefix + truncate(plaintext.body.replace(/\s+/g, ' '), 60), typing: false };
    }
    if (plaintext.attachments?.length) {
      const first = plaintext.attachments[0]!;
      const kind = first.mimeType.startsWith('image/')
        ? 'Photo'
        : first.mimeType.startsWith('video/')
          ? 'Video'
          : 'File';
      return { text: `${prefix}📎 ${kind}`, typing: false };
    }
  }

  if (last.attachments.length > 0) return { text: `${prefix}📎 Attachment`, typing: false };
  return { text: `${prefix}Encrypted message`, typing: false };
}

export function describeSystemEvent(
  event: NonNullable<ChatSummary['lastMessage']>['system'],
  people: Record<string, { displayName: string }>,
): string {
  if (!event) return '';
  const name = (id: string) => people[id]?.displayName ?? 'Someone';

  switch (event.kind) {
    case 'chat.created':
      return `${name(event.actorId)} created the group`;
    case 'member.added':
      return `${name(event.actorId)} added ${event.targetIds.map(name).join(', ')}`;
    case 'member.removed':
      return `${name(event.actorId)} removed ${event.targetIds.map(name).join(', ')}`;
    case 'member.left':
      return `${name(event.actorId)} left the group`;
    case 'role.changed':
      return `${name(event.actorId)} made ${name(event.targetId)} ${event.role === 'admin' ? 'an admin' : 'a member'}`;
    case 'ownership.transferred':
      return `${name(event.actorId)} handed the group to ${name(event.targetId)}`;
    case 'chat.renamed':
      return `${name(event.actorId)} renamed the group to “${event.title}”`;
    case 'chat.description':
      return `${name(event.actorId)} updated the description`;
    case 'chat.avatar':
      return `${name(event.actorId)} changed the group picture`;
    case 'chat.permissions':
      return event.readOnlyForMembers
        ? `${name(event.actorId)} restricted posting to admins`
        : `${name(event.actorId)} allowed everyone to post`;
    case 'call.ended': {
      const kind = event.callKind === 'video' ? 'Video call' : 'Call';
      if (event.state === 'missed') return `${kind} missed`;
      if (event.state === 'declined') return `${kind} declined`;
      const seconds = Math.round(event.durationMs / 1000);
      return `${kind} · ${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
    }
    default:
      return '';
  }
}
