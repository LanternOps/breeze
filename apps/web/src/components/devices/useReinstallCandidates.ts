import { useCallback, useEffect, useRef, useState } from 'react';
import { fetchWithAuth } from '../../stores/auth';
import {
  parseReinstallCandidatesView,
  reinstallCandidatesPath,
  type ReinstallCandidatesView,
} from '../../lib/deviceReattach';

export type ReinstallCandidatesStatus = 'idle' | 'loading' | 'ready' | 'unavailable';

/**
 * The reattach candidates of one source device (`GET
 * /devices/:id/reinstall-candidates`, #8318 §7.3). `null` skips the read.
 *
 * A failed or refused read is `unavailable`, never an error to the user: the
 * reattach is an extra choice on surfaces that work without it (assigning a
 * parked device, reviewing a possible replacement), and a 404 is how the API
 * answers a source this viewer may not see.
 */
export function useReinstallCandidates(sourceDeviceId: string | null): {
  view: ReinstallCandidatesView | null;
  status: ReinstallCandidatesStatus;
  reload: () => Promise<void>;
} {
  const [view, setView] = useState<ReinstallCandidatesView | null>(null);
  const [status, setStatus] = useState<ReinstallCandidatesStatus>('idle');
  // Each read carries a sequence number so a slow answer for a previous
  // device never overwrites the current one.
  const seq = useRef(0);

  const load = useCallback(async () => {
    const mine = ++seq.current;
    if (!sourceDeviceId) {
      setView(null);
      setStatus('idle');
      return;
    }
    setStatus('loading');
    try {
      const response = await fetchWithAuth(reinstallCandidatesPath(sourceDeviceId));
      if (mine !== seq.current) return;
      if (!response.ok) {
        setView(null);
        setStatus('unavailable');
        return;
      }
      const parsed = parseReinstallCandidatesView(await response.json().catch(() => null));
      if (mine !== seq.current) return;
      setView(parsed);
      setStatus(parsed ? 'ready' : 'unavailable');
    } catch (err) {
      console.debug('[reattach] candidates read failed:', err);
      if (mine !== seq.current) return;
      setView(null);
      setStatus('unavailable');
    }
  }, [sourceDeviceId]);

  useEffect(() => {
    setView(null);
    void load();
    return () => { seq.current += 1; };
  }, [load]);

  return { view, status, reload: load };
}
