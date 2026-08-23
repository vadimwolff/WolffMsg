/**
 * The local, decrypted message cache.
 *
 * Search is the reason this exists. The server holds only ciphertext, so it
 * cannot search message text — and asking it to would hand over exactly what
 * end-to-end encryption is meant to withhold. Instead every message this
 * device has opened is kept here, in IndexedDB, and search runs locally.
 *
 * The cache is destroyed on sign-out along with the key vault.
 */
import type { MessagePlaintext, MessageRecord } from '@wolffmsg/shared';
import {
  STORE_MESSAGES,
  idbDelete,
  idbGetAll,
  idbGetAllFromIndex,
  idbPut,
  idbPutMany,
} from '../lib/idb.ts';

export interface CachedMessage {
  id: string;
  chatId: string;
  senderId: string;
  createdAt: number;
  editedAt: number | null;
  /** Decrypted body. Empty for media-only messages. */
  body: string;
  /** Lower-cased body, stored so search does not re-normalise on every query. */
  search: string;
  hasAttachments: boolean;
  isVoice: boolean;
  replyToId: string | null;
}

export async function cacheMessage(
  record: MessageRecord,
  plaintext: MessagePlaintext,
): Promise<CachedMessage> {
  const entry: CachedMessage = {
    id: record.id,
    chatId: record.chatId,
    senderId: record.senderId,
    createdAt: new Date(record.createdAt).getTime(),
    editedAt: record.editedAt ? new Date(record.editedAt).getTime() : null,
    body: plaintext.body,
    search: plaintext.body.toLowerCase(),
    hasAttachments: (plaintext.attachments?.length ?? 0) > 0,
    isVoice: Boolean(plaintext.voice),
    replyToId: plaintext.replyToId ?? null,
  };
  await idbPut(STORE_MESSAGES, entry);
  return entry;
}

export async function cacheMany(entries: CachedMessage[]): Promise<void> {
  await idbPutMany(STORE_MESSAGES, entries);
}

export async function forgetMessage(messageId: string): Promise<void> {
  await idbDelete(STORE_MESSAGES, messageId).catch(() => undefined);
}

export interface SearchHit {
  message: CachedMessage;
  /** Character offset of the match, so the UI can show it in context. */
  offset: number;
}

/**
 * Search decrypted history on this device.
 *
 * Deliberately simple substring matching: an inverted index would be faster
 * but would also mean storing a token map, which is one more artefact to leak
 * if the device is compromised. Message volumes where this becomes slow are
 * well past what a single conversation holds.
 */
export async function searchMessages(
  query: string,
  options: { chatId?: string; limit?: number } = {},
): Promise<SearchHit[]> {
  const needle = query.trim().toLowerCase();
  if (needle.length < 2) return [];

  const limit = options.limit ?? 50;
  const candidates = options.chatId
    ? await messagesInChat(options.chatId)
    : await allMessages();

  const hits: SearchHit[] = [];
  for (const message of candidates) {
    const offset = message.search.indexOf(needle);
    if (offset === -1) continue;
    hits.push({ message, offset });
    if (hits.length >= limit) break;
  }

  return hits.sort((a, b) => b.message.createdAt - a.message.createdAt);
}

async function allMessages(): Promise<CachedMessage[]> {
  const rows = await idbGetAll<CachedMessage>(STORE_MESSAGES);
  return rows.sort((a, b) => b.createdAt - a.createdAt);
}

export async function messagesInChat(chatId: string): Promise<CachedMessage[]> {
  const rows = await idbGetAllFromIndex<CachedMessage>(
    STORE_MESSAGES,
    'byChatTime',
    IDBKeyRange.bound([chatId, -Infinity], [chatId, Infinity]),
  );
  return rows.sort((a, b) => b.createdAt - a.createdAt);
}

/** In-memory view of decrypted bodies, keyed by message id. */
const memory = new Map<string, MessagePlaintext>();

export function rememberPlaintext(id: string, plaintext: MessagePlaintext): void {
  memory.set(id, plaintext);
  // Bound the working set; the durable copy lives in IndexedDB.
  if (memory.size > 5_000) {
    const oldest = memory.keys().next().value;
    if (oldest !== undefined) memory.delete(oldest);
  }
}

export function recallPlaintext(id: string): MessagePlaintext | undefined {
  return memory.get(id);
}

export function dropPlaintext(id: string): void {
  memory.delete(id);
}

export function clearMemory(): void {
  memory.clear();
}
