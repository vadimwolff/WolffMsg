import { motion } from 'framer-motion';
import { formatList } from '../lib/format.ts';

/**
 * "Вадим печатает…" with three dots that rise in sequence.
 *
 * The animation is CSS-driven so it costs nothing per frame in JavaScript, and
 * it disappears entirely under reduced-motion.
 */
export function TypingIndicator({ names }: { names: string[] }) {
  if (names.length === 0) return null;

  const label =
    names.length === 1
      ? `${names[0]} is typing`
      : `${formatList(names, 2)} are typing`;

  return (
    <motion.span
      className="typing-indicator"
      initial={{ opacity: 0, y: 3 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0 }}
      aria-live="polite"
    >
      <span className="typing-text">{label}</span>
      <span className="typing-dots" aria-hidden="true">
        <span />
        <span />
        <span />
      </span>
    </motion.span>
  );
}
