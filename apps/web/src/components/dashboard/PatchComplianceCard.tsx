import { useTranslation } from 'react-i18next';
import { getErrorMessage } from '@/lib/errorMessages';
import { cn } from '@/lib/utils';
import SegmentedBar from './SegmentedBar';
import { DashboardMetric } from './DashboardMetric';
import type { DashboardQueryState } from '../../hooks/useDashboardQuery';
import type { PatchCompliance } from './types';

/**
 * The device percentage (#9791 C, Decision 4): the API's devicePercent, or the
 * same figure from the counts when an older API omits it. An empty fleet has
 * no percentage; callers render their empty state instead.
 */
export function patchDevicePercent(data: Pick<PatchCompliance, 'devicePercent' | 'compliantDevices' | 'totalDevices'>): number {
  if (typeof data.devicePercent === 'number') return data.devicePercent;
  return data.totalDevices > 0 ? Math.round((data.compliantDevices / data.totalDevices) * 100) : 0;
}

/**
 * Fleet patch compliance: headline device percentage plus the installed /
 * pending / failed split. Hidden when the caller can't read /patches/compliance.
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
        <DashboardMetric metric="patch.title" className="text-sm font-semibold no-underline transition-colors hover:text-primary">
          {t('dashboard.patch.title')}
        </DashboardMetric>
        <p className="mt-3 text-xs text-muted-foreground">{getErrorMessage(patch.error)}</p>
      </div>
    );
  }

  const data = patch.data;
  if (!data) return null;

  const { installed, pending, failed } = data.summary;
  // Every number below describes devices; with none there is nothing to claim.
  const hasDevices = data.totalDevices > 0;
  const nonCompliantDevices = Math.max(0, data.totalDevices - data.compliantDevices);
  const failedDevices = data.failedDevices ?? 0;

  return (
    <div className="rounded-lg border bg-card p-5 shadow-xs" data-testid="dashboard-patch-compliance-card">
      <div className="mb-3 flex items-center justify-between">
        <DashboardMetric metric="patch.title" className="text-sm font-semibold no-underline transition-colors hover:text-primary">
          {t('dashboard.patch.title')}
        </DashboardMetric>
      </div>

      {!hasDevices ? (
        <p className="mt-1 text-sm text-muted-foreground">{t('dashboard.patch.empty')}</p>
      ) : (
        <>
          <div className="flex items-baseline gap-1.5">
            <DashboardMetric metric="patch.headline" className="text-3xl font-semibold tracking-tight">
              {patchDevicePercent(data)}%
            </DashboardMetric>
          </div>
          <p className="mt-0.5 flex flex-wrap gap-x-2 text-xs text-muted-foreground">
            <DashboardMetric metric="patch.devicesCompliant">
              {t('dashboard.patch.devicesCompliant', {
                compliant: data.compliantDevices,
                total: data.totalDevices,
              })}
            </DashboardMetric>
            {nonCompliantDevices > 0 && (
              <DashboardMetric metric="patch.devicesNonCompliant">
                {t('dashboard.patch.devicesNeedPatches', { count: nonCompliantDevices })}
              </DashboardMetric>
            )}
          </p>
          {(data.containerImages?.unknown ?? 0) > 0 && (
            <p className="mt-0.5 text-xs text-muted-foreground">
              <DashboardMetric metric="patch.imagesNotChecked">
                {t('dashboard.patch.imagesNotChecked', { count: data.containerImages!.unknown })}
              </DashboardMetric>
            </p>
          )}

          <div className="mt-3">
            <SegmentedBar
              ariaLabel={t('dashboard.patch.title')}
              segments={[
                { key: 'installed', metric: 'patch.installed', label: t('dashboard.patch.installed'), count: installed, colorClass: 'bg-success' },
                { key: 'pending', metric: 'patch.pending', label: t('states.pending'), count: pending, colorClass: 'bg-chart-neutral' },
                { key: 'failed', metric: 'patch.failed', label: t('dashboard.patch.failed'), count: failed, colorClass: 'bg-destructive' },
              ]}
            />
          </div>
          {/* The bar counts patches, not devices: named "affected" links open
              the devices behind them. Failed gates on failedDevices so the
              link never opens an empty list. */}
          {(pending > 0 || failedDevices > 0) && (
            <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
              {pending > 0 && (
                <DashboardMetric metric="patch.viewPendingDevices">{t('dashboard.patch.viewPendingDevices')}</DashboardMetric>
              )}
              {failedDevices > 0 && (
                <DashboardMetric metric="patch.viewFailedDevices">{t('dashboard.patch.viewFailedDevices')}</DashboardMetric>
              )}
            </div>
          )}

          {data.criticalSummary.pending > 0 && (
            <p className="mt-3 flex flex-wrap gap-x-3 border-t border-border/60 pt-3 text-xs font-medium text-destructive">
              <DashboardMetric metric="patch.criticalPending">
                {t('dashboard.patch.criticalPending', { count: data.criticalSummary.pending })}
              </DashboardMetric>
              <DashboardMetric metric="patch.viewCriticalDevices" className="font-normal text-muted-foreground">
                {t('dashboard.patch.viewCriticalDevices')}
              </DashboardMetric>
            </p>
          )}
          {data.unratedSummary.pending > 0 && (
            <p
              className={cn(
                'text-xs font-medium text-muted-foreground',
                data.criticalSummary.pending > 0 ? 'mt-1' : 'mt-3 border-t border-border/60 pt-3'
              )}
            >
              <DashboardMetric metric="patch.unratedPending">
                {t('dashboard.patch.unratedPending', { count: data.unratedSummary.pending })}
              </DashboardMetric>
            </p>
          )}
        </>
      )}
    </div>
  );
}
