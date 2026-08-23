import { useEffect, useState } from 'react';

/**
 * Subscribe to a media query.
 *
 * The initial value is read synchronously so the first render is already
 * correct — a layout that flips on the second frame is visibly wrong on a
 * phone.
 */
export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() =>
    typeof window === 'undefined' ? false : window.matchMedia(query).matches,
  );

  useEffect(() => {
    const media = window.matchMedia(query);
    const update = (event: MediaQueryListEvent) => setMatches(event.matches);
    setMatches(media.matches);
    media.addEventListener('change', update);
    return () => media.removeEventListener('change', update);
  }, [query]);

  return matches;
}

/** True when the OS or the app is asking for calmer motion. */
export function usePrefersReducedMotion(): boolean {
  const system = useMediaQuery('(prefers-reduced-motion: reduce)');
  const [app, setApp] = useState(
    () => document.documentElement.dataset.reducedMotion === 'true',
  );

  useEffect(() => {
    const observer = new MutationObserver(() => {
      setApp(document.documentElement.dataset.reducedMotion === 'true');
    });
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['data-reduced-motion'],
    });
    return () => observer.disconnect();
  }, []);

  return system || app;
}
