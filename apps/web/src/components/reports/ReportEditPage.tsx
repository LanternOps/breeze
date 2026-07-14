import { useState, useEffect, useCallback } from 'react';
import { ArrowLeft, Loader2 } from 'lucide-react';
import ReportBuilder, { type ReportBuilderFormValues } from './ReportBuilder';
import type { Report, ReportType } from './ReportsList';
import { fetchWithAuth } from '../../stores/auth';
import { navigateTo } from '@/lib/navigation';
import { runAction } from '@/lib/runAction';
import Breadcrumbs from '../layout/Breadcrumbs';
import { PostureReportOptionsForm } from './PostureReportOptionsForm';
import { useTranslation } from 'react-i18next';
// Initializes the shared i18next singleton. Islands hydrate independently, so
// an island that hydrates before whichever other island happens to pull i18n in
// would otherwise render raw keys (and mismatch the SSR markup).
import '../../lib/i18n';

type ReportEditPageProps = {
  reportId: string;
};

export default function ReportEditPage({ reportId }: ReportEditPageProps) {
  const { t } = useTranslation('reports');
  const [report, setReport] = useState<Report | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const [backupRequired, setBackupRequired] = useState(true);
  const [saving, setSaving] = useState(false);

  const fetchReport = useCallback(async () => {
    try {
      setLoading(true);
      setError(undefined);
      const response = await fetchWithAuth(`/reports/${reportId}`);
      if (!response.ok) {
        throw new Error(t('reports.reportEditPage.errors.fetchReport'));
      }
      const data = await response.json() as Report;
      setReport(data);
      const config = data.config as Record<string, unknown>;
      setBackupRequired(config.backupRequired !== false);
    } catch (err) {
      setError(err instanceof Error ? err.message : t('reports.reportEditPage.errors.generic'));
    } finally {
      setLoading(false);
    }
  }, [reportId, t]);

  useEffect(() => {
    fetchReport();
  }, [fetchReport]);

  const handleSubmit = useCallback(async () => {
    // Report has been updated
    void navigateTo('/reports');
  }, []);

  const handleCancel = useCallback(() => {
    void navigateTo('/reports');
  }, []);

  const handlePostureSubmit = useCallback(async () => {
    if (!report) return;

    const config = report.config as Record<string, unknown>;
    setSaving(true);
    try {
      await runAction({
        request: () => fetchWithAuth(`/reports/${reportId}`, {
          method: 'PUT',
          body: JSON.stringify({
            config: { ...config, backupRequired },
          }),
        }),
        errorFallback: t('reports.reportBuilder.errors.saveReport'),
        successMessage: t('reports.reportBuilder.actions.updateReport'),
        onUnauthorized: () => {
          void navigateTo('/login', { replace: true });
        },
      });
      void navigateTo('/reports');
    } catch {
      // runAction already surfaced the failure (toast, or redirect on 401).
    } finally {
      setSaving(false);
    }
  }, [backupRequired, report, reportId, t]);

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <div className="text-center">
          <Loader2 className="h-8 w-8 animate-spin text-primary mx-auto" />
          <p className="mt-4 text-sm text-muted-foreground">{t('reports.reportEditPage.loading')}</p>
        </div>
      </div>
    );
  }

  if (error || !report) {
    return (
      <div className="space-y-6">
        <div className="flex items-center gap-4">
          <a
            href="/reports"
            className="flex h-10 w-10 items-center justify-center rounded-md border hover:bg-muted"
          >
            <ArrowLeft className="h-4 w-4" />
          </a>
          <h1 className="text-xl font-semibold tracking-tight">{t('reports.reportEditPage.title')}</h1>
        </div>

        <div className="rounded-lg border border-destructive/40 bg-destructive/10 p-6 text-center">
          <p className="text-sm text-destructive">{error || t('reports.reportEditPage.notFound')}</p>
          <a
            href="/reports"
            className="mt-4 inline-block rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:opacity-90"
          >
            {t('reports.reportEditPage.backToReports')}
          </a>
        </div>
      </div>
    );
  }

  // Convert report config to form values
  const config = report.config as Record<string, unknown>;
  const defaultValues: Partial<ReportBuilderFormValues> = {
    name: report.name,
    type: report.type as ReportType,
    schedule: report.schedule,
    format: report.format,
    dateRange: (config.dateRange as ReportBuilderFormValues['dateRange']) || {
      preset: 'last_30_days'
    },
    filters: (config.filters as ReportBuilderFormValues['filters']) || {}
  };

  return (
    <div className="max-w-4xl mx-auto space-y-6">
      <Breadcrumbs items={[
        { label: t('reports.reportEditPage.reportsBreadcrumb'), href: '/reports' },
        { label: report.name || t('reports.reportEditPage.title') }
      ]} />
      <div className="flex items-center gap-4">
        <a
          href="/reports"
          className="flex h-10 w-10 items-center justify-center rounded-md border hover:bg-muted"
        >
          <ArrowLeft className="h-4 w-4" />
        </a>
        <div>
          <h1 className="text-xl font-semibold tracking-tight">{t('reports.reportEditPage.title')}</h1>
          <p className="text-muted-foreground">
            {t('reports.reportEditPage.description', { name: report.name })}
          </p>
        </div>
      </div>

      {report.type === 'security_compliance_posture' ? (
        <div className="rounded-lg border bg-card p-6 shadow-xs">
          <PostureReportOptionsForm
            backupRequired={backupRequired}
            busy={saving}
            submitLabel={t('reports.reportBuilder.actions.updateReport')}
            onBackupRequiredChange={setBackupRequired}
            onSubmit={() => {
              void handlePostureSubmit();
            }}
            onCancel={handleCancel}
          />
        </div>
      ) : (
        <ReportBuilder
          mode="edit"
          reportId={reportId}
          defaultValues={defaultValues}
          onSubmit={handleSubmit}
          onCancel={handleCancel}
        />
      )}
    </div>
  );
}
