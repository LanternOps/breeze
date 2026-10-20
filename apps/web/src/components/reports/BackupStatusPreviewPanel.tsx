import { useCallback, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { fetchWithAuth } from '../../stores/auth';
import ReportPreview from './ReportPreview';
import { getBrowserTimezone } from './reportExport';

type PreviewData = React.ComponentProps<typeof ReportPreview>['data'];

type Props = {
  /** The report's own org; omitted for a partner-owned report. */
  orgId: string | null;
  /** The stored config merged with the options form, exactly what a save would persist. */
  config: Record<string, unknown>;
};

/**
 * On-demand preview for the Backup Status report (#7506). The report builds a
 * full snapshot (up to 20,000 devices x 28 days), so unlike the freeform
 * builder's debounced preview this only runs when the user asks.
 */
export default function BackupStatusPreviewPanel({ orgId, config }: Props) {
  const { t } = useTranslation('reports');
  const [data, setData] = useState<PreviewData>();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string>();

  const run = useCallback(async () => {
    setLoading(true);
    setError(undefined);
    try {
      // runaction-exempt: read-only generation, not a mutation; failures render inline below.
      const response = await fetchWithAuth('/reports/generate', {
        method: 'POST',
        body: JSON.stringify({
          type: 'backup_status',
          config,
          format: 'pdf',
          ...(orgId ? { orgId } : {}),
        }),
      });
      if (!response.ok) throw new Error(t('reports.reportEditPage.backupPreview.error'));
      setData(await response.json());
    } catch (err) {
      setError(err instanceof Error ? err.message : t('reports.reportEditPage.backupPreview.error'));
    } finally {
      setLoading(false);
    }
  }, [config, orgId, t]);

  return (
    <div className="rounded-lg border bg-card p-6 shadow-xs space-y-4">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 className="text-lg font-semibold">{t('reports.reportEditPage.backupPreview.title')}</h2>
          <p className="text-sm text-muted-foreground">{t('reports.reportEditPage.backupPreview.description')}</p>
        </div>
        <button
          type="button"
          data-testid="backup-status-preview-run"
          onClick={run}
          disabled={loading}
          className="inline-flex h-10 shrink-0 items-center gap-2 rounded-md border px-4 text-sm font-medium hover:bg-muted disabled:opacity-60"
        >
          {loading && <Loader2 className="h-4 w-4 animate-spin" />}
          {t('reports.reportEditPage.backupPreview.run')}
        </button>
      </div>
      {error && (
        <p data-testid="backup-status-preview-error" role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      {data && !loading && <ReportPreview data={data} timezone={getBrowserTimezone()} />}
    </div>
  );
}
