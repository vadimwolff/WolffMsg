/**
 * Avatars.
 *
 * When someone has no picture — or has hidden it — the fallback is a gradient
 * derived from their user id plus their initials. Deterministic, so the same
 * person is always the same colour, and it never looks like a broken image.
 */
import { useMemo, useState } from 'react';

interface AvatarProps {
  userId: string;
  name: string;
  url?: string | null;
  size?: number;
  /** Draws the presence dot in the corner. */
  online?: boolean | null;
  /** A group avatar is squarer than a person's. */
  shape?: 'circle' | 'rounded';
  className?: string;
}

/** Cheap, stable string hash — only ever used to pick a hue. */
function hashOf(value: string): number {
  let hash = 0;
  for (let i = 0; i < value.length; i += 1) {
    hash = (hash << 5) - hash + value.charCodeAt(i);
    hash |= 0;
  }
  return Math.abs(hash);
}

function initialsOf(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return '?';
  if (words.length === 1) return [...words[0]!].slice(0, 2).join('').toUpperCase();
  return (
    ([...words[0]!][0] ?? '') + ([...words[words.length - 1]!][0] ?? '')
  ).toUpperCase();
}

export function Avatar({
  userId,
  name,
  url,
  size = 44,
  online,
  shape = 'rounded',
  className,
}: AvatarProps) {
  const [failed, setFailed] = useState(false);

  const gradient = useMemo(() => {
    const hue = hashOf(userId) % 360;
    // Two hues 42° apart with high lightness contrast: distinct at a glance,
    // and legible behind white initials in both themes.
    return `linear-gradient(140deg, hsl(${hue} 62% 48%), hsl(${(hue + 42) % 360} 66% 34%))`;
  }, [userId]);

  const initials = useMemo(() => initialsOf(name), [name]);
  const showImage = Boolean(url) && !failed;

  return (
    <span
      className={`avatar${className ? ` ${className}` : ''}`}
      data-shape={shape}
      style={{
        width: size,
        height: size,
        // Type and the presence dot both scale with the avatar.
        fontSize: `${Math.max(10, Math.round(size * 0.36))}px`,
        borderRadius: shape === 'circle' ? '50%' : `${Math.round(size * 0.32)}px`,
        background: showImage ? undefined : gradient,
      }}
    >
      {showImage ? (
        <img
          src={url ?? ''}
          alt=""
          className="avatar-image"
          loading="lazy"
          decoding="async"
          draggable={false}
          onError={() => setFailed(true)}
        />
      ) : (
        <span className="avatar-initials" aria-hidden="true">
          {initials}
        </span>
      )}

      {online !== null && online !== undefined ? (
        <span
          className="avatar-presence"
          data-online={online ? 'true' : 'false'}
          style={{ width: Math.max(8, size * 0.24), height: Math.max(8, size * 0.24) }}
        >
          <span className="sr-only">{online ? 'Online' : 'Offline'}</span>
        </span>
      ) : null}
    </span>
  );
}

/** Overlapping avatars for a group row. */
export function AvatarStack({
  people,
  size = 28,
  max = 3,
}: {
  people: { id: string; displayName: string; avatarUrl: string | null }[];
  size?: number;
  max?: number;
}) {
  const shown = people.slice(0, max);
  const overflow = people.length - shown.length;

  return (
    <span className="avatar-stack" style={{ '--stack-size': `${size}px` } as never}>
      {shown.map((person) => (
        <Avatar
          key={person.id}
          userId={person.id}
          name={person.displayName}
          url={person.avatarUrl}
          size={size}
          shape="circle"
        />
      ))}
      {overflow > 0 ? (
        <span className="avatar-overflow" style={{ width: size, height: size }}>
          +{overflow}
        </span>
      ) : null}
    </span>
  );
}
