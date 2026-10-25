import { useEffect, useState } from 'react';
import { fetchWithAuth } from '../stores/auth';

/** `loading` until GET /orgs/partners/me answers; any failure reads as `off`. */
export type WispServerState = 'loading' | 'on' | 'off';

/**
 * Whether the server has Wisp on (`wispEnabled` on GET /orgs/partners/me),
 * tri-state for callers that must not act before the answer (the /wisp home
 * falls back to the chat page only on a real `off`). Missing field, failed
 * request, or a non-OK status all read as off.
 *
 * `enabled: false` asks nothing and reads as `off` — for callers that already
 * know Wisp cannot apply (a non-partner token: the route is partner-level and
 * a system session has no partner). Flipping back to true starts at `loading`.
 */
export function useWispServerState(opts: { enabled?: boolean } = {}): WispServerState {
  const enabled = opts.enabled ?? true;
  const [state, setState] = useState<WispServerState>('loading');
  useEffect(() => {
    if (!enabled) {
      setState('loading');
      return;
    }
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
  }, [enabled]);
  return enabled ? state : 'off';
}

/**
 * Whether the server has Wisp on, for nav surfaces other than the Sidebar
 * (which reads the same response itself). `loading` reads as off.
 */
export function useWispEnabled(opts: { enabled?: boolean } = {}): boolean {
  return useWispServerState(opts) === 'on';
}
