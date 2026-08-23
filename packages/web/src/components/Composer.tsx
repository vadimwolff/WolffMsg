/**
 * The message composer.
 *
 * Handles four modes without becoming four components: plain text, replying,
 * editing, and voice recording. Attachments are encrypted and uploaded as soon
 * as they are chosen, so pressing send is instant even for a large file.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { LIMITS, type PlaintextAttachment } from '@wolffmsg/shared';
import { IconButton, Spinner } from './primitives.tsx';
import {
  AlertIcon,
  CloseIcon,
  EditIcon,
  MicIcon,
  PaperclipIcon,
  ReplyIcon,
  SendIcon,
  SmileIcon,
  TrashIcon,
} from './icons.tsx';
import { EmojiPicker } from './EmojiPicker.tsx';
import { VoiceRecorder } from './VoiceRecorder.tsx';
import {
  formatBytes,
  imageDimensions,
  uploadAttachment,
  type AttachmentUpload,
} from '../crypto/attachments.ts';
import { TypingSignal } from '../lib/socket.ts';
import { NO_MESSAGES, useChats } from '../store/chats.ts';
import { useSession } from '../store/session.ts';
import { useUi } from '../store/ui.ts';
import { truncate } from '../lib/format.ts';

interface Pending {
  id: string;
  file: File;
  progress: number;
  phase: 'encrypting' | 'uploading' | 'done' | 'error';
  descriptor: PlaintextAttachment | null;
  handle: AttachmentUpload | null;
  error: string | null;
}

let pendingSeq = 0;

export function Composer({ chatId }: { chatId: string }) {
  const sendMessage = useChats((s) => s.sendMessage);
  const editMessage = useChats((s) => s.editMessage);
  const messages = useChats((s) => s.messages[chatId] ?? NO_MESSAGES);
  const chat = useChats((s) => s.chats.find((c) => c.id === chatId));
  const people = useChats((s) => s.people);
  const config = useSession((s) => s.config);

  const replyingTo = useUi((s) => s.replyingTo);
  const editing = useUi((s) => s.editing);
  const setReplyingTo = useUi((s) => s.setReplyingTo);
  const setEditing = useUi((s) => s.setEditing);
  const toast = useUi((s) => s.toast);

  const [text, setText] = useState('');
  const [pending, setPending] = useState<Pending[]>([]);
  const [emojiOpen, setEmojiOpen] = useState(false);
  const [recording, setRecording] = useState(false);
  const [sending, setSending] = useState(false);
  const [dragging, setDragging] = useState(false);

  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const typingRef = useRef<TypingSignal | null>(null);

  useEffect(() => {
    typingRef.current = new TypingSignal(chatId);
    return () => typingRef.current?.stop();
  }, [chatId]);

  // Load the original text when an edit starts.
  useEffect(() => {
    if (!editing) return;
    const target = messages.find((m) => m.record.id === editing);
    setText(target?.content?.body ?? '');
    textareaRef.current?.focus();
  }, [editing, messages]);

  // Grow the textarea with its content, up to a ceiling.
  const resize = useCallback(() => {
    const node = textareaRef.current;
    if (!node) return;
    node.style.height = 'auto';
    node.style.height = `${Math.min(node.scrollHeight, 200)}px`;
  }, []);

  useEffect(resize, [text, resize]);

  const replyTarget = replyingTo
    ? messages.find((m) => m.record.id === replyingTo)
    : undefined;

  const readOnly =
    chat?.type === 'group' && chat.readOnlyForMembers && chat.myRole === 'member';

  const uploading = pending.some((p) => p.phase !== 'done' && p.phase !== 'error');
  const ready = pending.filter((p) => p.descriptor).map((p) => p.descriptor!);
  const canSend = (text.trim().length > 0 || ready.length > 0) && !uploading && !sending;

  async function attachFiles(files: FileList | File[]) {
    const list = [...files];
    const limit = config?.maxAttachmentBytes ?? 100 * 1024 * 1024;

    for (const file of list.slice(0, 10)) {
      if (file.size > limit) {
        toast(`${truncate(file.name, 30)} is larger than ${formatBytes(limit)}`, 'warning');
        continue;
      }

      pendingSeq += 1;
      const id = `pending-${pendingSeq}`;
      const dimensions = await imageDimensions(file);

      const entry: Pending = {
        id,
        file,
        progress: 0,
        phase: 'encrypting',
        descriptor: null,
        handle: null,
        error: null,
      };
      setPending((prev) => [...prev, entry]);

      const handle = uploadAttachment(
        file,
        chatId,
        (progress) =>
          setPending((prev) =>
            prev.map((p) =>
              p.id === id ? { ...p, progress: progress.fraction, phase: progress.phase } : p,
            ),
          ),
        dimensions ?? {},
      );
      setPending((prev) => prev.map((p) => (p.id === id ? { ...p, handle } : p)));

      handle.promise
        .then((prepared) =>
          setPending((prev) =>
            prev.map((p) =>
              p.id === id
                ? { ...p, descriptor: prepared.descriptor, phase: 'done', progress: 1 }
                : p,
            ),
          ),
        )
        .catch((err: Error) => {
          if (err.name === 'AbortError') {
            setPending((prev) => prev.filter((p) => p.id !== id));
            return;
          }
          setPending((prev) =>
            prev.map((p) =>
              p.id === id ? { ...p, phase: 'error', error: err.message } : p,
            ),
          );
        });
    }
  }

  async function submit() {
    if (!canSend) return;
    setSending(true);
    typingRef.current?.stop();

    try {
      if (editing) {
        await editMessage(chatId, editing, text.trim());
        setEditing(null);
      } else {
        await sendMessage(chatId, {
          body: text.trim(),
          ...(ready.length > 0 ? { attachments: ready } : {}),
          ...(replyingTo ? { replyToId: replyingTo } : {}),
        });
        setReplyingTo(null);
      }
      setText('');
      setPending([]);
    } catch {
      toast(editing ? 'Could not save that edit' : 'Could not send that message', 'danger');
    } finally {
      setSending(false);
      textareaRef.current?.focus();
    }
  }

  async function sendVoice(blob: Blob, durationMs: number, waveform: number[]) {
    const file = new File([blob], 'voice-message.webm', { type: blob.type });
    const handle = uploadAttachment(file, chatId);
    try {
      const prepared = await handle.promise;
      await sendMessage(chatId, {
        body: '',
        attachments: [{ ...prepared.descriptor, durationMs }],
        voice: { durationMs, waveform },
        ...(replyingTo ? { replyToId: replyingTo } : {}),
      });
      setReplyingTo(null);
    } catch {
      toast('Could not send that voice message', 'danger');
    } finally {
      setRecording(false);
    }
  }

  if (readOnly) {
    return (
      <div className="composer composer-readonly">
        <AlertIcon size={16} />
        Only admins can post in this group.
      </div>
    );
  }

  if (recording) {
    return (
      <VoiceRecorder
        onCancel={() => setRecording(false)}
        onSend={(blob, duration, waveform) => void sendVoice(blob, duration, waveform)}
      />
    );
  }

  return (
    <div
      className="composer"
      data-dragging={dragging || undefined}
      onDragOver={(event) => {
        event.preventDefault();
        setDragging(true);
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={(event) => {
        event.preventDefault();
        setDragging(false);
        if (event.dataTransfer.files.length > 0) {
          void attachFiles(event.dataTransfer.files);
        }
      }}
    >
      <AnimatePresence>
        {replyTarget ? (
          <motion.div
            className="composer-context"
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: 'auto' }}
            exit={{ opacity: 0, height: 0 }}
          >
            <ReplyIcon size={15} />
            <span className="composer-context-body">
              <strong>
                {people[replyTarget.record.senderId]?.displayName ?? 'Unknown'}
              </strong>
              <span>
                {replyTarget.content?.body
                  ? truncate(replyTarget.content.body, 70)
                  : 'Attachment'}
              </span>
            </span>
            <IconButton label="Cancel reply" size="sm" onClick={() => setReplyingTo(null)}>
              <CloseIcon size={14} />
            </IconButton>
          </motion.div>
        ) : editing ? (
          <motion.div
            className="composer-context"
            data-mode="edit"
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: 'auto' }}
            exit={{ opacity: 0, height: 0 }}
          >
            <EditIcon size={15} />
            <span className="composer-context-body">
              <strong>Editing message</strong>
            </span>
            <IconButton
              label="Cancel edit"
              size="sm"
              onClick={() => {
                setEditing(null);
                setText('');
              }}
            >
              <CloseIcon size={14} />
            </IconButton>
          </motion.div>
        ) : null}
      </AnimatePresence>

      {pending.length > 0 ? (
        <div className="composer-attachments">
          {pending.map((item) => (
            <div key={item.id} className="attachment-chip" data-phase={item.phase}>
              <span className="attachment-chip-name">{truncate(item.file.name, 22)}</span>
              <span className="attachment-chip-size">{formatBytes(item.file.size)}</span>
              {item.phase === 'error' ? (
                <span className="attachment-chip-error">{item.error}</span>
              ) : item.phase !== 'done' ? (
                <span
                  className="attachment-chip-progress"
                  style={{ width: `${Math.round(item.progress * 100)}%` }}
                />
              ) : null}
              <IconButton
                label={`Remove ${item.file.name}`}
                size="sm"
                onClick={() => {
                  item.handle?.cancel();
                  setPending((prev) => prev.filter((p) => p.id !== item.id));
                }}
              >
                {item.phase === 'done' || item.phase === 'error' ? (
                  <TrashIcon size={13} />
                ) : (
                  <CloseIcon size={13} />
                )}
              </IconButton>
            </div>
          ))}
        </div>
      ) : null}

      <div className="composer-bar">
        <IconButton
          label="Attach a file"
          onClick={() => fileInputRef.current?.click()}
          disabled={sending}
        >
          <PaperclipIcon />
        </IconButton>
        <input
          ref={fileInputRef}
          type="file"
          multiple
          className="sr-only"
          onChange={(event) => {
            if (event.target.files) void attachFiles(event.target.files);
            event.target.value = '';
          }}
        />

        <div className="composer-input-wrap">
          <textarea
            ref={textareaRef}
            className="composer-input"
            placeholder={editing ? 'Edit your message' : 'Message'}
            rows={1}
            value={text}
            maxLength={LIMITS.messageBodyMax}
            aria-label="Message"
            onChange={(event) => {
              setText(event.target.value);
              if (event.target.value) typingRef.current?.keyPress();
            }}
            onKeyDown={(event) => {
              // Enter sends; Shift+Enter is a newline. On a touch device Enter
              // must always be a newline, since there is no Shift to hold.
              if (event.key === 'Enter' && !event.shiftKey && !isTouchDevice()) {
                event.preventDefault();
                void submit();
              }
              if (event.key === 'Escape') {
                if (editing) {
                  setEditing(null);
                  setText('');
                } else if (replyingTo) {
                  setReplyingTo(null);
                }
              }
            }}
            onPaste={(event) => {
              const files = [...event.clipboardData.files];
              if (files.length > 0) {
                event.preventDefault();
                void attachFiles(files);
              }
            }}
          />

          <div className="composer-emoji-anchor">
            <IconButton label="Emoji" size="sm" onClick={() => setEmojiOpen((v) => !v)}>
              <SmileIcon />
            </IconButton>
            <EmojiPicker
              open={emojiOpen}
              onClose={() => setEmojiOpen(false)}
              onPick={(emoji) => {
                setText((value) => value + emoji);
                textareaRef.current?.focus();
              }}
            />
          </div>
        </div>

        {canSend || editing ? (
          <IconButton
            label={editing ? 'Save edit' : 'Send message'}
            variant="primary"
            size="lg"
            disabled={!canSend}
            onClick={() => void submit()}
          >
            {sending ? <Spinner size={18} /> : <SendIcon />}
          </IconButton>
        ) : (
          <IconButton
            label="Record a voice message"
            size="lg"
            onClick={() => setRecording(true)}
          >
            <MicIcon />
          </IconButton>
        )}
      </div>

      {uploading ? (
        <p className="composer-status" aria-live="polite">
          Encrypting and uploading…
        </p>
      ) : null}
    </div>
  );
}

function isTouchDevice(): boolean {
  return window.matchMedia('(pointer: coarse)').matches;
}
