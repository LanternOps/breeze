import { useEffect, useState } from 'react';
import { fetchWithAuth } from '../stores/auth';

/**
 * `loading` until GET /orgs/partners/me answers. `off` = the server answered
 * and Wisp is not on; `error` = no usable answer (non-OK, network, bad body).
 */
export type WispServerState = 'loading' | 'on' | 'off' | 'error';

/**
 * Whether the server has Wisp on (`wispEnabled` on GET /orgs/partners/me),
 * tri-state for callers that must not act before the answer (the /wisp home
 * falls back to the chat page only on a real `off`, never on `error`). A
 * missing field on a good answer is `off`.
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
          if (!response?.ok) throw new Error(`/orgs/partners/me failed: ${response?.status ?? 'no response'}`);
          const data = (await response.json()) as { wispEnabled?: unknown } | null;
          if (live) setState(data?.wispEnabled === true ? 'on' : 'off');
        })
        .catch((err: unknown) => {
          console.warn('[wispVisibility] reading wispEnabled failed', err);
          if (live) setState('error');
        });
    } catch (err) {
      console.warn('[wispVisibility] reading wispEnabled failed', err);
      if (live) setState('error');
    }
    return () => {
      live = false;
    };
  }, [enabled]);
  return enabled ? state : 'off';
}

/**
 * Whether the server has Wisp on, for nav surfaces other than the Sidebar
 * (which reads the same response itself). `loading` and `error` read as off:
 * an affordance stays hidden rather than offering what may 404.
 */
export function useWispEnabled(opts: { enabled?: boolean } = {}): boolean {
  return useWispServerState(opts) === 'on';
}
