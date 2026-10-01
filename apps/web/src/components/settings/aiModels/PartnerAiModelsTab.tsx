import '@/lib/i18n';
import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Loader2 } from 'lucide-react';
import type { AiModelsSnapshotDto } from '@breeze/shared';
import { fetchWithAuth } from '../../../stores/auth';
import { navigateTo } from '@/lib/navigation';
import ConnectionsCard from './ConnectionsCard';
import ModelsCard from './ModelsCard';
import FeatureDefaultsCard from './FeatureDefaultsCard';

/** Snapshot loader shared by the cards; refetch after every mutation (the server computes eligibility). */
export function useAiModelsSnapshot() {
  const [snapshot, setSnapshot] = useState<AiModelsSnapshotDto | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<'forbidden' | 'failed' | null>(null);

  const reload = useCallback(async () => {
    try {
      const res = await fetchWithAuth('/ai/models');
      if (res.status === 401) { void navigateTo('/login', { replace: true }); return; }
      if (res.status === 403) { setError('forbidden'); return; }
      if (!res.ok) { setError('failed'); return; }
      setSnapshot((await res.json()) as AiModelsSnapshotDto);
      setError(null);
    } catch (err) {
      console.error('[PartnerAiModelsTab] failed to load /ai/models', err);
      setError('failed');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void reload(); }, [reload]);
  return { snapshot, loading, error, reload };
}

export default function PartnerAiModelsTab() {
  const { t } = useTranslation('settings');
  const { snapshot, loading, error, reload } = useAiModelsSnapshot();

  if (loading) {
    return (
      <div data-testid="ai-models-loading" className="flex items-center justify-center py-12">
        <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
      </div>
    );
  }
  if (error === 'forbidden') {
    return <p data-testid="ai-models-forbidden" className="text-sm text-muted-foreground">{t('aiModels.forbidden')}</p>;
  }
  if (error || !snapshot) {
    return (
      <div data-testid="ai-models-load-error" className="space-y-3">
        <p className="text-sm text-destructive">{t('aiModels.loadFailed')}</p>
        <button
          type="button"
          data-testid="ai-models-retry"
          onClick={() => { void reload(); }}
          className="rounded-md border px-3 py-1.5 text-sm font-medium transition-colors hover:bg-muted"
        >
          {t('common:actions.retry')}
        </button>
      </div>
    );
  }
  return (
    <div data-testid="ai-models-tab" className="space-y-6">
      <div className="space-y-1">
        <h2 className="text-lg font-semibold">{t('aiModels.title')}</h2>
        <p className="text-sm text-muted-foreground">{t('aiModels.subtitle')}</p>
      </div>
      <ConnectionsCard snapshot={snapshot} onChanged={reload} />
      <ModelsCard snapshot={snapshot} onChanged={reload} />
      <FeatureDefaultsCard snapshot={snapshot} onSaved={reload} />
      <p className="text-xs text-muted-foreground">{t('aiModels.workspaceNote')}</p>
    </div>
  );
}
