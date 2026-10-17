import { useEffect, useState } from 'react';
import type { SupportedLocale } from '@breeze/shared';
import { detectAccessLocale } from './accessCopy';

export interface FragmentState {
  /** False until the client effect has run (SSR and first hydration render), so markup matches the server. */
  ready: boolean;
  token: string | null;
  locale: SupportedLocale;
}

/**
 * Reads the access token from the URL fragment and IMMEDIATELY clears it (before any request), so it never
 * lingers in history, referrers or screenshots. Runs once on mount; the token lives only in component state.
 */
export function useFragmentToken(): FragmentState {
  const [state, setState] = useState<FragmentState>({ ready: false, token: null, locale: 'en' });
  useEffect(() => {
    const raw = window.location.hash.replace(/^#/, '');
    if (window.location.hash) {
      window.history.replaceState(null, '', window.location.pathname + window.location.search);
    }
    setState({ ready: true, token: raw || null, locale: detectAccessLocale() });
  }, []);
  return state;
}
