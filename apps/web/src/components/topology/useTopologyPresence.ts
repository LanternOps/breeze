import { useEffect, useRef, useState } from 'react';
import type { PresenceResponse } from '@breeze/shared';
import { topologyApi } from './topologyApi';

/**
 * Cross-site presence for one site (site location W2). Presence is optional enrichment: any failure (network, HTTP error, a body
 * that is not a presence response) keeps the last good value and never surfaces an error, so the map renders without it. Refreshes
 * every 60 s while the tab is visible and on return to the tab; the value is cleared when the site changes.
 */
export function useTopologyPresence(siteId: string, enabled = true): PresenceResponse | null {
  const [presence, setPresence] = useState<PresenceResponse | null>(null);
  const activeSite = useRef('');
  useEffect(() => { activeSite.current = siteId; setPresence(null); }, [siteId]);
  useEffect(() => {
    if (!enabled) return;
    const controller = new AbortController(); let busy = false;
    const load = async () => {
      if (document.hidden || busy) return;
      busy = true;
      try {
        const next = await topologyApi.presence(siteId, controller.signal);
        if (!controller.signal.aborted && activeSite.current === siteId) setPresence(next);
      } catch { /* enrichment only: keep the last good value */ }
      finally { busy = false; }
    };
    void load();
    const timer = setInterval(() => void load(), 60_000);
    const visibility = () => { if (!document.hidden) void load(); };
    document.addEventListener('visibilitychange', visibility);
    return () => { controller.abort(); clearInterval(timer); document.removeEventListener('visibilitychange', visibility); };
  }, [siteId, enabled]);
  return presence;
}
