import { useEffect, useState } from 'react';
import { getVerification, type VerificationDetails } from '@/lib/api/callerVerification';

const POLL_MS = 2000;

/**
 * Polls one verification every 2 s, awaiting each read before scheduling the
 * next. Keeps polling terminal rows too: a caller can still reject after a
 * verification (late rejection supersedes it). A failed read sets `error` and
 * keeps the last known row — it never invents a terminal status.
 */
export function useVerification(orgId: string, initial: VerificationDetails | null): { row: VerificationDetails | null; error: boolean } {
  const [row, setRow] = useState(initial);
  const [error, setError] = useState(false);
  useEffect(() => {
    setRow(initial);
    setError(false);
    if (!initial) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = async () => {
      try {
        const next = await getVerification(orgId, initial.id, controller.signal);
        if (!controller.signal.aborted) { setRow(next); setError(false); }
      } catch {
        if (!controller.signal.aborted) setError(true);
      } finally {
        if (!controller.signal.aborted) timer = setTimeout(() => void poll(), POLL_MS);
      }
    };
    timer = setTimeout(() => void poll(), POLL_MS);
    return () => { controller.abort(); if (timer) clearTimeout(timer); };
  }, [orgId, initial]);
  return { row, error };
}
