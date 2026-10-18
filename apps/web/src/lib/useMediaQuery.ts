import { useEffect, useState } from 'react';

function read(query: string): boolean {
  return typeof window !== 'undefined' && typeof window.matchMedia === 'function'
    ? window.matchMedia(query).matches
    : false;
}

/**
 * Live `window.matchMedia(query).matches`. `false` when matchMedia is not
 * available (SSR, jsdom without a stub) so callers fall back to the narrow shape.
 */
export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() => read(query));

  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
      setMatches(false);
      return;
    }
    const mql = window.matchMedia(query);
    const onChange = (e: { matches: boolean }) => setMatches(e.matches);
    setMatches(mql.matches);
    mql.addEventListener('change', onChange);
    return () => mql.removeEventListener('change', onChange);
  }, [query]);

  return matches;
}
