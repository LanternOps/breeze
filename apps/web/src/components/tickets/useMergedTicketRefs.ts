import { useEffect, useMemo, useRef, useState } from 'react';
import { fetchWithAuth } from '../../stores/auth';
import { ticketDisplayNumber, type TicketDetail } from './ticketConfig';

export type MergedIntoState = { id: string; state: 'pending' | 'found' | 'missing'; number?: string } | null;

/**
 * #8972 merge references, moved out of TicketWorkbench unchanged:
 *  - `mergedInto`: a tombstone's survivor number, read from the survivor's own
 *    detail (the tombstone carries only its id). 'missing' = 404/403: the
 *    survivor was deleted or is outside this caller's view, so the banner has
 *    no link.
 *  - `mergedFromNumbers`: display numbers of the tombstones this ticket's
 *    moved comments came from, keyed by mergedFromTicketId. Each id is read
 *    once per workbench.
 */
export function useMergedTicketRefs(ticket: TicketDetail | null, ticketId: string) {
  const [mergedInto, setMergedInto] = useState<MergedIntoState>(null);
  const [mergedFromNumbers, setMergedFromNumbers] = useState<Record<string, string>>({});
  const mergedFromRequested = useRef<Set<string>>(new Set());
  const ticketIdRef = useRef(ticketId);
  useEffect(() => { ticketIdRef.current = ticketId; }, [ticketId]);

  // A ticket switch starts both lookups over.
  useEffect(() => {
    setMergedInto(null);
    setMergedFromNumbers({});
    mergedFromRequested.current = new Set();
  }, [ticketId]);

  // Resolve the survivor's number for the tombstone banner. Not parsed from
  // resolutionNote (free text a later edit could change).
  const mergedIntoTicketId = ticket?.mergedIntoTicketId ?? null;
  useEffect(() => {
    if (!mergedIntoTicketId) { setMergedInto(null); return; }
    let cancelled = false;
    setMergedInto((prev) => (prev?.id === mergedIntoTicketId ? prev : { id: mergedIntoTicketId, state: 'pending' }));
    void (async () => {
      try {
        const res = await fetchWithAuth(`/tickets/${mergedIntoTicketId}`);
        if (cancelled) return;
        if (res.status === 404 || res.status === 403) {
          setMergedInto({ id: mergedIntoTicketId, state: 'missing' });
          return;
        }
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const body = (await res.json()) as { data?: { id: string; internalNumber?: string | null; ticketNumber?: string | null } };
        if (cancelled) return;
        setMergedInto({ id: mergedIntoTicketId, state: 'found', number: ticketDisplayNumber(body.data ?? { id: mergedIntoTicketId }) });
      } catch (err) {
        // Leave the pending banner (no number, link by id) rather than claim the survivor is gone.
        if (!cancelled) console.warn('[TicketWorkbench] survivor lookup failed', err);
      }
    })();
    return () => { cancelled = true; };
  }, [mergedIntoTicketId]);

  // Comments moved here by a merge carry the tombstone's id; read each
  // distinct tombstone once (tombstones stay readable) for the "from T-…" mark.
  const mergedFromIds = useMemo(() => {
    const ids = new Set<string>();
    for (const c of ticket?.comments ?? []) if (c.mergedFromTicketId) ids.add(c.mergedFromTicketId);
    return [...ids].sort().join(',');
  }, [ticket?.comments]);
  useEffect(() => {
    if (!mergedFromIds) return;
    const pending = mergedFromIds.split(',').filter((id) => !mergedFromRequested.current.has(id));
    if (pending.length === 0) return;
    for (const id of pending) mergedFromRequested.current.add(id);
    const forTicketId = ticketId;
    for (const id of pending) {
      void fetchWithAuth(`/tickets/${id}`)
        .then(async (res) => {
          if (!res.ok) {
            console.warn(`[TicketWorkbench] merged-from lookup ${id} answered ${res.status}`);
            return null;
          }
          return (await res.json()) as { data?: { id: string; internalNumber?: string | null; ticketNumber?: string | null } };
        })
        .then((body) => {
          if (!body?.data || ticketIdRef.current !== forTicketId) return;
          const number = ticketDisplayNumber(body.data);
          setMergedFromNumbers((prev) => ({ ...prev, [id]: number }));
        })
        .catch((err) => { console.warn('[TicketWorkbench] merged-from lookup failed', err); });
    }
  }, [mergedFromIds, ticketId]);

  return { mergedInto, mergedFromNumbers };
}
