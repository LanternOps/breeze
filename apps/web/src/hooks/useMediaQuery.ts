import { useEffect, useLayoutEffect, useState } from 'react';

// useLayoutEffect warns during SSR; on the client it adopts the real value
// before paint, so a narrow window never flashes the wide layout.
const useIsomorphicLayoutEffect = typeof window === 'undefined' ? useEffect : useLayoutEffect;

/**
 * Live `window.matchMedia(query).matches`. Starts from `fallback` (what the
 * server rendered, and what environments without matchMedia keep, e.g. jsdom)
 * and follows the query's `change` events afterwards.
 */
export function useMediaQuery(query: string, fallback = false): boolean {
  const [matches, setMatches] = useState(fallback);

  useIsomorphicLayoutEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return;
    const mq = window.matchMedia(query);
    const apply = () => setMatches(mq.matches);
    apply();
    if (typeof mq.addEventListener === 'function') {
      mq.addEventListener('change', apply);
      return () => mq.removeEventListener('change', apply);
    }
    // Safari < 14 only has the deprecated listener API.
    mq.addListener?.(apply);
    return () => mq.removeListener?.(apply);
  }, [query]);

  return matches;
}
