// FilterPreviewFooter — spec 4.5. Calls `POST /api/v1/devices/filter-preview` with
// the in-progress FilterConditionGroup and renders `~{N} devices match`.
// Debounced 350ms so each keystroke in a value input doesn't fire a request.
// If the endpoint returns 404 the footer goes silent so old API builds don't
// log noise (the spec says: "If the endpoint returns 404 in your tests,
// leave a TODO and skip"). TODO: drop the 404 fallback once the backend
// preview endpoint is live everywhere.
import { useEffect, useRef, useState } from 'react';
import type { FilterConditionGroup } from '@breeze/shared';
import { fetchWithAuth } from '../../stores/auth';

export interface FilterPreviewFooterProps {
  // Single-chip preview group. Caller wraps the in-flight chip into an
  // AND-group of one so the count reflects "how many devices match this chip
  // alone" (useful while editing) — the parent decides the framing.
  group: FilterConditionGroup | null;
}

export function FilterPreviewFooter({ group }: FilterPreviewFooterProps) {
  const [count, setCount] = useState<number | null>(null);
  const [loading, setLoading] = useState(false);
  const [skipped, setSkipped] = useState(false);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    if (!group || group.conditions.length === 0) {
      setCount(null);
      return;
    }
    if (skipped) return;
    const ctrl = new AbortController();
    abortRef.current?.abort();
    abortRef.current = ctrl;
    const id = window.setTimeout(async () => {
      setLoading(true);
      try {
        const res = await fetchWithAuth('/filters/preview', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ conditions: group, limit: 1 }),
          signal: ctrl.signal
        });
        if (res.status === 404) {
          setSkipped(true);
          setCount(null);
          return;
        }
        if (res.ok) {
          const body = await res.json();
          const total = body?.data?.totalCount;
          setCount(typeof total === 'number' ? total : null);
        }
      } catch (e) {
        if ((e as Error).name !== 'AbortError') setCount(null);
      } finally {
        setLoading(false);
      }
    }, 350);
    return () => { window.clearTimeout(id); ctrl.abort(); };
  }, [group, skipped]);

  if (skipped) {
    return (
      <span className="text-[10px] text-muted-foreground" data-testid="filter-preview-skipped">
        preview unavailable
      </span>
    );
  }
  if (!group || group.conditions.length === 0) return null;
  return (
    <span data-testid="filter-preview-count" className="text-xs text-muted-foreground">
      {loading ? '…counting' : count === null ? '' : `~${count} devices match`}
    </span>
  );
}
