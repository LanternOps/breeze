import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { fetchWithAuth } from '../../stores/auth';
import { subscribePartnerCurrencyCache } from '../../lib/partnerCurrencyCache';

export interface WorkTypeOption { id: string; name: string; isActive: boolean }

const LOG_TAG = '[WorkTypeSelect]';

type WorkTypeState = { workTypes: WorkTypeOption[]; loading: boolean; failed: boolean };
const cache: {
  value: WorkTypeOption[] | null;
  inflight: Promise<WorkTypeOption[] | null> | null;
  generation: number;
} = { value: null, inflight: null, generation: 0 };
const listeners = new Set<() => void>();

export function resetWorkTypeCache(): void {
  cache.value = null;
  cache.inflight = null;
  cache.generation += 1;
  listeners.forEach((listener) => listener());
}

// Reuse the auth store's logout reset without introducing a store/component cycle.
subscribePartnerCurrencyCache(resetWorkTypeCache);

async function loadWorkTypes(): Promise<WorkTypeOption[] | null> {
  if (cache.value !== null) return cache.value;
  const generation = cache.generation;
  if (!cache.inflight) {
    const request = (async () => {
      try {
        const response = await fetchWithAuth('/billing-profiles/work-types');
        if (!response.ok) {
          // A disabled picker with nothing in the console is unsupportable:
          // the tech reports "I can't pick a work type" and there is no trace
          // of whether it was a 403, a 500 or a bad payload.
          console.error(LOG_TAG, `work type list request failed with HTTP ${response.status}`);
          return null;
        }
        const body = await response.json();
        if (!Array.isArray(body?.workTypes) || !body.workTypes.every((item: unknown) => {
          if (!item || typeof item !== 'object') return false;
          const option = item as Partial<WorkTypeOption>;
          return typeof option.id === 'string' && typeof option.name === 'string'
            && typeof option.isActive === 'boolean';
        })) {
          console.error(LOG_TAG, 'work type list response was malformed; expected { workTypes: WorkTypeOption[] }');
          return null;
        }
        const options = (body.workTypes as WorkTypeOption[]).filter((option) => option.isActive);
        if (cache.generation === generation) cache.value = options;
        return options;
      } catch (err) {
        // Failed reads are not cached; a later mount can retry.
        console.error(LOG_TAG, err);
        return null;
      }
    })().finally(() => {
      if (cache.inflight === request) cache.inflight = null;
    });
    cache.inflight = request;
  }
  const options = await cache.inflight;
  return cache.generation === generation ? options : loadWorkTypes();
}

export function useWorkTypes(): WorkTypeState {
  const [state, setState] = useState<WorkTypeState>(() => ({
    workTypes: cache.value ?? [], loading: cache.value === null, failed: false,
  }));
  useEffect(() => {
    let cancelled = false;
    const refresh = () => {
      setState({ workTypes: cache.value ?? [], loading: cache.value === null, failed: false });
      void loadWorkTypes().then((options) => {
        if (!cancelled) setState({ workTypes: options ?? [], loading: false, failed: options === null });
      });
    };
    listeners.add(refresh);
    refresh();
    return () => { cancelled = true; listeners.delete(refresh); };
  }, []);
  return state;
}

export default function WorkTypeSelect({ value, onChange, testId, disabled, fallbackOption }: {
  value: string | null;
  onChange: (id: string | null) => void;
  testId: string;
  disabled?: boolean;
  fallbackOption?: WorkTypeOption | null;
}) {
  const { t } = useTranslation('tickets');
  const { workTypes, loading, failed } = useWorkTypes();
  const fallback = fallbackOption && !workTypes.some((option) => option.id === fallbackOption.id)
    ? fallbackOption : null;

  return (
    <select
      data-testid={testId}
      aria-label={t('workType.label')}
      aria-busy={loading}
      value={value ?? ''}
      onChange={(event) => onChange(event.target.value || null)}
      disabled={disabled || loading || failed}
      className="h-10 w-full rounded-md border bg-background px-3 text-sm focus:outline-hidden focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60"
    >
      <option value="">{failed ? t('workType.loadError') : t('workType.none')}</option>
      {workTypes.map((option) => <option key={option.id} value={option.id}>{option.name}</option>)}
      {fallback && (
        <option value={fallback.id}>
          {fallback.isActive ? fallback.name : t('workType.archivedSuffix', { name: fallback.name })}
        </option>
      )}
    </select>
  );
}
