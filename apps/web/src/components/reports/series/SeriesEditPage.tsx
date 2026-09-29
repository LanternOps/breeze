import { useEffect, useMemo, useState } from 'react';
import { ArrowLeft, Loader2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
// Islands hydrate independently; initialise i18n here (as ReportEditPage does).
import '../../../lib/i18n';
import { navigateTo } from '@/lib/navigation';
import Breadcrumbs from '../../layout/Breadcrumbs';
import { usePageItemName } from '../../layout/usePageItemName';
import ReportBuilder from '../ReportBuilder';
import { PostureBackupRequiredField } from '../PostureReportOptionsForm';
import {
  DEFAULT_HARDWARE_LIFECYCLE_OPTIONS,
  HardwareLifecycleOptionsFields,
  hardwareLifecycleOptionsFromConfig,
  type HardwareLifecycleOptions,
} from '../HardwareLifecycleOptionsForm';
import { fetchSeriesDetail } from './seriesApi';
import { seriesBuilderDefaults } from './seriesConfig';
import type { SeriesDetail } from './types';

type LoadState = 'loading' | 'ready' | 'not_found' | 'error';

/** /reports/series/:id — edit a multi-org report's shared definition. */
export default function SeriesEditPage({ seriesId }: { seriesId: string }) {
  const { t } = useTranslation('reports');
  const [detail, setDetail] = useState<SeriesDetail | null>(null);
  const [state, setState] = useState<LoadState>('loading');
  const [backupRequired, setBackupRequired] = useState(true);
  const [lifecycleOptions, setLifecycleOptions] = useState<HardwareLifecycleOptions>(DEFAULT_HARDWARE_LIFECYCLE_OPTIONS);

  useEffect(() => {
    let live = true;
    setState('loading');
    fetchSeriesDetail(seriesId)
      .then((loaded) => {
        if (!live) return;
        if (!loaded) {
          setState('not_found');
          return;
        }
        const config = loaded.series.config ?? {};
        setBackupRequired(config.backupRequired !== false);
        setLifecycleOptions(hardwareLifecycleOptionsFromConfig(config));
        setDetail(loaded);
        setState('ready');
      })
      .catch((err: unknown) => {
        if (!live) return;
        console.error('[SeriesEditPage] load failed', err);
        setState('error');
      });
    return () => {
      live = false;
    };
  }, [seriesId]);

  usePageItemName(detail?.series.name);
  const defaultValues = useMemo(() => (detail ? seriesBuilderDefaults(detail.series) : undefined), [detail]);

  const back = (
    <a href="/reports" className="flex h-10 w-10 items-center justify-center rounded-md border hover:bg-muted" aria-label={t('reports.series.editPage.back')}>
      <ArrowLeft className="h-4 w-4" />
    </a>
  );

  if (state === 'loading') {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="h-8 w-8 animate-spin text-primary" />
        <p className="ml-3 text-sm text-muted-foreground">{t('reports.series.editPage.loading')}</p>
      </div>
    );
  }
  if (state !== 'ready' || !detail) {
    return (
      <div className="space-y-6">
        <div className="flex items-center gap-4">{back}<h1 className="text-xl font-semibold tracking-tight">{t('reports.series.editPage.title')}</h1></div>
        <p
          data-testid={state === 'not_found' ? 'series-edit-not-found' : 'series-edit-error'}
          className="rounded-lg border border-destructive/40 bg-destructive/10 p-6 text-center text-sm text-destructive"
        >
          {state === 'not_found' ? t('reports.series.editPage.notFound') : t('reports.series.editPage.loadFailed')}
        </p>
      </div>
    );
  }

  const { series } = detail;
  const config = series.config ?? {};
  // Same fold as ReportEditPage's curatedConfig for the two curated types a
  // series can carry; every other type passes its config through.
  const baseConfig =
    series.type === 'security_compliance_posture'
      ? { ...config, backupRequired }
      : series.type === 'hardware_lifecycle'
        ? { ...config, ...lifecycleOptions }
        : config;

  return (
    <div data-testid="series-edit-page" className="space-y-6">
      <Breadcrumbs items={[{ label: t('reports.series.editPage.breadcrumb'), href: '/reports' }, { label: series.name }]} />
      <div className="flex items-center gap-4">
        {back}
        <div>
          <h1 className="text-xl font-semibold tracking-tight">{t('reports.series.editPage.title')}</h1>
          <p className="text-muted-foreground">{t('reports.series.editPage.description', { name: series.name })}</p>
        </div>
      </div>
      {series.type === 'security_compliance_posture' && (
        <div className="rounded-lg border bg-card p-6 shadow-xs">
          <PostureBackupRequiredField backupRequired={backupRequired} onBackupRequiredChange={setBackupRequired} />
        </div>
      )}
      {series.type === 'hardware_lifecycle' && (
        <div className="rounded-lg border bg-card p-6 shadow-xs">
          <HardwareLifecycleOptionsFields value={lifecycleOptions} onChange={setLifecycleOptions} />
        </div>
      )}
      <ReportBuilder
        mode="edit"
        series={detail}
        defaultValues={defaultValues}
        baseConfig={baseConfig}
        onCancel={() => void navigateTo('/reports')}
      />
    </div>
  );
}
