import { useTranslation } from 'react-i18next';
import { getErrorMessage } from '@/lib/errorMessages';
import SegmentedBar from './SegmentedBar';
import type { DashboardQueryState } from '../../hooks/useDashboardQuery';
import type { PatchCompliance } from './types';

/**
 * Fleet patch compliance: headline percentage plus the installed / pending /
 * failed split. Hidden when the caller can't read /patches/compliance.
 */
export default function PatchComplianceCard({
  patch,
}: {
  patch: DashboardQueryState<PatchCompliance>;
}) {
  const { t } = useTranslation('common');

  if (patch.unavailable) return null;

  if (patch.isLoading) {
    return (
      <div className="rounded-lg border bg-card p-5 shadow-xs" data-testid="dashboard-patch-compliance-card">
        <div className="skeleton mb-4 h-4 w-32 rounded" />
        <div className="skeleton mb-3 h-9 w-16 rounded" />
        <div className="skeleton h-2 w-full rounded" />
      </div>
    );
  }

  // Visible failure state — a 500 must not look like the permission-hide.
  if (patch.error && !patch.data) {
    return (
      <div className="rounded-lg border bg-card p-5 shadow-xs" data-testid="dashboard-patch-compliance-card">
        <a href="/patches" className="text-sm font-semibold transition-colors hover:text-primary">
          {t('dashboard.patch.title')}
        </a>
        <p className="mt-3 text-xs text-muted-foreground">{getErrorMessage(patch.error)}</p>
      </div>
    );
  }

  const data = patch.data;
  if (!data) return null;

  const { installed, pending, failed } = data.summary;
  const hasAnyPatchData = installed + pending + failed > 0 || data.totalDevices > 0;

  return (
    <div className="rounded-lg border bg-card p-5 shadow-xs" data-testid="dashboard-patch-compliance-card">
      <div className="mb-3 flex items-center justify-between">
        <a href="/patches" className="text-sm font-semibold transition-colors hover:text-primary">
          {t('dashboard.patch.title')}
        </a>
      </div>

      {!hasAnyPatchData ? (
        <p className="mt-1 text-sm text-muted-foreground">{t('dashboard.patch.empty')}</p>
      ) : (
        <>
          <div className="flex items-baseline gap-1.5">
            <span className="text-3xl font-semibold tracking-tight">{Math.round(data.compliancePercent)}%</span>
          </div>
          <p className="mt-0.5 text-xs text-muted-foreground">
            {t('dashboard.patch.devicesCompliant', {
              compliant: data.compliantDevices,
              total: data.totalDevices,
            })}
          </p>

          <div className="mt-3">
            <SegmentedBar
              ariaLabel={t('dashboard.patch.title')}
              segments={[
                { key: 'installed', label: t('dashboard.patch.installed'), count: installed, colorClass: 'bg-success' },
                { key: 'pending', label: t('states.pending'), count: pending, colorClass: 'bg-chart-neutral' },
                { key: 'failed', label: t('dashboard.patch.failed'), count: failed, colorClass: 'bg-destructive' },
              ]}
            />
          </div>

          {data.criticalSummary.pending > 0 && (
            <p className="mt-3 border-t border-border/60 pt-3 text-xs font-medium text-destructive">
              {t('dashboard.patch.criticalPending', { count: data.criticalSummary.pending })}
            </p>
          )}
        </>
      )}
    </div>
  );
}
