// FilterPreviewFooter — spec 4.5. Calls `POST /api/v1/devices/filter-preview` with
// the in-progress FilterConditionGroup and renders `~{N} devices match`.
// Debounced 350ms so each keystroke in a value input doesn't fire a request.
// If the endpoint returns 404 the footer goes silent so old API builds don't
// log noise (the spec says: "If the endpoint returns 404 in your tests,
// leave a TODO and skip"). TODO: drop the 404 fallback once the backend
// preview endpoint is live everywhere.
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { FilterCondition, FilterConditionGroup, FilterOperator } from '@breeze/shared';
import { fetchWithAuth } from '../../stores/auth';

// Operators that take no value (mirrors FilterValueEditor's NO_VALUE_OPERATORS).
const NO_VALUE_OPERATORS: ReadonlySet<FilterOperator> = new Set(['isNull', 'isNotNull', 'isEmpty', 'isNotEmpty']);

function isGroup(c: FilterCondition | FilterConditionGroup): c is FilterConditionGroup {
  return 'conditions' in c;
}

function conditionAwaitingValue(c: FilterCondition): boolean {
  if (NO_VALUE_OPERATORS.has(c.operator)) return false;
  const v = c.value as unknown;
  if (v === null || v === undefined) return true;
  if (Array.isArray(v)) return v.length === 0;
  if (typeof v === 'string') return v.trim() === '';
  return false;
}

// True when any leaf condition still needs a value (e.g. a Site / Device Group
// chip opened with nothing ticked yet). Previewing such a group returns a
// meaningless "~0 devices match" (#9857), so the footer shows a hint instead.
export function isAwaitingValue(group: FilterConditionGroup): boolean {
  return group.conditions.some(c => (isGroup(c) ? isAwaitingValue(c) : conditionAwaitingValue(c)));
}

export interface FilterPreviewFooterProps {
  // Single-chip preview group. Caller wraps the in-flight chip into an
  // AND-group of one so the count reflects "how many devices match this chip
  // alone" (useful while editing) — the parent decides the framing.
  group: FilterConditionGroup | null;
}

export function FilterPreviewFooter({ group }: FilterPreviewFooterProps) {
  const { t } = useTranslation('devices');
  const [count, setCount] = useState<number | null>(null);
  const [loading, setLoading] = useState(false);
  const [skipped, setSkipped] = useState(false);
  const abortRef = useRef<AbortController | null>(null);

  const isEmpty = !group || group.conditions.length === 0;
  const awaitingValue = !isEmpty && isAwaitingValue(group);

  useEffect(() => {
    if (!group || group.conditions.length === 0 || isAwaitingValue(group)) {
      abortRef.current?.abort();
      setCount(null);
      setLoading(false);
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
        {t('filterPreviewFooter.unavailable')}
      </span>
    );
  }
  if (isEmpty) return null;
  if (awaitingValue) {
    return (
      <span data-testid="filter-preview-hint" className="text-xs text-muted-foreground">
        {t('filterPreviewFooter.awaitingValue')}
      </span>
    );
  }
  return (
    <span data-testid="filter-preview-count" className="text-xs text-muted-foreground">
      {loading ? t('filterPreviewFooter.counting') : count === null ? '' : t('filterPreviewFooter.matches', { count })}
    </span>
  );
}
