import { useEffect, useState } from 'react';
import { fetchWithAuth } from '../stores/auth';

/** `loading` until GET /orgs/partners/me answers; any failure reads as `off`. */
export type WispServerState = 'loading' | 'on' | 'off';

/**
 * Whether the server has Wisp on (`wispEnabled` on GET /orgs/partners/me),
 * tri-state for callers that must not act before the answer (the /wisp home
 * falls back to the chat page only on a real `off`). Missing field, failed
 * request, or a non-OK status all read as off.
 */
export function useWispServerState(): WispServerState {
  const [state, setState] = useState<WispServerState>('loading');
  useEffect(() => {
    let live = true;
    try {
      void Promise.resolve(fetchWithAuth('/orgs/partners/me'))
        .then(async (response) => {
          const data = response?.ok ? await response.json() : null;
          if (live) setState(data?.wispEnabled === true ? 'on' : 'off');
        })
        .catch(() => {
          if (live) setState('off');
        });
    } catch {
      if (live) setState('off');
    }
    return () => {
      live = false;
    };
  }, []);
  return state;
}

/**
 * Whether the server has Wisp on, for nav surfaces other than the Sidebar
 * (which reads the same response itself). `loading` reads as off.
 */
export function useWispEnabled(): boolean {
  return useWispServerState() === 'on';
}
