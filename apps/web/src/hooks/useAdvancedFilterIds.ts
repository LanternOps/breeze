import { useState, useEffect } from 'react';
import type { FilterConditionGroup } from '@breeze/shared';
import { fetchWithAuth } from '../stores/auth';
import { NO_VALUE_OPERATORS } from '../components/devices/filterMigration';

// A filter is worth sending to the server once it has at least one condition
// with a real value (nested groups count as valid — the server validates the
// leaves), OR a no-value operator (isEmpty/isNotEmpty/isNull/isNotNull —
// e.g. the Devices page "Untagged" quick filter), which is meaningful with
// value === '' by construction. Mirrors the check DeviceList used before the
// resolution was lifted here so the list and grid share one id set (grid
// previously ignored the advanced filter entirely).
function hasValidConditions(filter: FilterConditionGroup): boolean {
  return filter.conditions.some(c => {
    if ('conditions' in c) return true;
    if (NO_VALUE_OPERATORS.includes(c.operator)) return true;
    return c.value !== '' && c.value !== null && c.value !== undefined;
  });
}

export interface UseAdvancedFilterIdsReturn {
  /**
   * Set of device ids matching the advanced filter, or null when no filter is
   * active (callers should treat null as "show everything"). On a preview
   * failure (`error: true`) this is an EMPTY set, never null — a failed
   * filter must narrow the result to nothing, not widen it to the unfiltered
   * fleet (#4732).
   */
  ids: Set<string> | null;
  loading: boolean;
  /**
   * True when the last preview request failed (non-ok response other than
   * 401, or a thrown fetch). Callers should surface this rather than let the
   * empty `ids` pass silently as "the filter genuinely matched nothing."
   * A 401 does NOT set this — fetchWithAuth already triggers the session-
   * expiry redirect itself, and that owns the failure UX.
   */
  error: boolean;
}

/**
 * Resolve an advanced filter (FilterConditionGroup) to the COMPLETE set of
 * matching device ids via POST /filters/preview with `idsOnly: true`. Unlike
 * the preview path this is uncapped — filters matching >100 devices return
 * every id, so the device table/grid never silently hides matches.
 */
export function useAdvancedFilterIds(filter: FilterConditionGroup | null): UseAdvancedFilterIdsReturn {
  const [ids, setIds] = useState<Set<string> | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(false);

  useEffect(() => {
    if (!filter || !hasValidConditions(filter)) {
      setIds(null);
      setError(false);
      return;
    }

    setLoading(true);
    setError(false);
    const controller = new AbortController();

    fetchWithAuth('/filters/preview', {
      method: 'POST',
      body: JSON.stringify({ conditions: filter, idsOnly: true }),
      signal: controller.signal
    })
      .then(async (res) => {
        if (res.ok) {
          const data = await res.json();
          const result = data.data ?? data;
          setIds(new Set<string>(result.deviceIds ?? []));
          setError(false);
          return;
        }
        // 401: let the existing auth-redirect path own it. fetchWithAuth
        // already triggers the session-expiry redirect (logout + navigate)
        // for an unrecoverable 401 before this .then ever runs, so there is
        // nothing left for this hook to add — and setting our own error
        // state here would just flash a second, misleading "filter failed"
        // message on top of a page that's about to navigate away.
        if (res.status === 401) return;
        // Any other non-ok response (403 — a pinned orgId the caller can't
        // access; 500; etc.): a failed filter must never degrade to an
        // unfiltered list (#4732). Fail CLOSED — empty set, not null — and
        // flag the failure so the caller can surface it.
        setIds(new Set());
        setError(true);
      })
      .catch((err) => {
        if (controller.signal.aborted) return;
        console.error('Filter preview failed:', err);
        setIds(new Set());
        setError(true);
      })
      .finally(() => setLoading(false));

    return () => controller.abort();
  }, [filter]);

  return { ids, loading, error };
}
