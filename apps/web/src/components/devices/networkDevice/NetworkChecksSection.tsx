// The network checks bound to this asset, with their latest result. Uses the
// same "<state> · <relative>" shape as everything else on the page — a check
// row that said only "offline" would be the copy rule's own violation.

import { useTranslation } from 'react-i18next';
import EmptyState from '../../shared/EmptyState';
import { formatLastSeen } from '@/lib/formatTime';
import { formatPing } from '../../discovery/pingFormat';
import { Section } from './primitives';
import { formatAbsolute } from './reachabilityCopy';
import type { NetworkCheckSummary } from './useAssetMonitoring';

const STATUS_CLASSES: Record<string, string> = {
  online: 'text-success',
  degraded: 'text-warning',
  offline: 'text-destructive',
};

export function NetworkChecksSection({
  checks,
  timezone,
  onAddCheck,
  checksError = false,
  onRetry,
}: {
  checks: NetworkCheckSummary[];
  timezone: string;
  onAddCheck: () => void;
  checksError?: boolean;
  onRetry?: () => void;
}) {
  const { t } = useTranslation('devices');

  return (
    <Section title={t('networkDeviceDetailPage.sections.networkChecks')} testId="network-detail-checks">
      {checksError ? (
        <div>
          <p className="text-sm text-destructive" data-testid="network-detail-checks-error">
            {t('networkDeviceDetailPage.errors.checksLoad')}
          </p>
          <button
            type="button"
            data-testid="network-detail-checks-retry"
            onClick={onRetry}
            className="mt-2 text-xs text-primary hover:underline focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring"
          >
            {t('networkDeviceDetailPage.tryAgain')}
          </button>
        </div>
      ) : checks.length === 0 ? (
        <EmptyState
          variant="plain"
          size="sm"
          testId="network-detail-checks-empty"
          title={t('networkDeviceDetailPage.checks.emptyTitle')}
          description={t('networkDeviceDetailPage.checks.emptyDescription')}
          action={
            <button
              type="button"
              data-testid="network-detail-add-check"
              onClick={onAddCheck}
              className="rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground hover:opacity-90 focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring"
            >
              {t('networkDeviceDetailPage.checks.add')}
            </button>
          }
        />
      ) : (
        <ul className="divide-y text-sm">
          {checks.map((check) => {
            const statusLabel = check.lastStatus
              ? t(/* i18n-dynamic */ `networkDeviceDetailPage.checks.status.${check.lastStatus}`)
              : t('networkDeviceDetailPage.checks.status.never');
            const parts = [statusLabel];
            if (check.lastResponseMs !== null) parts.push(formatPing(check.lastResponseMs));
            if (check.lastChecked) parts.push(formatLastSeen(check.lastChecked, timezone));
            return (
              <li key={check.id} className="py-2" data-testid={`network-detail-check-${check.id}`}>
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <span className="font-medium">
                    {check.name}
                    <span className="ml-1 font-mono text-xs font-normal text-muted-foreground">
                      {check.monitorType} · {check.target}
                    </span>
                  </span>
                  <span
                    className={STATUS_CLASSES[check.lastStatus ?? ''] ?? 'text-muted-foreground'}
                    title={check.lastChecked ? formatAbsolute(check.lastChecked, timezone) : undefined}
                  >
                    {parts.join(' · ')}
                  </span>
                </div>
                {!check.isActive && (
                  <p className="text-xs text-muted-foreground">{t('networkDeviceDetailPage.checks.paused')}</p>
                )}
                {check.lastError && (
                  <p className="text-xs text-destructive" data-testid={`network-detail-check-error-${check.id}`}>
                    {check.lastError}
                  </p>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </Section>
  );
}
