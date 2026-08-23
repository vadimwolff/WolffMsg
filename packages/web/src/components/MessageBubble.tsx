/**
 * A single message.
 *
 * Consecutive messages from the same person within a few minutes are grouped:
 * only the first carries an avatar and a name, only the last carries a tail and
 * a timestamp. That grouping is what makes a long thread readable.
 */
import { memo, useState } from 'react';
import { motion } from 'framer-motion';
import type { PlaintextAttachment } from '@wolffmsg/shared';
import type { DisplayMessage } from '../store/chats.ts';
import { Avatar } from './Avatar.tsx';
import { IconButton, Menu } from './primitives.tsx';
import {
  AlertIcon,
  CheckIcon,
  ClockIcon,
  DoubleCheckIcon,
  EditIcon,
  ForwardIcon,
  KeyIcon,
  MoreIcon,
  PinIcon,
  ReplyIcon,
  SmileIcon,
  TrashIcon,
} from './icons.tsx';
import { AttachmentTile } from './AttachmentTile.tsx';
import { VoiceMessage } from './VoiceMessage.tsx';
import { formatTime, formatFullDateTime } from '../lib/format.ts';
import { Linkify } from './Linkify.tsx';

const QUICK_REACTIONS = ['👍', '❤️', '😂', '🔥', '🐺', '😮'];

export interface BubbleProps {
  message: DisplayMessage;
  mine: boolean;
  /** First in a run from this sender. */
  groupStart: boolean;
  /** Last in a run — gets the tail and the timestamp. */
  groupEnd: boolean;
  showSender: boolean;
  senderName: string;
  senderAvatar: string | null;
  isGroup: boolean;
  canDelete: boolean;
  canPin: boolean;
  pinned: boolean;
  replyPreview: { name: string; body: string } | null;
  onReply: () => void;
  onEdit: () => void;
  onDelete: () => void;
  onForward: () => void;
  onPin: () => void;
  onReact: (emoji: string) => void;
  onOpenImage: (attachments: PlaintextAttachment[], index: number) => void;
  onJumpToReply: (messageId: string) => void;
}

export const MessageBubble = memo(function MessageBubble({
  message,
  mine,
  groupStart,
  groupEnd,
  showSender,
  senderName,
  senderAvatar,
  isGroup,
  canDelete,
  canPin,
  pinned,
  replyPreview,
  onReply,
  onEdit,
  onDelete,
  onForward,
  onPin,
  onReact,
  onOpenImage,
  onJumpToReply,
}: BubbleProps) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [reactionsOpen, setReactionsOpen] = useState(false);

  const record = message.record;
  const content = message.content;

  if (record.deletedAt) {
    return (
      <div className="bubble-row" data-mine={mine || undefined}>
        <div className="bubble bubble-tombstone">
          <TrashIcon size={13} />
          <span>This message was deleted</span>
        </div>
      </div>
    );
  }

  const attachments = content?.attachments ?? [];
  const images = attachments.filter((a) => a.mimeType.startsWith('image/'));
  const hasText = Boolean(content?.body?.trim());

  /*
   * Width to keep clear at the end of the last line so the timestamp can sit
   * there. Computed rather than measured: the pieces are fixed-width (a
   * `tabular-nums` time, an optional tick, an optional "edited"), so a
   * measurement pass would cost a layout thrash for no extra accuracy.
   */
  const metaReserve =
    // "5:24 PM" at the meta's tabular size, plus a gap, plus the optional
    // delivery tick and "edited" marker.
    46 + 10 + (mine ? 20 : 0) + (record.editedAt ? 44 : 0);

  return (
    <motion.div
      className="bubble-row"
      data-mine={mine || undefined}
      data-group-start={groupStart || undefined}
      data-group-end={groupEnd || undefined}
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.22, ease: [0.22, 1, 0.36, 1] }}
    >
      {!mine && isGroup ? (
        <div className="bubble-gutter">
          {groupEnd ? (
            <Avatar
              userId={record.senderId}
              name={senderName}
              url={senderAvatar}
              size={30}
              shape="circle"
            />
          ) : null}
        </div>
      ) : null}

      <div className="bubble-column">
        {showSender && !mine && isGroup ? (
          <span className="bubble-sender">{senderName}</span>
        ) : null}

        <div className="bubble-wrap">
          <div
            className="bubble"
            data-mine={mine || undefined}
            data-tail={groupEnd || undefined}
            data-media-only={!hasText && attachments.length > 0 ? 'true' : undefined}
          >
            {content?.forwardedFrom ? (
              <span className="bubble-forwarded">
                <ForwardIcon size={12} />
                Forwarded from {content.forwardedFrom.displayName}
              </span>
            ) : null}

            {replyPreview && record.replyToId ? (
              <button
                type="button"
                className="bubble-reply"
                onClick={() => onJumpToReply(record.replyToId!)}
              >
                <span className="bubble-reply-name">{replyPreview.name}</span>
                <span className="bubble-reply-body">{replyPreview.body}</span>
              </button>
            ) : null}

            {message.problem !== 'none' ? (
              <UndecryptableNotice problem={message.problem} />
            ) : null}

            {content?.voice ? (
              <VoiceMessage
                voice={content.voice}
                attachment={attachments[0]}
                mine={mine}
              />
            ) : null}

            {images.length > 0 ? (
              <div className="bubble-media" data-count={Math.min(images.length, 4)}>
                {images.map((attachment, index) => (
                  <AttachmentTile
                    key={attachment.id}
                    attachment={attachment}
                    onOpen={() => onOpenImage(images, index)}
                  />
                ))}
              </div>
            ) : null}

            {attachments
              .filter((a) => !a.mimeType.startsWith('image/') && !content?.voice)
              .map((attachment) => (
                <AttachmentTile
                  key={attachment.id}
                  attachment={attachment}
                  variant="file"
                />
              ))}

            {hasText ? (
              <p className="bubble-text">
                <Linkify text={content!.body} />
                {/*
                  An empty inline-block at the end of the text reserves space on
                  the *last line only*, which is where the absolutely positioned
                  timestamp sits. Floating the timestamp instead would reserve
                  space on the first line and break the wrap.
                */}
                <span
                  className="bubble-reserve"
                  style={{ width: metaReserve }}
                  aria-hidden="true"
                />
              </p>
            ) : null}

            <span className="bubble-meta">
              {record.editedAt ? <span className="bubble-edited">edited</span> : null}
              <time
                dateTime={record.createdAt}
                title={formatFullDateTime(record.createdAt)}
              >
                {formatTime(record.createdAt)}
              </time>
              {mine ? <DeliveryTick status={message.status} /> : null}
            </span>
          </div>

          <div className="bubble-actions">
            <IconButton label="React" size="sm" onClick={() => setReactionsOpen((v) => !v)}>
              <SmileIcon size={15} />
            </IconButton>
            <IconButton label="Reply" size="sm" onClick={onReply}>
              <ReplyIcon size={15} />
            </IconButton>
            <div className="menu-anchor">
              <IconButton
                label="More actions"
                size="sm"
                onClick={() => setMenuOpen((v) => !v)}
              >
                <MoreIcon size={15} />
              </IconButton>
              <Menu
                open={menuOpen}
                onClose={() => setMenuOpen(false)}
                label="Message actions"
                align={mine ? 'end' : 'start'}
                items={[
                  { label: 'Reply', icon: <ReplyIcon size={16} />, onSelect: onReply },
                  {
                    label: 'Forward',
                    icon: <ForwardIcon size={16} />,
                    onSelect: onForward,
                    disabled: message.problem !== 'none',
                  },
                  ...(mine && hasText
                    ? [{ label: 'Edit', icon: <EditIcon size={16} />, onSelect: onEdit }]
                    : []),
                  ...(canPin
                    ? [
                        {
                          label: pinned ? 'Unpin' : 'Pin',
                          icon: <PinIcon size={16} />,
                          onSelect: onPin,
                        },
                      ]
                    : []),
                  ...(canDelete
                    ? [
                        {
                          label: 'Delete',
                          icon: <TrashIcon size={16} />,
                          onSelect: onDelete,
                          tone: 'danger' as const,
                        },
                      ]
                    : []),
                ]}
              />
            </div>
          </div>

          {reactionsOpen ? (
            <motion.div
              className="reaction-picker"
              initial={{ opacity: 0, y: 6, scale: 0.94 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              transition={{ type: 'spring', stiffness: 460, damping: 30 }}
            >
              {QUICK_REACTIONS.map((emoji) => (
                <button
                  key={emoji}
                  type="button"
                  className="reaction-option"
                  aria-label={`React with ${emoji}`}
                  onClick={() => {
                    onReact(emoji);
                    setReactionsOpen(false);
                  }}
                >
                  {emoji}
                </button>
              ))}
            </motion.div>
          ) : null}
        </div>

        {record.reactions.length > 0 ? (
          <div className="reaction-row">
            {record.reactions.map((reaction) => (
              <button
                key={reaction.emoji}
                type="button"
                className="reaction-chip"
                onClick={() => onReact(reaction.emoji)}
                aria-label={`${reaction.emoji}, ${reaction.userIds.length} reaction${
                  reaction.userIds.length === 1 ? '' : 's'
                }`}
              >
                <span aria-hidden="true">{reaction.emoji}</span>
                {reaction.userIds.length > 1 ? (
                  <span className="reaction-count">{reaction.userIds.length}</span>
                ) : null}
              </button>
            ))}
          </div>
        ) : null}
      </div>
    </motion.div>
  );
});

/**
 * Delivery state, drawn rather than written.
 *
 * A single check is "the server has it", a double check is "their device has
 * it", and a filled double check is "they opened it". The failed state is
 * deliberately loud — a message that did not send must not look like one that did.
 */
function DeliveryTick({ status }: { status: DisplayMessage['status'] }) {
  if (status === 'sending') {
    return (
      <span className="tick" data-status="sending" title="Sending">
        <ClockIcon size={13} />
        <span className="sr-only">Sending</span>
      </span>
    );
  }
  if (status === 'failed') {
    return (
      <span className="tick" data-status="failed" title="Not sent">
        <AlertIcon size={13} />
        <span className="sr-only">Not sent</span>
      </span>
    );
  }
  if (status === 'sent') {
    return (
      <span className="tick" data-status="sent" title="Sent">
        <CheckIcon size={14} />
        <span className="sr-only">Sent</span>
      </span>
    );
  }
  return (
    <span className="tick" data-status={status} title={status === 'read' ? 'Read' : 'Delivered'}>
      <DoubleCheckIcon size={15} />
      <span className="sr-only">{status === 'read' ? 'Read' : 'Delivered'}</span>
    </span>
  );
}

/**
 * Shown in place of content the device could not open.
 *
 * Each case gets its own honest explanation. Vague wording here would be worse
 * than useless: "identity changed" in particular is a security signal a person
 * needs to be able to act on.
 */
function UndecryptableNotice({ problem }: { problem: DisplayMessage['problem'] }) {
  const copy: Record<string, { title: string; body: string; tone: string }> = {
    'not-for-this-device': {
      title: 'Not encrypted to this device',
      body: 'Sent before you signed in here. Open it on the device that received it.',
      tone: 'muted',
    },
    'key-gone': {
      title: 'Key already used',
      body: 'The one-time key that opened this message has been destroyed. That is forward secrecy working as intended.',
      tone: 'muted',
    },
    'identity-changed': {
      title: 'Sender’s key does not match',
      body: 'This did not come from the key you have for this device. Compare safety numbers before trusting it.',
      tone: 'danger',
    },
    tampered: {
      title: 'Message failed its integrity check',
      body: 'It was altered after it was sent. Nothing has been shown.',
      tone: 'danger',
    },
    error: {
      title: 'Could not open this message',
      body: 'Something went wrong decrypting it.',
      tone: 'muted',
    },
  };

  const entry = copy[problem];
  if (!entry) return null;

  return (
    <div className="bubble-problem" data-tone={entry.tone}>
      <span className="bubble-problem-icon">
        {entry.tone === 'danger' ? <AlertIcon size={15} /> : <KeyIcon size={15} />}
      </span>
      <span>
        <strong>{entry.title}</strong>
        <span className="bubble-problem-body">{entry.body}</span>
      </span>
    </div>
  );
}
