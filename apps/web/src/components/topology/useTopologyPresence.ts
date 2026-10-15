import { useEffect, useRef, useState } from 'react';
import type { PresenceResponse } from '@breeze/shared';
import { topologyApi } from './topologyApi';

/** A presence value that has not refreshed for this long is dropped rather than shown as if current. */
export const PRESENCE_STALE_AFTER_MS = 5 * 60_000;

/**
 * Cross-site presence for one site (site location W2). Presence is optional enrichment: a failure (network, HTTP error, a body
 * that is not a presence response) is reported to the console and keeps the last good value, so the map renders without it —
 * but only for PRESENCE_STALE_AFTER_MS; after that the value is dropped so stale visitors are never shown indefinitely.
 * Refreshes every 60 s while the tab is visible and on return to the tab; the value is cleared when the site changes.
 * Bumping `reloadKey` refetches at once (site location W3: after a move, "Keep at" or "Turn on").
 */
export function useTopologyPresence(siteId: string, enabled = true, reloadKey = 0): PresenceResponse | null {
  const [presence, setPresence] = useState<PresenceResponse | null>(null);
  const activeSite = useRef('');
  const lastOk = useRef(0);
  useEffect(() => { activeSite.current = siteId; lastOk.current = 0; setPresence(null); }, [siteId]);
  useEffect(() => {
    if (!enabled) return;
    const controller = new AbortController(); let busy = false;
    const load = async () => {
      if (document.hidden || busy) return;
      busy = true;
      try {
        const next = await topologyApi.presence(siteId, controller.signal);
        if (!controller.signal.aborted && activeSite.current === siteId) { lastOk.current = Date.now(); setPresence(next); }
      } catch (error) {
        if (controller.signal.aborted) return;
        console.warn('[topology] presence refresh failed', error);
        if (lastOk.current && Date.now() - lastOk.current >= PRESENCE_STALE_AFTER_MS && activeSite.current === siteId) setPresence(null);
      } finally { busy = false; }
    };
    void load();
    const timer = setInterval(() => void load(), 60_000);
    const visibility = () => { if (!document.hidden) void load(); };
    document.addEventListener('visibilitychange', visibility);
    return () => { controller.abort(); clearInterval(timer); document.removeEventListener('visibilitychange', visibility); };
  }, [siteId, enabled, reloadKey]);
  return presence;
}
