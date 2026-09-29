import { useState } from 'react';
import { Pause, Play } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { handleActionError } from '@/lib/runAction';
import { updateSeries } from './seriesApi';
import type { SeriesDetail } from './types';

/**
 * Pause / Resume a whole series (coordinator ruling): PATCH { enabled }. W02
 * reconciles on the change and its worker gate skips every child of a disabled
 * series. Used on the list row and in the drill-down header.
 */
export function SeriesPauseButton({ detail, onChanged, testId }: { detail: SeriesDetail; onChanged: () => void; testId: string }) {
  const { t } = useTranslation('reports');
  const [busy, setBusy] = useState(false);
  const { series } = detail;
  const enabled = series.enabled !== false;

  const toggle = async () => {
    setBusy(true);
    try {
      await updateSeries(series.id, { enabled: !enabled }, {
        errorFallback: t('reports.series.list.pauseFailed'),
        successMessage: enabled
          ? t('reports.series.list.paused', { name: series.name })
          : t('reports.series.list.resumed', { name: series.name }),
      });
      onChanged();
    } catch (err) {
      handleActionError(err, t('reports.series.list.pauseFailed'));
    } finally {
      setBusy(false);
    }
  };

  const label = enabled ? t('reports.series.list.actions.pause') : t('reports.series.list.actions.resume');
  return (
    <button
      type="button"
      data-testid={testId}
      data-enabled={String(enabled)}
      disabled={busy}
      onClick={() => void toggle()}
      title={label}
      className="inline-flex h-8 items-center gap-1 rounded-md border px-2 text-xs hover:bg-muted disabled:opacity-50"
    >
      {enabled ? <Pause className="h-3 w-3" /> : <Play className="h-3 w-3" />}
      {label}
    </button>
  );
}

export function SeriesPausedBadge({ testId }: { testId: string }) {
  const { t } = useTranslation('reports');
  return (
    <span
      data-testid={testId}
      title={t('reports.series.list.pausedTitle')}
      className="inline-flex items-center rounded-full bg-warning/15 px-2 py-0.5 text-xs font-medium"
    >
      {t('reports.series.list.pausedBadge')}
    </span>
  );
}
