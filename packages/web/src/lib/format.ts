/** Date, time and name formatting, in the viewer's locale. */

const timeFormat = new Intl.DateTimeFormat(undefined, {
  hour: 'numeric',
  minute: '2-digit',
});

const weekdayFormat = new Intl.DateTimeFormat(undefined, { weekday: 'short' });

const dateFormat = new Intl.DateTimeFormat(undefined, {
  day: 'numeric',
  month: 'short',
});

const fullDateFormat = new Intl.DateTimeFormat(undefined, {
  day: 'numeric',
  month: 'long',
  year: 'numeric',
});

const fullDateTimeFormat = new Intl.DateTimeFormat(undefined, {
  dateStyle: 'medium',
  timeStyle: 'short',
});

export function formatTime(value: string | number | Date): string {
  return timeFormat.format(new Date(value));
}

export function formatFullDateTime(value: string | number | Date): string {
  return fullDateTimeFormat.format(new Date(value));
}

/** "Today" / "Yesterday" / a weekday / a date — for the thread's day separators. */
export function formatDaySeparator(value: string | number | Date): string {
  const date = new Date(value);
  const today = startOfDay(new Date());
  const target = startOfDay(date);
  const days = Math.round((today.getTime() - target.getTime()) / 86_400_000);

  if (days === 0) return 'Today';
  if (days === 1) return 'Yesterday';
  if (days < 7) return weekdayFormat.format(date);
  if (date.getFullYear() === new Date().getFullYear()) return dateFormat.format(date);
  return fullDateFormat.format(date);
}

/** Compact timestamp for the chat list: time today, weekday this week, else a date. */
export function formatListTimestamp(value: string | number | Date): string {
  const date = new Date(value);
  const today = startOfDay(new Date());
  const target = startOfDay(date);
  const days = Math.round((today.getTime() - target.getTime()) / 86_400_000);

  if (days === 0) return timeFormat.format(date);
  if (days === 1) return 'Yesterday';
  if (days < 7) return weekdayFormat.format(date);
  return dateFormat.format(date);
}

function startOfDay(date: Date): Date {
  const copy = new Date(date);
  copy.setHours(0, 0, 0, 0);
  return copy;
}

export function sameDay(a: string | number | Date, b: string | number | Date): boolean {
  return startOfDay(new Date(a)).getTime() === startOfDay(new Date(b)).getTime();
}

/**
 * Presence, phrased the way a person would say it.
 *
 * Deliberately coarse past an hour: "last seen 3 hours ago" is enough, and a
 * to-the-minute figure is more tracking information than the feature needs.
 */
export function formatLastSeen(
  online: boolean | null,
  lastSeenAt: string | null,
): string {
  if (online) return 'Online';
  if (!lastSeenAt) return '';

  const elapsed = Date.now() - new Date(lastSeenAt).getTime();
  const minutes = Math.floor(elapsed / 60_000);

  if (minutes < 1) return 'Last seen just now';
  if (minutes < 60) return `Last seen ${minutes} minute${minutes === 1 ? '' : 's'} ago`;

  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `Last seen ${hours} hour${hours === 1 ? '' : 's'} ago`;

  const days = Math.floor(hours / 24);
  if (days === 1) return 'Last seen yesterday';
  if (days < 7) return `Last seen ${days} days ago`;
  return 'Last seen a while ago';
}

export function formatDuration(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  if (minutes >= 60) {
    const hours = Math.floor(minutes / 60);
    return `${hours}:${String(minutes % 60).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
  }
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}

/** Join a list the way English does: "a, b and c". */
export function formatList(items: string[], limit = 3): string {
  if (items.length === 0) return '';
  if (items.length === 1) return items[0]!;
  if (items.length <= limit) {
    return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
  }
  return `${items.slice(0, limit).join(', ')} and ${items.length - limit} others`;
}

export function truncate(value: string, max: number): string {
  if (value.length <= max) return value;
  return `${value.slice(0, max - 1).trimEnd()}…`;
}
