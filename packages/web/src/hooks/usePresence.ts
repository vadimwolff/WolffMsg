import { useEffect, useRef, useState } from 'react';

/**
 * Mount/unmount with a leaving window, driven by a timer rather than by an
 * animation callback.
 *
 * Why not `AnimatePresence`: it removes an exiting child only when the child
 * reports its animation finished. If that report is missed — and it is missed
 * whenever a nested subtree re-renders during the exit window, which any
 * overlay containing async data loading does — the element animates to
 * `opacity: 0` and then stays in the DOM forever, invisibly covering the page
 * and swallowing every click.
 *
 * This hook makes unmounting unconditional: `open` goes false, the caller gets
 * `leaving: true` for `exitMs` so it can animate out, and then the element is
 * removed whether or not anything reported anything.
 *
 * @returns `mounted` — render the element at all
 *          `leaving` — it is on its way out; apply the exit styles
 */
export function usePresence(
  open: boolean,
  exitMs = 180,
): { mounted: boolean; leaving: boolean } {
  const [mounted, setMounted] = useState(open);
  const [leaving, setLeaving] = useState(false);
  const timer = useRef<number | null>(null);

  useEffect(() => {
    if (timer.current !== null) {
      clearTimeout(timer.current);
      timer.current = null;
    }

    if (open) {
      setMounted(true);
      setLeaving(false);
      return;
    }

    if (!mounted) return;

    setLeaving(true);
    timer.current = window.setTimeout(() => {
      setMounted(false);
      setLeaving(false);
      timer.current = null;
    }, exitMs);

    return () => {
      if (timer.current !== null) {
        clearTimeout(timer.current);
        timer.current = null;
      }
    };
  }, [open, exitMs, mounted]);

  // Honour reduced motion: no exit window at all.
  useEffect(() => {
    if (!window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    if (open || !mounted) return;
    setMounted(false);
    setLeaving(false);
  }, [open, mounted]);

  return { mounted, leaving };
}
