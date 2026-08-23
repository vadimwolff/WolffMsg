/**
 * Emoji picker.
 *
 * A curated set rather than the full Unicode catalogue: a few hundred emoji
 * that people actually send, grouped, searchable by keyword, and shipping as
 * plain text in the bundle rather than as an image sprite or a fetched
 * dataset — which would be another network request this app does not need.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';

interface EmojiEntry {
  char: string;
  keywords: string;
}

const GROUPS: { name: string; emoji: EmojiEntry[] }[] = [
  {
    name: 'Smileys',
    emoji: [
      { char: '😀', keywords: 'grin happy smile' },
      { char: '😃', keywords: 'happy smile joy' },
      { char: '😄', keywords: 'happy laugh' },
      { char: '😁', keywords: 'beam grin' },
      { char: '😅', keywords: 'sweat laugh nervous' },
      { char: '😂', keywords: 'tears joy laughing lol' },
      { char: '🤣', keywords: 'rolling laughing rofl' },
      { char: '🙂', keywords: 'slight smile' },
      { char: '🙃', keywords: 'upside down irony' },
      { char: '😉', keywords: 'wink' },
      { char: '😊', keywords: 'blush smile warm' },
      { char: '😇', keywords: 'angel innocent halo' },
      { char: '🥰', keywords: 'love hearts adore' },
      { char: '😍', keywords: 'heart eyes love' },
      { char: '😘', keywords: 'kiss blow' },
      { char: '😋', keywords: 'yum tasty tongue' },
      { char: '😎', keywords: 'cool sunglasses' },
      { char: '🤩', keywords: 'star struck wow' },
      { char: '🥳', keywords: 'party celebrate' },
      { char: '😏', keywords: 'smirk sly' },
      { char: '😌', keywords: 'relieved calm' },
      { char: '😔', keywords: 'sad pensive' },
      { char: '😢', keywords: 'cry sad tear' },
      { char: '😭', keywords: 'sob crying loud' },
      { char: '😤', keywords: 'triumph steam determined' },
      { char: '😠', keywords: 'angry mad' },
      { char: '🤬', keywords: 'swearing cursing' },
      { char: '🤯', keywords: 'mind blown explode' },
      { char: '😳', keywords: 'flushed embarrassed' },
      { char: '🥺', keywords: 'pleading please puppy' },
      { char: '😱', keywords: 'scream fear shock' },
      { char: '😴', keywords: 'sleep tired zzz' },
      { char: '🤔', keywords: 'thinking hmm' },
      { char: '🤨', keywords: 'raised eyebrow doubt' },
      { char: '😐', keywords: 'neutral blank' },
      { char: '🙄', keywords: 'eye roll' },
      { char: '😬', keywords: 'grimace awkward' },
      { char: '🤐', keywords: 'zipper quiet secret' },
      { char: '🤫', keywords: 'shush quiet secret' },
      { char: '🫡', keywords: 'salute respect' },
      { char: '🤝', keywords: 'handshake deal agree' },
      { char: '🫶', keywords: 'heart hands love' },
    ],
  },
  {
    name: 'Gestures',
    emoji: [
      { char: '👍', keywords: 'thumbs up yes good approve' },
      { char: '👎', keywords: 'thumbs down no bad' },
      { char: '👏', keywords: 'clap applause bravo' },
      { char: '🙌', keywords: 'raise hands celebrate' },
      { char: '🙏', keywords: 'please thanks pray' },
      { char: '💪', keywords: 'strong muscle' },
      { char: '✌️', keywords: 'peace victory' },
      { char: '🤞', keywords: 'fingers crossed luck' },
      { char: '👌', keywords: 'ok perfect' },
      { char: '🤟', keywords: 'love you rock' },
      { char: '👋', keywords: 'wave hello bye' },
      { char: '🫵', keywords: 'point you' },
      { char: '☝️', keywords: 'point up one' },
      { char: '👇', keywords: 'point down' },
      { char: '👀', keywords: 'eyes look watching' },
      { char: '🧠', keywords: 'brain smart' },
    ],
  },
  {
    name: 'Hearts',
    emoji: [
      { char: '❤️', keywords: 'red heart love' },
      { char: '🧡', keywords: 'orange heart' },
      { char: '💛', keywords: 'yellow heart' },
      { char: '💚', keywords: 'green heart' },
      { char: '💙', keywords: 'blue heart' },
      { char: '💜', keywords: 'purple heart' },
      { char: '🖤', keywords: 'black heart' },
      { char: '🤍', keywords: 'white heart' },
      { char: '💔', keywords: 'broken heart sad' },
      { char: '❤️‍🔥', keywords: 'heart fire burning' },
      { char: '💕', keywords: 'two hearts love' },
      { char: '✨', keywords: 'sparkles shine magic' },
    ],
  },
  {
    name: 'Nature',
    emoji: [
      { char: '🐺', keywords: 'wolf wolffmsg howl' },
      { char: '🦊', keywords: 'fox' },
      { char: '🐻', keywords: 'bear' },
      { char: '🦅', keywords: 'eagle bird' },
      { char: '🐉', keywords: 'dragon' },
      { char: '🌙', keywords: 'moon night crescent' },
      { char: '⭐', keywords: 'star' },
      { char: '🌌', keywords: 'milky way night sky' },
      { char: '🔥', keywords: 'fire lit hot' },
      { char: '❄️', keywords: 'snow cold frost' },
      { char: '⚡', keywords: 'lightning fast power' },
      { char: '🌊', keywords: 'wave ocean water' },
      { char: '🌲', keywords: 'tree forest' },
      { char: '🏔️', keywords: 'mountain snow peak' },
    ],
  },
  {
    name: 'Objects',
    emoji: [
      { char: '🎉', keywords: 'party celebrate tada' },
      { char: '🎂', keywords: 'cake birthday' },
      { char: '☕', keywords: 'coffee tea' },
      { char: '🍕', keywords: 'pizza food' },
      { char: '🍻', keywords: 'beer cheers drink' },
      { char: '🎧', keywords: 'headphones music' },
      { char: '📷', keywords: 'camera photo' },
      { char: '💻', keywords: 'laptop computer work' },
      { char: '📱', keywords: 'phone mobile' },
      { char: '🔒', keywords: 'lock secure private' },
      { char: '🔑', keywords: 'key' },
      { char: '🛡️', keywords: 'shield protect security' },
      { char: '✅', keywords: 'check done yes' },
      { char: '❌', keywords: 'cross no wrong' },
      { char: '⚠️', keywords: 'warning caution' },
      { char: '💯', keywords: 'hundred perfect' },
      { char: '🚀', keywords: 'rocket launch fast' },
      { char: '⏰', keywords: 'alarm clock time' },
    ],
  },
];

export function EmojiPicker({
  open,
  onClose,
  onPick,
}: {
  open: boolean;
  onClose: () => void;
  onPick: (emoji: string) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [query, setQuery] = useState('');

  useEffect(() => {
    if (!open) return;
    setQuery('');

    const onPointerDown = (event: PointerEvent) => {
      if (!ref.current?.contains(event.target as Node)) onClose();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };

    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open, onClose]);

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return GROUPS;
    return GROUPS.map((group) => ({
      name: group.name,
      emoji: group.emoji.filter((entry) => entry.keywords.includes(needle)),
    })).filter((group) => group.emoji.length > 0);
  }, [query]);

  return (
    <AnimatePresence>
      {open ? (
        <motion.div
          ref={ref}
          className="emoji-picker"
          initial={{ opacity: 0, y: 8, scale: 0.96 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          exit={{ opacity: 0, y: 6, scale: 0.97 }}
          transition={{ duration: 0.16, ease: [0.22, 1, 0.36, 1] }}
        >
          <input
            className="emoji-search"
            type="search"
            placeholder="Search emoji"
            aria-label="Search emoji"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            autoFocus
          />
          <div className="emoji-scroll">
            {filtered.length === 0 ? (
              <p className="emoji-empty">Nothing matches that.</p>
            ) : (
              filtered.map((group) => (
                <section key={group.name} className="emoji-group">
                  <h4 className="emoji-group-title">{group.name}</h4>
                  <div className="emoji-grid">
                    {group.emoji.map((entry) => (
                      <button
                        key={entry.char}
                        type="button"
                        className="emoji-button"
                        aria-label={entry.keywords.split(' ')[0]}
                        onClick={() => onPick(entry.char)}
                      >
                        {entry.char}
                      </button>
                    ))}
                  </div>
                </section>
              ))
            )}
          </div>
        </motion.div>
      ) : null}
    </AnimatePresence>
  );
}
