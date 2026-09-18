// Composes the Monitoring tab. Loading and error live here so one failed read
// cannot take the whole tab down (useAssetMonitoring only sets `error` when the
// asset call itself failed — the other three degrade their own panel).

import { useTranslation } from 'react-i18next';
import { NetworkChecksSection } from './NetworkChecksSection';
import { MetricHistoryCharts } from './MetricHistoryCharts';
import { OidTable } from './OidTable';
import { PollConfigSummary } from './PollConfigSummary';
import { ThresholdAlertsSection } from './ThresholdAlertsSection';
import { useAssetMonitoring } from './useAssetMonitoring';

export function MonitoringTab({
  assetId,
  timezone,
  onOpenMonitoringSettings,
}: {
  assetId: string;
  timezone: string;
  onOpenMonitoringSettings: () => void;
}) {
  const { t } = useTranslation('devices');
  const { collection, snmpDevice, templateName, checks, thresholds, checksError, thresholdsError, templateError, loading, error, reload } =
    useAssetMonitoring(assetId);

  if (loading) {
    return (
      <div
        className="space-y-3 rounded-md border bg-card p-4 animate-pulse motion-reduce:animate-none"
        data-testid="network-detail-monitoring-loading"
        aria-busy="true"
        aria-label={t('networkDeviceDetailPage.loadingMonitoring')}
      >
        {[0, 1, 2].map((row) => (
          <div key={row} className="h-4 w-full rounded bg-muted" />
        ))}
      </div>
    );
  }

  if (error) {
    return (
      <div className="rounded-md border border-destructive/40 bg-destructive/10 p-4" data-testid="network-detail-monitoring-error">
        <p className="text-sm text-destructive">{error}</p>
        <button
          type="button"
          data-testid="network-detail-monitoring-retry"
          onClick={() => void reload()}
          className="mt-2 rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground hover:opacity-90 focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring"
        >
          {t('networkDeviceDetailPage.tryAgain')}
        </button>
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <PollConfigSummary
        collection={collection}
        snmpDevice={snmpDevice}
        templateName={templateName}
        timezone={timezone}
        onEdit={onOpenMonitoringSettings}
        templateError={templateError}
        onRetry={() => void reload()}
      />
      <OidTable collection={collection} timezone={timezone} />
      <MetricHistoryCharts assetId={assetId} collection={collection} timezone={timezone} />
      <NetworkChecksSection checks={checks} timezone={timezone} onAddCheck={onOpenMonitoringSettings} checksError={checksError} onRetry={() => void reload()} />
      <ThresholdAlertsSection thresholds={thresholds} collection={collection} thresholdsError={thresholdsError} onRetry={() => void reload()} />
    </div>
  );
}
