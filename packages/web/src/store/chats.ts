/**
 * Conversation state.
 *
 * This store owns the decryption pipeline: a `MessageRecord` arrives from the
 * server as ciphertext, is opened here, and only the resulting `DisplayMessage`
 * ever reaches a component. It also owns the outbox, which is what makes the
 * app usable when the network drops.
 */
import { create } from 'zustand';
import {
  randomId,
  type ChatSummary,
  type MessagePlaintext,
  type MessageRecord,
  type MessageStatus,
  type Paginated,
  type PlaintextAttachment,
  type PublicUser,
  type ServerEvent,
} from '@wolffmsg/shared';
import { api, ApiError, NetworkError } from '../lib/api.ts';
import { realtime } from '../lib/socket.ts';
import { decryptRecord, encryptOutgoing, type DecryptOutcome } from '../crypto/session.ts';
import {
  cacheMessage,
  forgetMessage,
  rememberPlaintext,
  recallPlaintext,
} from '../crypto/messageCache.ts';
import { STORE_OUTBOX, idbDelete, idbGetAll, idbPut } from '../lib/idb.ts';
import { useSession } from './session.ts';

/** A message as the UI renders it: metadata plus whatever we could decrypt. */
export interface DisplayMessage {
  record: MessageRecord;
  /** `null` while decryption has not been attempted or could not succeed. */
  content: MessagePlaintext | null;
  /** Why the content is missing, when it is. */
  problem:
    | 'none'
    | 'not-for-this-device'
    | 'key-gone'
    | 'identity-changed'
    | 'tampered'
    | 'error';
  status: MessageStatus | 'failed';
  /** Set for a message still in the outbox. */
  pendingClientId?: string;
}

/** A message composed locally that has not been accepted by the server yet. */
interface OutboxEntry {
  clientId: string;
  messageId: string;
  chatId: string;
  createdAt: number;
  plaintext: MessagePlaintext;
  attachmentIds: string[];
  attempts: number;
  lastError: string | null;
}

interface ChatState {
  chats: ChatSummary[];
  activeChatId: string | null;
  messages: Record<string, DisplayMessage[]>;
  /** Cursor for loading older history, per chat. `null` = start reached. */
  cursors: Record<string, string | null>;
  loadingChats: boolean;
  loadingHistory: Record<string, boolean>;
  typing: Record<string, string[]>;
  presence: Record<string, { online: boolean; lastSeenAt: string | null }>;
  outbox: OutboxEntry[];
  /** Users seen in this session, for rendering names without a refetch. */
  people: Record<string, PublicUser>;

  loadChats: () => Promise<void>;
  openChat: (chatId: string | null) => Promise<void>;
  loadOlder: (chatId: string) => Promise<void>;
  sendMessage: (
    chatId: string,
    input: {
      body: string;
      attachments?: PlaintextAttachment[];
      replyToId?: string;
      voice?: { durationMs: number; waveform: number[] };
      forwardedFrom?: MessagePlaintext['forwardedFrom'];
    },
  ) => Promise<void>;
  retryOutbox: () => Promise<void>;
  discardOutboxEntry: (clientId: string) => Promise<void>;
  editMessage: (chatId: string, messageId: string, body: string) => Promise<void>;
  deleteMessage: (messageId: string) => Promise<void>;
  toggleReaction: (messageId: string, emoji: string) => Promise<void>;
  markRead: (chatId: string, messageIds: string[]) => void;
  setChatSetting: (
    chatId: string,
    patch: { pinned?: boolean; muted?: boolean; archived?: boolean },
  ) => Promise<void>;
  handleEvent: (event: ServerEvent) => void;
  reset: () => void;
}

const PAGE_SIZE = 50;

/**
 * Stable empty collections.
 *
 * Zustand compares selector results by reference, so a selector that falls
 * back to a fresh `[]` reports a change on every render and drives an infinite
 * update loop. Every "this key is absent" path resolves to one of these.
 */
export const NO_MESSAGES: readonly DisplayMessage[] = Object.freeze([]);
export const NO_IDS: readonly string[] = Object.freeze([]);

/** Decrypt a record and fold it into the display shape. */
async function toDisplay(record: MessageRecord): Promise<DisplayMessage> {
  const cached = recallPlaintext(record.id);
  if (cached && !record.editedAt) {
    return { record, content: cached, problem: 'none', status: statusOf(record) };
  }

  const outcome: DecryptOutcome = await decryptRecord(record);

  switch (outcome.status) {
    case 'ok':
      rememberPlaintext(record.id, outcome.plaintext);
      void cacheMessage(record, outcome.plaintext);
      return {
        record,
        content: outcome.plaintext,
        problem: 'none',
        status: statusOf(record),
      };
    case 'system':
    case 'deleted':
      return { record, content: null, problem: 'none', status: statusOf(record) };
    case 'not-for-this-device':
      return {
        record,
        content: null,
        problem: 'not-for-this-device',
        status: statusOf(record),
      };
    case 'key-gone':
      return { record, content: null, problem: 'key-gone', status: statusOf(record) };
    case 'identity-changed':
      return {
        record,
        content: null,
        problem: 'identity-changed',
        status: statusOf(record),
      };
    case 'tampered':
      return { record, content: null, problem: 'tampered', status: statusOf(record) };
    default:
      return { record, content: null, problem: 'error', status: statusOf(record) };
  }
}

/**
 * Derive the delivery state a sender sees.
 *
 * "Read" wins over "delivered": once anyone has read it, showing the lesser
 * state would be misleading.
 */
function statusOf(record: MessageRecord): MessageStatus {
  if (record.readBy.length > 0) return 'read';
  if (record.deliveredTo.length > 0) return 'delivered';
  return 'sent';
}

function sortMessages(list: DisplayMessage[]): DisplayMessage[] {
  return [...list].sort((a, b) => {
    const at = new Date(a.record.createdAt).getTime();
    const bt = new Date(b.record.createdAt).getTime();
    if (at !== bt) return at - bt;
    return a.record.id < b.record.id ? -1 : 1;
  });
}

function mergeMessage(
  existing: DisplayMessage[],
  incoming: DisplayMessage,
): DisplayMessage[] {
  const index = existing.findIndex((m) => m.record.id === incoming.record.id);
  if (index === -1) return sortMessages([...existing, incoming]);
  const next = [...existing];
  next[index] = incoming;
  return next;
}

export const useChats = create<ChatState>((set, get) => ({
  chats: [],
  activeChatId: null,
  messages: {},
  cursors: {},
  loadingChats: false,
  loadingHistory: {},
  typing: {},
  presence: {},
  outbox: [],
  people: {},

  loadChats: async () => {
    set({ loadingChats: true });
    try {
      const response = await api.get<{ chats: ChatSummary[] }>('/api/chats');

      // Cache everyone we can see, so a name is never missing mid-render.
      const people = { ...get().people };
      for (const chat of response.chats) {
        for (const member of chat.members) people[member.user.id] = member.user;
        if (chat.peer) people[chat.peer.id] = chat.peer;
      }

      set({ chats: response.chats, people, loadingChats: false });

      // Watch presence for everyone we share a conversation with.
      const userIds = [...new Set(Object.keys(people))];
      if (userIds.length > 0) {
        realtime.send({ t: 'presence:subscribe', userIds });
      }

      // Decrypt the last message of each chat so the list preview is readable.
      await Promise.all(
        response.chats.map(async (chat) => {
          if (!chat.lastMessage?.envelope) return;
          await toDisplay(chat.lastMessage);
        }),
      );
      set({ chats: [...get().chats] });
    } catch {
      set({ loadingChats: false });
    }
  },

  openChat: async (chatId) => {
    set({ activeChatId: chatId });
    if (!chatId) return;

    const already = get().messages[chatId];
    if (already && already.length > 0) {
      get().markRead(
        chatId,
        already.slice(-30).map((m) => m.record.id),
      );
      return;
    }

    set({ loadingHistory: { ...get().loadingHistory, [chatId]: true } });
    try {
      const page = await api.get<Paginated<MessageRecord>>(
        `/api/chats/${encodeURIComponent(chatId)}/messages?limit=${PAGE_SIZE}`,
      );
      const decrypted = await Promise.all(page.items.map(toDisplay));

      set({
        messages: { ...get().messages, [chatId]: sortMessages(decrypted) },
        cursors: { ...get().cursors, [chatId]: page.nextCursor },
        loadingHistory: { ...get().loadingHistory, [chatId]: false },
      });

      const ids = decrypted.map((m) => m.record.id);
      if (ids.length > 0) {
        realtime.send({ t: 'message:delivered', chatId, messageIds: ids });
        get().markRead(chatId, ids);
      }
    } catch {
      set({ loadingHistory: { ...get().loadingHistory, [chatId]: false } });
    }
  },

  loadOlder: async (chatId) => {
    const cursor = get().cursors[chatId];
    if (cursor === null || cursor === undefined) return;
    if (get().loadingHistory[chatId]) return;

    set({ loadingHistory: { ...get().loadingHistory, [chatId]: true } });
    try {
      const page = await api.get<Paginated<MessageRecord>>(
        `/api/chats/${encodeURIComponent(chatId)}/messages` +
          `?limit=${PAGE_SIZE}&before=${encodeURIComponent(cursor)}`,
      );
      const decrypted = await Promise.all(page.items.map(toDisplay));
      const existing = get().messages[chatId] ?? [];
      const known = new Set(existing.map((m) => m.record.id));

      set({
        messages: {
          ...get().messages,
          [chatId]: sortMessages([
            ...decrypted.filter((m) => !known.has(m.record.id)),
            ...existing,
          ]),
        },
        cursors: { ...get().cursors, [chatId]: page.nextCursor },
        loadingHistory: { ...get().loadingHistory, [chatId]: false },
      });
    } catch {
      set({ loadingHistory: { ...get().loadingHistory, [chatId]: false } });
    }
  },

  sendMessage: async (chatId, input) => {
    const user = useSession.getState().user;
    if (!user) return;

    const messageId = randomId(16);
    const clientId = randomId(12);
    const createdAt = Date.now();

    const plaintext: MessagePlaintext = {
      v: 1,
      body: input.body,
      ...(input.attachments?.length ? { attachments: input.attachments } : {}),
      ...(input.replyToId ? { replyToId: input.replyToId } : {}),
      ...(input.voice ? { voice: input.voice } : {}),
      ...(input.forwardedFrom ? { forwardedFrom: input.forwardedFrom } : {}),
    };

    const entry: OutboxEntry = {
      clientId,
      messageId,
      chatId,
      createdAt,
      plaintext,
      attachmentIds: (input.attachments ?? []).map((a) => a.id),
      attempts: 0,
      lastError: null,
    };

    // Show it immediately, marked `sending`, so composing feels instant even
    // on a slow link.
    const optimistic: DisplayMessage = {
      record: {
        id: messageId,
        chatId,
        senderId: user.id,
        senderDeviceId: useSession.getState().deviceId ?? '',
        createdAt: new Date(createdAt).toISOString(),
        editedAt: null,
        deletedAt: null,
        envelope: null,
        system: null,
        reactions: [],
        attachments: [],
        deliveredTo: [],
        readBy: [],
        pinned: false,
        clientId,
        replyToId: input.replyToId ?? null,
      },
      content: plaintext,
      problem: 'none',
      status: 'sending',
      pendingClientId: clientId,
    };

    rememberPlaintext(messageId, plaintext);
    set({
      messages: {
        ...get().messages,
        [chatId]: mergeMessage(get().messages[chatId] ?? [], optimistic),
      },
      outbox: [...get().outbox, entry],
    });
    await idbPut(STORE_OUTBOX, entry).catch(() => undefined);

    await deliverOutboxEntry(entry, set, get);
  },

  retryOutbox: async () => {
    // Load anything persisted from a previous session before retrying.
    const stored = await idbGetAll<OutboxEntry>(STORE_OUTBOX).catch(() => []);
    const known = new Set(get().outbox.map((e) => e.clientId));
    const merged = [...get().outbox, ...stored.filter((e) => !known.has(e.clientId))];
    set({ outbox: merged });

    for (const entry of merged) {
      await deliverOutboxEntry(entry, set, get);
    }
  },

  discardOutboxEntry: async (clientId) => {
    const entry = get().outbox.find((e) => e.clientId === clientId);
    set({ outbox: get().outbox.filter((e) => e.clientId !== clientId) });
    await idbDelete(STORE_OUTBOX, clientId).catch(() => undefined);

    if (entry) {
      const list = get().messages[entry.chatId] ?? [];
      set({
        messages: {
          ...get().messages,
          [entry.chatId]: list.filter((m) => m.record.id !== entry.messageId),
        },
      });
    }
  },

  editMessage: async (chatId, messageId, body) => {
    const user = useSession.getState().user;
    if (!user) return;

    const existing = (get().messages[chatId] ?? []).find(
      (m) => m.record.id === messageId,
    );
    if (!existing) return;

    const plaintext: MessagePlaintext = {
      ...(existing.content ?? { v: 1, body: '' }),
      body,
    };

    // The AAD is bound to the original id and timestamp, so an edit must
    // re-encrypt against exactly those values.
    const { envelope } = await encryptOutgoing(
      chatId,
      messageId,
      new Date(existing.record.createdAt).getTime(),
      user.id,
      plaintext,
    );

    const response = await api.patch<{ message: MessageRecord }>(
      `/api/messages/${encodeURIComponent(messageId)}`,
      { envelope },
    );

    rememberPlaintext(messageId, plaintext);
    const updated = await toDisplay(response.message);
    set({
      messages: {
        ...get().messages,
        [chatId]: mergeMessage(get().messages[chatId] ?? [], updated),
      },
    });
  },

  deleteMessage: async (messageId) => {
    await api.delete(`/api/messages/${encodeURIComponent(messageId)}`);
    await forgetMessage(messageId);
  },

  toggleReaction: async (messageId, emoji) => {
    await api.post(`/api/messages/${encodeURIComponent(messageId)}/reactions`, {
      emoji,
    });
  },

  markRead: (chatId, messageIds) => {
    if (messageIds.length === 0) return;
    realtime.send({ t: 'message:read', chatId, messageIds });

    // Clear the badge straight away rather than waiting for the round trip.
    set({
      chats: get().chats.map((chat) =>
        chat.id === chatId ? { ...chat, unreadCount: 0 } : chat,
      ),
    });
  },

  setChatSetting: async (chatId, patch) => {
    const previous = get().chats;
    set({
      chats: previous.map((chat) =>
        chat.id === chatId ? { ...chat, ...patch } : chat,
      ),
    });
    try {
      await api.patch(`/api/chats/${encodeURIComponent(chatId)}/membership`, patch);
    } catch {
      set({ chats: previous });
    }
  },

  handleEvent: (event) => {
    void handleServerEvent(event, set, get);
  },

  reset: () =>
    set({
      chats: [],
      activeChatId: null,
      messages: {},
      cursors: {},
      typing: {},
      presence: {},
      outbox: [],
      people: {},
    }),
}));

type Setter = (partial: Partial<ChatState>) => void;
type Getter = () => ChatState;

/**
 * Encrypt and post one outbox entry.
 *
 * A network failure leaves the entry queued and the bubble marked `failed`;
 * the idempotency key means a retry can never produce a duplicate, so retrying
 * is always safe.
 */
async function deliverOutboxEntry(
  entry: OutboxEntry,
  set: Setter,
  get: Getter,
): Promise<void> {
  const user = useSession.getState().user;
  if (!user) return;

  const markFailed = (message: string) => {
    const list = get().messages[entry.chatId] ?? [];
    set({
      messages: {
        ...get().messages,
        [entry.chatId]: list.map((m) =>
          m.record.id === entry.messageId ? { ...m, status: 'failed' as const } : m,
        ),
      },
      outbox: get().outbox.map((e) =>
        e.clientId === entry.clientId
          ? { ...e, attempts: e.attempts + 1, lastError: message }
          : e,
      ),
    });
  };

  try {
    const { envelope } = await encryptOutgoing(
      entry.chatId,
      entry.messageId,
      entry.createdAt,
      user.id,
      entry.plaintext,
    );

    const response = await api.post<{ message: MessageRecord }>(
      `/api/chats/${encodeURIComponent(entry.chatId)}/messages`,
      {
        id: entry.messageId,
        clientId: entry.clientId,
        createdAt: entry.createdAt,
        envelope,
        replyToId: entry.plaintext.replyToId ?? null,
        attachmentIds: entry.attachmentIds,
      },
    );

    rememberPlaintext(entry.messageId, entry.plaintext);
    void cacheMessage(response.message, entry.plaintext);

    set({
      messages: {
        ...get().messages,
        [entry.chatId]: mergeMessage(get().messages[entry.chatId] ?? [], {
          record: response.message,
          content: entry.plaintext,
          problem: 'none',
          status: statusOf(response.message),
        }),
      },
      outbox: get().outbox.filter((e) => e.clientId !== entry.clientId),
    });
    await idbDelete(STORE_OUTBOX, entry.clientId).catch(() => undefined);
  } catch (err) {
    if (err instanceof NetworkError) {
      markFailed('Offline — will retry');
      return;
    }
    if (err instanceof ApiError) {
      // A 4xx other than rate limiting will never succeed on retry, so the
      // entry is dropped rather than queued forever.
      if (err.status >= 400 && err.status < 500 && !err.isRateLimited) {
        markFailed(err.message);
        set({ outbox: get().outbox.filter((e) => e.clientId !== entry.clientId) });
        await idbDelete(STORE_OUTBOX, entry.clientId).catch(() => undefined);
        return;
      }
      markFailed(err.message);
      return;
    }
    markFailed('Could not send');
  }
}

/** Fold a realtime event into local state. */
async function handleServerEvent(
  event: ServerEvent,
  set: Setter,
  get: Getter,
): Promise<void> {
  switch (event.t) {
    case 'message:new': {
      const record = event.message;
      // Our own optimistic copy already stands in for this one.
      const existing = (get().messages[record.chatId] ?? []).find(
        (m) => m.record.id === record.id,
      );
      const display = await toDisplay(record);

      set({
        messages: {
          ...get().messages,
          [record.chatId]: mergeMessage(get().messages[record.chatId] ?? [], display),
        },
      });

      const isActive = get().activeChatId === record.chatId;
      const isMine = record.senderId === useSession.getState().user?.id;

      set({
        chats: get().chats.map((chat) =>
          chat.id === record.chatId
            ? {
                ...chat,
                lastMessage: record,
                updatedAt: record.createdAt,
                unreadCount:
                  isActive || isMine ? chat.unreadCount : chat.unreadCount + 1,
              }
            : chat,
        ),
      });

      if (!isMine) {
        realtime.send({
          t: 'message:delivered',
          chatId: record.chatId,
          messageIds: [record.id],
        });
        if (isActive && document.visibilityState === 'visible') {
          get().markRead(record.chatId, [record.id]);
        }
      }
      void existing;
      return;
    }

    case 'message:updated': {
      const display = await toDisplay(event.message);
      set({
        messages: {
          ...get().messages,
          [event.message.chatId]: mergeMessage(
            get().messages[event.message.chatId] ?? [],
            display,
          ),
        },
      });
      return;
    }

    case 'message:deleted': {
      const list = get().messages[event.chatId] ?? [];
      set({
        messages: {
          ...get().messages,
          [event.chatId]: list.map((m) =>
            m.record.id === event.messageId
              ? {
                  ...m,
                  content: null,
                  record: { ...m.record, deletedAt: event.deletedAt, envelope: null },
                }
              : m,
          ),
        },
      });
      void forgetMessage(event.messageId);
      return;
    }

    case 'message:reaction': {
      const list = get().messages[event.chatId] ?? [];
      set({
        messages: {
          ...get().messages,
          [event.chatId]: list.map((m) =>
            m.record.id === event.messageId
              ? { ...m, record: { ...m.record, reactions: event.reactions } }
              : m,
          ),
        },
      });
      return;
    }

    case 'message:delivered':
    case 'message:read': {
      const isRead = event.t === 'message:read';
      const list = get().messages[event.chatId] ?? [];
      const ids = new Set(event.messageIds);
      set({
        messages: {
          ...get().messages,
          [event.chatId]: list.map((m) => {
            if (!ids.has(m.record.id)) return m;
            const record = isRead
              ? { ...m.record, readBy: [...new Set([...m.record.readBy, event.userId])] }
              : {
                  ...m.record,
                  deliveredTo: [...new Set([...m.record.deliveredTo, event.userId])],
                };
            return { ...m, record, status: statusOf(record) };
          }),
        },
      });
      return;
    }

    case 'typing:start': {
      const current = get().typing[event.chatId] ?? [];
      if (current.includes(event.userId)) return;
      set({
        typing: { ...get().typing, [event.chatId]: [...current, event.userId] },
      });
      // Indicators expire on their own; a missed `stop` must not strand one.
      window.setTimeout(() => {
        const now = useChats.getState().typing[event.chatId] ?? [];
        useChats.setState({
          typing: {
            ...useChats.getState().typing,
            [event.chatId]: now.filter((id) => id !== event.userId),
          },
        });
      }, 6_000);
      return;
    }

    case 'typing:stop': {
      const current = get().typing[event.chatId] ?? [];
      set({
        typing: {
          ...get().typing,
          [event.chatId]: current.filter((id) => id !== event.userId),
        },
      });
      return;
    }

    case 'presence:update': {
      set({
        presence: {
          ...get().presence,
          [event.userId]: { online: event.online, lastSeenAt: event.lastSeenAt },
        },
      });
      return;
    }

    case 'chat:update': {
      const chats = get().chats;
      const index = chats.findIndex((c) => c.id === event.chat.id);
      const people = { ...get().people };
      for (const member of event.chat.members) people[member.user.id] = member.user;
      if (event.chat.peer) people[event.chat.peer.id] = event.chat.peer;

      set({
        chats: index === -1 ? [event.chat, ...chats] : chats.map((c, i) => (i === index ? event.chat : c)),
        people,
      });
      return;
    }

    case 'chat:removed': {
      const { [event.chatId]: _removed, ...messages } = get().messages;
      set({
        chats: get().chats.filter((c) => c.id !== event.chatId),
        messages,
        activeChatId: get().activeChatId === event.chatId ? null : get().activeChatId,
      });
      return;
    }

    case 'chat:pinned': {
      set({
        chats: get().chats.map((chat) =>
          chat.id === event.chatId
            ? { ...chat, pinnedMessageIds: event.messageIds }
            : chat,
        ),
      });
      return;
    }

    default:
      return;
  }
}

/** Wire the socket into the store, once, at app start. */
export function connectChatEvents(): () => void {
  const off = realtime.on((event) => useChats.getState().handleEvent(event));
  const offState = realtime.onStateChange((state) => {
    // Anything queued while offline goes out as soon as we are back.
    if (state === 'online') void useChats.getState().retryOutbox();
  });
  return () => {
    off();
    offState();
  };
}
