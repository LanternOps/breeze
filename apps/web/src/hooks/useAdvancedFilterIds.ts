import { useState, useEffect } from 'react';
import type { FilterConditionGroup } from '@breeze/shared';
import { fetchWithAuth } from '../stores/auth';

// A filter is worth sending to the server once it has at least one condition
// with a real value (nested groups count as valid — the server validates the
// leaves). Mirrors the check DeviceList used before the resolution was lifted
// here so the list and grid share one id set (grid previously ignored the
// advanced filter entirely).
function hasValidConditions(filter: FilterConditionGroup): boolean {
  return filter.conditions.some(c => {
    if ('conditions' in c) return true;
    return c.value !== '' && c.value !== null && c.value !== undefined;
  });
}

export interface UseAdvancedFilterIdsReturn {
  /**
   * Set of device ids matching the advanced filter, or null when no filter is
   * active (callers should treat null as "show everything").
   */
  ids: Set<string> | null;
  loading: boolean;
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

  useEffect(() => {
    if (!filter || !hasValidConditions(filter)) {
      setIds(null);
      return;
    }

    setLoading(true);
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
        }
      })
      .catch((err) => {
        if (!controller.signal.aborted) {
          console.error('Filter preview failed:', err);
          setIds(null);
        }
      })
      .finally(() => setLoading(false));

    return () => controller.abort();
  }, [filter]);

  return { ids, loading };
}
