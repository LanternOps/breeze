import { useCallback, useInsertionEffect, useRef } from 'react';

/**
 * Referentially stable wrapper around a react-i18next `t` (#3632).
 *
 * `useTranslation()` hands back a NEW `t` identity on every `languageChanged`.
 * For any user with a saved non-English locale that event fires after
 * hydration on every page load (`scheduleStoredLocaleAfterHydration`), so an
 * effect listing `t` in its dependency array re-runs: refetching, overwriting
 * fields the user is editing, or tearing down live sessions.
 *
 * The returned function never changes identity, so it is safe as an effect or
 * callback dependency, yet every call forwards to the LATEST `t`, so strings
 * produced inside effects and async callbacks are still in the current
 * language. Keep using the plain `t` for text rendered in JSX, so the UI
 * re-renders on a locale change.
 *
 *   const { t } = useTranslation('devices');
 *   const stableT = useStableT(t);
 *   useEffect(() => { ...stableT('errors.load')... }, [deviceId, stableT]);
 */
export function useStableT<T extends (...args: never[]) => unknown>(t: T): T {
  const tRef = useRef(t);
  // Commit-phase update: an insertion effect runs before any layout or passive
  // effect of the same commit, so effects of this render already see the new
  // translator, while a render React suspends or discards never writes the ref
  // and cannot leak its translator into the committed UI's callbacks.
  useInsertionEffect(() => {
    tRef.current = t;
  }, [t]);
  return useCallback(
    ((...args: Parameters<T>) => tRef.current(...args)) as unknown as T,
    [],
  );
}
