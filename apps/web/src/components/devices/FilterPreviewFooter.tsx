// FilterPreviewFooter — spec 4.5. Calls `POST /api/v1/devices/filter-preview` with
// the in-progress FilterConditionGroup and renders `~{N} devices match`.
// Debounced 350ms so each keystroke in a value input doesn't fire a request.
// If the endpoint returns 404 the footer goes silent so old API builds don't
// log noise (the spec says: "If the endpoint returns 404 in your tests,
// leave a TODO and skip"). TODO: drop the 404 fallback once the backend
// preview endpoint is live everywhere.
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { FilterCondition, FilterConditionGroup } from '@breeze/shared';
import { fetchWithAuth } from '../../stores/auth';
import { NO_VALUE_OPERATORS } from './filterMigration';

function isGroup(c: FilterCondition | FilterConditionGroup): c is FilterConditionGroup {
  return Array.isArray((c as FilterConditionGroup).conditions);
}

function isBlank(v: unknown): boolean {
  if (v === null || v === undefined) return true;
  if (typeof v === 'string') return v.trim() === '';
  if (typeof v === 'number') return Number.isNaN(v);
  if (Array.isArray(v)) return v.length === 0;
  return false;
}

function conditionAwaitingValue(c: FilterCondition): boolean {
  if (NO_VALUE_OPERATORS.includes(c.operator)) return false;
  const v = c.value as unknown;
  if (isBlank(v)) return true;
  // Range / relative-date shapes ({from,to}, {amount,unit}): incomplete while
  // any part is still blank. Date instances are complete values.
  if (typeof v === 'object' && !(v instanceof Date)) {
    return Object.values(v as Record<string, unknown>).some(isBlank);
  }
  return false;
}

function collectLeaves(group: FilterConditionGroup, out: FilterCondition[] = []): FilterCondition[] {
  for (const c of group.conditions) {
    if (isGroup(c)) collectLeaves(c, out);
    else out.push(c);
  }
  return out;
}

// True when the group has conditions but none of them has a value yet (e.g. a
// Site / Device Group chip opened with nothing ticked). Previewing such a group
// returns a meaningless "~0 devices match" (#9857), so the footer shows a hint
// instead. A partly filled group (sentence builder with one blank row) still
// previews, as it did before.
export function isAwaitingValue(group: FilterConditionGroup): boolean {
  const leaves = collectLeaves(group);
  return leaves.length > 0 && leaves.every(conditionAwaitingValue);
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
