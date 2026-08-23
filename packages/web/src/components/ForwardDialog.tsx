/**
 * Forward a message.
 *
 * The message is re-encrypted for the destination conversation rather than
 * copied — a ciphertext is bound to its chat by the AEAD's associated data, so
 * "moving" one is not something the protocol allows even for us.
 */
import { useState } from 'react';
import { useChats } from '../store/chats.ts';
import { useSession } from '../store/session.ts';
import { useUi } from '../store/ui.ts';
import { Avatar } from './Avatar.tsx';
import { Button, EmptyState, Modal } from './primitives.tsx';
import { CheckIcon, ForwardIcon } from './icons.tsx';
import { truncate } from '../lib/format.ts';

export function ForwardDialog({
  messageId,
  onClose,
}: {
  messageId: string;
  onClose: () => void;
}) {
  const chats = useChats((s) => s.chats);
  const messages = useChats((s) => s.messages);
  const people = useChats((s) => s.people);
  const sendMessage = useChats((s) => s.sendMessage);
  const user = useSession((s) => s.user);
  const toast = useUi((s) => s.toast);

  const [selected, setSelected] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);

  const source = Object.values(messages)
    .flat()
    .find((m) => m.record.id === messageId);

  async function forward() {
    if (!source?.content || selected.length === 0) return;
    setBusy(true);

    const author = people[source.record.senderId];
    let failures = 0;

    for (const chatId of selected) {
      try {
        await sendMessage(chatId, {
          body: source.content.body,
          ...(source.content.attachments?.length
            ? { attachments: source.content.attachments }
            : {}),
          forwardedFrom: {
            userId: source.record.senderId,
            displayName:
              source.record.senderId === user?.id
                ? (user?.displayName ?? 'You')
                : (author?.displayName ?? 'Unknown'),
            originalCreatedAt: new Date(source.record.createdAt).getTime(),
          },
        });
      } catch {
        failures += 1;
      }
    }

    setBusy(false);
    if (failures === 0) {
      toast(`Forwarded to ${selected.length} conversation${selected.length === 1 ? '' : 's'}`, 'success');
      onClose();
    } else {
      toast(`Could not forward to ${failures} conversation${failures === 1 ? '' : 's'}`, 'danger');
    }
  }

  const available = chats.filter(
    (chat) => !(chat.type === 'group' && chat.readOnlyForMembers && chat.myRole === 'member'),
  );

  return (
    <Modal
      open
      onClose={onClose}
      title="Forward message"
      description="It will be re-encrypted for each conversation you choose."
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button
            variant="primary"
            loading={busy}
            disabled={selected.length === 0}
            icon={<ForwardIcon size={16} />}
            onClick={() => void forward()}
          >
            Forward{selected.length > 0 ? ` (${selected.length})` : ''}
          </Button>
        </>
      }
    >
      {source?.content ? (
        <blockquote className="forward-preview">
          {source.content.body
            ? truncate(source.content.body, 160)
            : 'Attachment'}
        </blockquote>
      ) : null}

      <div className="people-list">
        {available.length === 0 ? (
          <EmptyState
            icon={<ForwardIcon size={26} />}
            title="Nowhere to forward"
            description="Start a conversation first."
          />
        ) : (
          available.map((chat) => {
            const title =
              chat.type === 'group'
                ? (chat.title ?? 'Group')
                : (chat.peer?.displayName ?? 'Conversation');
            const chosen = selected.includes(chat.id);

            return (
              <button
                key={chat.id}
                type="button"
                className="people-row"
                data-selected={chosen ? 'true' : undefined}
                aria-pressed={chosen}
                onClick={() =>
                  setSelected((prev) =>
                    prev.includes(chat.id)
                      ? prev.filter((id) => id !== chat.id)
                      : [...prev, chat.id],
                  )
                }
              >
                <Avatar
                  userId={chat.peer?.id ?? chat.id}
                  name={title}
                  url={chat.type === 'group' ? chat.avatarUrl : chat.peer?.avatarUrl}
                  size={36}
                  shape={chat.type === 'group' ? 'rounded' : 'circle'}
                />
                <span className="people-row-text">
                  <span className="people-row-name">{title}</span>
                  <span className="people-row-username">
                    {chat.type === 'group'
                      ? `${chat.members.length} members`
                      : `@${chat.peer?.username ?? ''}`}
                  </span>
                </span>
                {chosen ? (
                  <span className="people-row-check">
                    <CheckIcon size={16} />
                  </span>
                ) : null}
              </button>
            );
          })
        )}
      </div>
    </Modal>
  );
}
