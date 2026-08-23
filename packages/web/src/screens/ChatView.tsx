/**
 * The conversation thread.
 *
 * Scroll behaviour is the fiddly part and is handled explicitly: stay pinned to
 * the bottom while the reader is already there, hold position when older
 * history is prepended, and offer a jump button rather than yanking the view
 * when a message arrives while they are reading further up.
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import type { PlaintextAttachment } from '@wolffmsg/shared';
import { Avatar } from '../components/Avatar.tsx';
import { Composer } from '../components/Composer.tsx';
import { MessageBubble } from '../components/MessageBubble.tsx';
import { TypingIndicator } from '../components/TypingIndicator.tsx';
import { Logo } from '../components/Logo.tsx';
import {
  Button,
  EmptyState,
  IconButton,
  Menu,
  Spinner,
  ThreadSkeleton,
} from '../components/primitives.tsx';
import {
  ArchiveIcon,
  BellIcon,
  BellOffIcon,
  ChevronDownIcon,
  ChevronLeftIcon,
  InfoIcon,
  LockIcon,
  MoreIcon,
  PhoneIcon,
  PinIcon,
  PlusIcon,
  SearchIcon,
  ShieldCheckIcon,
  UsersIcon,
  VideoIcon,
} from '../components/icons.tsx';
import { api } from '../lib/api.ts';
import {
  NO_IDS,
  NO_MESSAGES,
  useChats,
  type DisplayMessage,
} from '../store/chats.ts';
import { useSession } from '../store/session.ts';
import { useUi } from '../store/ui.ts';
import { useCalls } from '../store/calls.ts';
import { formatDaySeparator, formatLastSeen, sameDay, truncate } from '../lib/format.ts';
import { describeSystemEvent } from './ChatList.tsx';
import { useMediaQuery } from '../hooks/useMediaQuery.ts';

/** Messages this close together from one sender are drawn as a group. */
const GROUP_WINDOW_MS = 5 * 60 * 1000;

export function ChatView() {
  const activeChatId = useChats((s) => s.activeChatId);
  const chats = useChats((s) => s.chats);
  const chat = chats.find((c) => c.id === activeChatId) ?? null;

  if (!chat) return <NoChatSelected />;
  return <Thread key={chat.id} chatId={chat.id} />;
}

function NoChatSelected() {
  const openOverlay = useUi((s) => s.openOverlay);
  return (
    <div className="thread-empty">
      <EmptyState
        icon={<Logo size={56} />}
        title="Your conversations are waiting."
        description="Find someone and start a conversation. Everything you send is encrypted on this device before it leaves."
        action={
          <Button
            variant="primary"
            icon={<PlusIcon size={16} />}
            onClick={() => openOverlay({ kind: 'new-chat' })}
          >
            New message
          </Button>
        }
      />
    </div>
  );
}

function Thread({ chatId }: { chatId: string }) {
  const chat = useChats((s) => s.chats.find((c) => c.id === chatId))!;
  const messages = useChats((s) => s.messages[chatId] ?? NO_MESSAGES);
  const loading = useChats((s) => s.loadingHistory[chatId] ?? false);
  const cursor = useChats((s) => s.cursors[chatId]);
  const typingIds = useChats((s) => s.typing[chatId] ?? NO_IDS);
  const presence = useChats((s) => s.presence);
  const people = useChats((s) => s.people);
  const loadOlder = useChats((s) => s.loadOlder);
  const openChat = useChats((s) => s.openChat);
  const toggleReaction = useChats((s) => s.toggleReaction);
  const deleteMessage = useChats((s) => s.deleteMessage);
  const markRead = useChats((s) => s.markRead);
  const setChatSetting = useChats((s) => s.setChatSetting);

  const user = useSession((s) => s.user);
  const openOverlay = useUi((s) => s.openOverlay);
  const setMobilePane = useUi((s) => s.setMobilePane);
  const setReplyingTo = useUi((s) => s.setReplyingTo);
  const setEditing = useUi((s) => s.setEditing);
  const toast = useUi((s) => s.toast);
  const startCall = useCalls((s) => s.start);
  const isCompact = useMediaQuery('(max-width: 860px)');

  const scrollRef = useRef<HTMLDivElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const [atBottom, setAtBottom] = useState(true);
  const [menuOpen, setMenuOpen] = useState(false);
  const [highlighted, setHighlighted] = useState<string | null>(null);
  const previousHeight = useRef(0);
  const previousCount = useRef(0);

  useEffect(() => {
    void openChat(chatId);
  }, [chatId, openChat]);

  // Keep the view pinned to the newest message when the reader is already
  // there; otherwise leave their position alone and show the jump button.
  useLayoutEffect(() => {
    const node = scrollRef.current;
    if (!node) return;

    const grewAtTop =
      messages.length > previousCount.current && node.scrollTop < 120 && previousCount.current > 0;

    if (grewAtTop) {
      // Older history was prepended — restore the offset so the page does not
      // jump under the reader's cursor.
      node.scrollTop = node.scrollHeight - previousHeight.current;
    } else if (atBottom) {
      node.scrollTop = node.scrollHeight;
    }

    previousHeight.current = node.scrollHeight;
    previousCount.current = messages.length;
  }, [messages, atBottom]);

  const onScroll = useCallback(() => {
    const node = scrollRef.current;
    if (!node) return;

    const distanceFromBottom = node.scrollHeight - node.scrollTop - node.clientHeight;
    setAtBottom(distanceFromBottom < 120);

    if (node.scrollTop < 400 && cursor && !loading) {
      void loadOlder(chatId);
    }
  }, [chatId, cursor, loading, loadOlder]);

  // Mark visible messages read when the tab regains focus.
  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState !== 'visible' || !atBottom) return;
      const unread = messages
        .filter((m) => m.record.senderId !== user?.id)
        .slice(-30)
        .map((m) => m.record.id);
      if (unread.length > 0) markRead(chatId, unread);
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, [messages, atBottom, chatId, markRead, user?.id]);

  const jumpToMessage = useCallback((messageId: string) => {
    const node = document.querySelector<HTMLElement>(`[data-message-id="${messageId}"]`);
    if (!node) return;
    node.scrollIntoView({ behavior: 'smooth', block: 'center' });
    setHighlighted(messageId);
    window.setTimeout(() => setHighlighted(null), 1_600);
  }, []);

  const title = chat.type === 'group' ? (chat.title ?? 'Group') : (chat.peer?.displayName ?? '');
  const peerPresence = chat.peer
    ? (presence[chat.peer.id] ?? {
        online: chat.peer.online,
        lastSeenAt: chat.peer.lastSeenAt,
      })
    : null;

  const subtitle = useMemo(() => {
    if (typingIds.length > 0) return null; // The typing indicator replaces it.
    if (chat.type === 'group') {
      const online = chat.members.filter(
        (m) => presence[m.userId]?.online ?? m.user.online,
      ).length;
      return `${chat.members.length} member${chat.members.length === 1 ? '' : 's'}${
        online > 1 ? ` · ${online} online` : ''
      }`;
    }
    return formatLastSeen(peerPresence?.online ?? null, peerPresence?.lastSeenAt ?? null);
  }, [chat, presence, typingIds.length, peerPresence]);

  const rows = useMemo(() => buildRows(messages, people), [messages, people]);
  const pinnedMessages = messages.filter((m) =>
    chat.pinnedMessageIds.includes(m.record.id),
  );

  const canModerate = chat.type === 'group' && chat.myRole !== 'member';

  return (
    <div className="thread">
      <header className="thread-header">
        {isCompact ? (
          <IconButton label="Back to conversations" onClick={() => setMobilePane('list')}>
            <ChevronLeftIcon />
          </IconButton>
        ) : null}

        <button
          type="button"
          className="thread-identity"
          onClick={() => openOverlay({ kind: 'chat-info', chatId })}
        >
          <Avatar
            userId={chat.type === 'group' ? chat.id : (chat.peer?.id ?? chat.id)}
            name={title}
            url={chat.type === 'group' ? chat.avatarUrl : chat.peer?.avatarUrl}
            size={40}
            online={chat.type === 'direct' ? (peerPresence?.online ?? null) : null}
            shape={chat.type === 'group' ? 'rounded' : 'circle'}
          />
          <span className="thread-identity-text">
            <span className="thread-title">{title}</span>
            {typingIds.length > 0 ? (
              <TypingIndicator
                names={typingIds.map(
                  (id) => people[id]?.displayName.split(' ')[0] ?? 'Someone',
                )}
              />
            ) : subtitle ? (
              <span className="thread-subtitle">{subtitle}</span>
            ) : null}
          </span>
        </button>

        <div className="thread-actions">
          <IconButton
            label="Voice call"
            onClick={() => void startCall(chatId, 'audio')}
          >
            <PhoneIcon />
          </IconButton>
          <IconButton
            label="Video call"
            onClick={() => void startCall(chatId, 'video')}
          >
            <VideoIcon />
          </IconButton>
          <IconButton
            label="Search in conversation"
            onClick={() => openOverlay({ kind: 'search' })}
          >
            <SearchIcon />
          </IconButton>
          <div className="menu-anchor">
            <IconButton label="Conversation menu" onClick={() => setMenuOpen((v) => !v)}>
              <MoreIcon />
            </IconButton>
            <Menu
              open={menuOpen}
              onClose={() => setMenuOpen(false)}
              label="Conversation menu"
              items={[
                {
                  label: chat.type === 'group' ? 'Group info' : 'Contact info',
                  icon: chat.type === 'group' ? <UsersIcon size={16} /> : <InfoIcon size={16} />,
                  onSelect: () => openOverlay({ kind: 'chat-info', chatId }),
                },
                ...(chat.peer
                  ? [
                      {
                        label: 'Verify safety number',
                        icon: <ShieldCheckIcon size={16} />,
                        onSelect: () =>
                          openOverlay({ kind: 'safety-number', userId: chat.peer!.id }),
                      },
                    ]
                  : []),
                {
                  label: chat.muted ? 'Unmute' : 'Mute',
                  icon: chat.muted ? <BellIcon size={16} /> : <BellOffIcon size={16} />,
                  onSelect: () => void setChatSetting(chatId, { muted: !chat.muted }),
                },
                {
                  label: chat.pinned ? 'Unpin conversation' : 'Pin conversation',
                  icon: <PinIcon size={16} />,
                  onSelect: () => void setChatSetting(chatId, { pinned: !chat.pinned }),
                },
                {
                  label: chat.archived ? 'Unarchive' : 'Archive',
                  icon: <ArchiveIcon size={16} />,
                  onSelect: () => void setChatSetting(chatId, { archived: !chat.archived }),
                },
              ]}
            />
          </div>
        </div>
      </header>

      {pinnedMessages.length > 0 ? (
        <button
          type="button"
          className="pinned-banner"
          onClick={() => jumpToMessage(pinnedMessages[0]!.record.id)}
        >
          <PinIcon size={14} />
          <span className="pinned-banner-text">
            {pinnedMessages[0]!.content?.body
              ? truncate(pinnedMessages[0]!.content!.body, 70)
              : 'Pinned message'}
          </span>
          {pinnedMessages.length > 1 ? (
            <span className="pinned-banner-count">{pinnedMessages.length}</span>
          ) : null}
        </button>
      ) : null}

      <div
        ref={scrollRef}
        className="thread-scroll"
        onScroll={onScroll}
        role="log"
        aria-label={`Conversation with ${title}`}
        aria-live="polite"
      >
        {loading && messages.length === 0 ? (
          <ThreadSkeleton />
        ) : messages.length === 0 ? (
          <div className="thread-intro">
            <Avatar
              userId={chat.type === 'group' ? chat.id : (chat.peer?.id ?? chat.id)}
              name={title}
              url={chat.type === 'group' ? chat.avatarUrl : chat.peer?.avatarUrl}
              size={72}
              shape={chat.type === 'group' ? 'rounded' : 'circle'}
            />
            <h2 className="thread-intro-title">{title}</h2>
            <p className="thread-intro-note">
              <LockIcon size={13} />
              Messages here are end-to-end encrypted. Not even this server can read
              them.
            </p>
          </div>
        ) : (
          <>
            {cursor ? (
              <div className="thread-load-older">
                {loading ? (
                  <Spinner size={16} />
                ) : (
                  <button type="button" onClick={() => void loadOlder(chatId)}>
                    Load earlier messages
                  </button>
                )}
              </div>
            ) : (
              <div className="thread-start">
                <LockIcon size={13} />
                This is the beginning of your conversation
              </div>
            )}

            {rows.map((row) => {
              if (row.kind === 'day') {
                return (
                  <div className="day-separator" key={`day-${row.key}`}>
                    <span>{row.label}</span>
                  </div>
                );
              }
              if (row.kind === 'system') {
                return (
                  <div className="system-event" key={row.message.record.id}>
                    <span>{describeSystemEvent(row.message.record.system, people)}</span>
                  </div>
                );
              }

              const message = row.message;
              const mine = message.record.senderId === user?.id;
              const sender = people[message.record.senderId];
              const replyTarget = message.record.replyToId
                ? messages.find((m) => m.record.id === message.record.replyToId)
                : undefined;

              return (
                <div
                  key={message.record.id}
                  data-message-id={message.record.id}
                  data-highlighted={highlighted === message.record.id ? 'true' : undefined}
                  className="message-anchor"
                >
                  <MessageBubble
                    message={message}
                    mine={mine}
                    groupStart={row.groupStart}
                    groupEnd={row.groupEnd}
                    showSender={row.groupStart}
                    senderName={sender?.displayName ?? 'Unknown'}
                    senderAvatar={sender?.avatarUrl ?? null}
                    isGroup={chat.type === 'group'}
                    canDelete={mine || canModerate}
                    canPin={chat.type === 'direct' || canModerate}
                    pinned={chat.pinnedMessageIds.includes(message.record.id)}
                    replyPreview={
                      replyTarget
                        ? {
                            name:
                              people[replyTarget.record.senderId]?.displayName ??
                              'Unknown',
                            body: replyTarget.content?.body
                              ? truncate(replyTarget.content.body, 80)
                              : 'Attachment',
                          }
                        : null
                    }
                    onReply={() => setReplyingTo(message.record.id)}
                    onEdit={() => setEditing(message.record.id)}
                    onDelete={() =>
                      void deleteMessage(message.record.id).catch(() =>
                        toast('Could not delete that message', 'danger'),
                      )
                    }
                    onForward={() =>
                      openOverlay({ kind: 'forward', messageId: message.record.id })
                    }
                    onPin={() => void togglePin(chat, message.record.id, toast)}
                    onReact={(emoji) =>
                      void toggleReaction(message.record.id, emoji).catch(() =>
                        toast('Could not add that reaction', 'danger'),
                      )
                    }
                    onOpenImage={(attachments: PlaintextAttachment[], index: number) =>
                      openOverlay({ kind: 'image-viewer', attachments, index })
                    }
                    onJumpToReply={jumpToMessage}
                  />
                </div>
              );
            })}
          </>
        )}
        <div ref={bottomRef} />
      </div>

      <AnimatePresence>
        {!atBottom ? (
          <motion.button
            type="button"
            className="jump-to-latest"
            initial={{ opacity: 0, y: 12, scale: 0.9 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 8, scale: 0.92 }}
            onClick={() => {
              setAtBottom(true);
              bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
            }}
            aria-label="Jump to the latest message"
          >
            <ChevronDownIcon size={18} />
            {chat.unreadCount > 0 ? (
              <span className="jump-badge">{chat.unreadCount}</span>
            ) : null}
          </motion.button>
        ) : null}
      </AnimatePresence>

      <Composer chatId={chatId} />
    </div>
  );
}

async function togglePin(
  chat: { id: string; pinnedMessageIds: string[] },
  messageId: string,
  toast: (message: string, tone?: 'info' | 'success' | 'warning' | 'danger') => void,
): Promise<void> {
  const pinned = chat.pinnedMessageIds.includes(messageId);
  try {
    if (pinned) {
      await api.delete(`/api/chats/${chat.id}/pins/${messageId}`);
    } else {
      await api.post(`/api/chats/${chat.id}/pins/${messageId}`);
    }
  } catch {
    toast(pinned ? 'Could not unpin that message' : 'Could not pin that message', 'danger');
  }
}

type Row =
  | { kind: 'day'; key: string; label: string }
  | { kind: 'system'; message: DisplayMessage }
  | { kind: 'message'; message: DisplayMessage; groupStart: boolean; groupEnd: boolean };

/**
 * Turn a flat message list into rendered rows: day separators inserted, and
 * each message told whether it opens or closes a group.
 */
function buildRows(
  messages: readonly DisplayMessage[],
  _people: Record<string, unknown>,
): Row[] {
  const rows: Row[] = [];

  for (let i = 0; i < messages.length; i += 1) {
    const message = messages[i]!;
    const previous = messages[i - 1];
    const next = messages[i + 1];

    if (!previous || !sameDay(previous.record.createdAt, message.record.createdAt)) {
      rows.push({
        kind: 'day',
        key: message.record.createdAt,
        label: formatDaySeparator(message.record.createdAt),
      });
    }

    if (message.record.system) {
      rows.push({ kind: 'system', message });
      continue;
    }

    const time = new Date(message.record.createdAt).getTime();
    const groupStart =
      !previous ||
      previous.record.system !== null ||
      previous.record.senderId !== message.record.senderId ||
      time - new Date(previous.record.createdAt).getTime() > GROUP_WINDOW_MS ||
      !sameDay(previous.record.createdAt, message.record.createdAt);

    const groupEnd =
      !next ||
      next.record.system !== null ||
      next.record.senderId !== message.record.senderId ||
      new Date(next.record.createdAt).getTime() - time > GROUP_WINDOW_MS ||
      !sameDay(next.record.createdAt, message.record.createdAt);

    rows.push({ kind: 'message', message, groupStart, groupEnd });
  }

  return rows;
}
