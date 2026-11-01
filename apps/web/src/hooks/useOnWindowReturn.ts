import { useEffect, useRef } from 'react';

/**
 * Calls `callback` whenever the user comes back to this window: it regains
 * focus, or the tab becomes visible again. #9431 uses it to re-check approval
 * cards that may have been decided in another window meanwhile.
 */
export function useOnWindowReturn(callback: () => void): void {
  const latest = useRef(callback);
  latest.current = callback;

  useEffect(() => {
    const onReturn = () => {
      if (document.visibilityState === 'visible') latest.current();
    };
    window.addEventListener('focus', onReturn);
    document.addEventListener('visibilitychange', onReturn);
    return () => {
      window.removeEventListener('focus', onReturn);
      document.removeEventListener('visibilitychange', onReturn);
    };
  }, []);
}
