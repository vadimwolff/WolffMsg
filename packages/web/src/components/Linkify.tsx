import { Fragment, useMemo } from 'react';

/**
 * Render message text with links made clickable.
 *
 * The text is inserted as React children, never as HTML, so it cannot inject
 * markup — this component only ever *adds* anchors around spans it matched
 * itself. Every anchor gets `rel="noopener noreferrer nofollow"` and, because
 * the document sets `referrer: no-referrer`, following one tells the
 * destination nothing about where it came from.
 */

// Deliberately conservative: http(s) and bare domains only. No `javascript:`,
// no `data:`, nothing that could become a script URL.
const URL_PATTERN =
  /\b(?:https?:\/\/|www\.)[-\w@:%.+~#=]{1,256}\.[a-z]{2,24}\b(?:[-\w()@:%+.~#?&/=]*)/gi;

interface Segment {
  type: 'text' | 'link';
  value: string;
  href?: string;
}

function segment(text: string): Segment[] {
  const segments: Segment[] = [];
  let lastIndex = 0;

  for (const match of text.matchAll(URL_PATTERN)) {
    const index = match.index ?? 0;
    if (index > lastIndex) {
      segments.push({ type: 'text', value: text.slice(lastIndex, index) });
    }

    const raw = match[0];
    // Trailing punctuation is almost always sentence punctuation, not URL.
    const trimmed = raw.replace(/[.,;:!?)\]]+$/, '');
    const href = trimmed.startsWith('http') ? trimmed : `https://${trimmed}`;

    let safe = false;
    try {
      const url = new URL(href);
      safe = url.protocol === 'https:' || url.protocol === 'http:';
    } catch {
      safe = false;
    }

    if (safe) {
      segments.push({ type: 'link', value: trimmed, href });
      if (raw.length > trimmed.length) {
        segments.push({ type: 'text', value: raw.slice(trimmed.length) });
      }
    } else {
      segments.push({ type: 'text', value: raw });
    }

    lastIndex = index + raw.length;
  }

  if (lastIndex < text.length) {
    segments.push({ type: 'text', value: text.slice(lastIndex) });
  }
  return segments;
}

export function Linkify({ text }: { text: string }) {
  const segments = useMemo(() => segment(text), [text]);

  return (
    <>
      {segments.map((piece, index) =>
        piece.type === 'link' ? (
          <a
            key={index}
            href={piece.href}
            target="_blank"
            rel="noopener noreferrer nofollow"
            className="message-link"
          >
            {piece.value}
          </a>
        ) : (
          <Fragment key={index}>{piece.value}</Fragment>
        ),
      )}
    </>
  );
}
