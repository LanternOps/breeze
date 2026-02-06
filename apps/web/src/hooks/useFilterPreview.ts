import { useState, useEffect, useCallback, useRef } from 'react';
import type { FilterCondition, FilterConditionGroup, FilterPreviewResult } from '@breeze/shared';
import { fetchWithAuth } from '../stores/auth';

function isConditionGroup(item: FilterCondition | FilterConditionGroup): item is FilterConditionGroup {
  return 'conditions' in item;
}

function hasValidConditions(filter: FilterConditionGroup): boolean {
  return filter.conditions.some(c => {
    if (isConditionGroup(c)) {
      return c.conditions.length > 0 && hasValidConditions(c);
    }
    return c.value !== '' && c.value !== null && c.value !== undefined;
  });
}

interface UseFilterPreviewOptions {
  debounceMs?: number;
  enabled?: boolean;
  limit?: number;
}

interface UseFilterPreviewReturn {
  preview: FilterPreviewResult | null;
  loading: boolean;
  error: string | null;
  refresh: () => void;
}

export function useFilterPreview(
  filter: FilterConditionGroup | null,
  options: UseFilterPreviewOptions = {}
): UseFilterPreviewReturn {
  const { debounceMs = 500, enabled = true, limit } = options;
  const [preview, setPreview] = useState<FilterPreviewResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const fetchPreview = useCallback(async (conditions: FilterConditionGroup) => {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    setLoading(true);
    setError(null);

    try {
      const response = await fetchWithAuth('/filters/preview', {
        method: 'POST',
        body: JSON.stringify({ conditions, limit }),
        signal: controller.signal
      });

      if (!response.ok) {
        throw new Error('Failed to fetch preview');
      }

      const data = await response.json();
      setPreview(data.data ?? data);
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') return;
      setError(err instanceof Error ? err.message : 'Failed to fetch preview');
    } finally {
      setLoading(false);
    }
  }, [limit]);

  useEffect(() => {
    if (!enabled || !filter || !hasValidConditions(filter)) {
      setPreview(null);
      return;
    }

    const timer = setTimeout(() => {
      fetchPreview(filter);
    }, debounceMs);

    return () => clearTimeout(timer);
  }, [filter, enabled, debounceMs, fetchPreview]);

  useEffect(() => {
    return () => abortRef.current?.abort();
  }, []);

  const refresh = useCallback(() => {
    if (filter && hasValidConditions(filter)) {
      fetchPreview(filter);
    }
  }, [filter, fetchPreview]);

  return { preview, loading, error, refresh };
}
