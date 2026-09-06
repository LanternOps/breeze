import { useState, useEffect, useCallback, useMemo } from 'react';
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

type FilterResolution =
  | { state: 'inactive'; ids: null; loading: false; error: false }
  | { state: 'loading'; ids: Set<string>; loading: true; error: false }
  | { state: 'ready'; ids: Set<string>; loading: false; error: false }
  | { state: 'error'; ids: Set<string>; loading: false; error: boolean };

export type UseAdvancedFilterIdsReturn = FilterResolution & { refetch: () => void };
const EMPTY_IDS = new Set<string>();

/** Resolve the complete device scope. Only an inactive filter returns null.
 * A changed filter, scope or retry closes synchronously, before effects run.
 */
export function useAdvancedFilterIds(
  filter: FilterConditionGroup | null,
  scopeKey = '',
): UseAdvancedFilterIdsReturn {
  const [reloadToken, setReloadToken] = useState(0);
  const refetch = useCallback(() => setReloadToken(n => n + 1), []);
  const active = filter !== null && hasValidConditions(filter);
  const key = JSON.stringify([filter, scopeKey, reloadToken]);
  const requestFilter = useMemo(() => JSON.parse(key)[0] as FilterConditionGroup, [key]);
  const [previousKey, setPreviousKey] = useState(key);
  const [resolved, setResolved] = useState<{
    key: string; result: FilterResolution;
  } | null>(null);

  // Do not revive an older ready snapshot on A -> B -> A while B is pending.
  if (previousKey !== key) {
    setPreviousKey(key);
    setResolved(null);
  }

  useEffect(() => {
    if (!active) return;
    const controller = new AbortController();
    // runaction-exempt: read-only preview; failures close the scope with retry UI.
    void (async () => {
      try {
        const response = await fetchWithAuth('/filters/preview', {
          method: 'POST',
          body: JSON.stringify({ conditions: requestFilter, idsOnly: true }),
          signal: controller.signal,
        });
        if (controller.signal.aborted) return;
        if (!response.ok) {
          setResolved({ key, result: { state: 'error', ids: EMPTY_IDS, loading: false, error: response.status !== 401 } });
          return;
        }
        const body = await response.json();
        if (controller.signal.aborted) return;
        const result = body?.data ?? body;
        if (!Array.isArray(result?.deviceIds)
          || !result.deviceIds.every((id: unknown) => typeof id === 'string' && id.length > 0)
          || !Number.isSafeInteger(result.totalCount)
          || result.totalCount !== new Set(result.deviceIds).size) {
          throw new Error('Invalid complete filter response');
        }
        setResolved({ key, result: { state: 'ready', ids: new Set(result.deviceIds), loading: false, error: false } });
      } catch {
        if (!controller.signal.aborted) {
          setResolved({ key, result: { state: 'error', ids: EMPTY_IDS, loading: false, error: true } });
        }
      }
    })();
    return () => controller.abort();
  }, [key, active, requestFilter]);

  if (!active) return { state: 'inactive', ids: null, loading: false, error: false, refetch };
  if (previousKey !== key || resolved?.key !== key) return { state: 'loading', ids: EMPTY_IDS, loading: true, error: false, refetch };
  return { ...resolved.result, refetch };
}
