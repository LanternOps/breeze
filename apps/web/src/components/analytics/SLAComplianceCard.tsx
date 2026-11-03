import { AlertTriangle, CheckCircle, XCircle } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { cn } from '@/lib/utils';
import { formatPercent } from '@/lib/i18n/format';

/**
 * What the definition leaves out of the measurement. `maintenance` mirrors the
 * compliance route's `exclusions.maintenanceWindows`: `skipped` / `unavailable`
 * mean the definition asked for the exclusion but the API could not apply it.
 */
export type SlaExclusions = {
  weekends: boolean;
  maintenance: 'off' | 'applied' | 'skipped' | 'unavailable';
};

type SLAComplianceCardProps = {
  /** Null when the definition targets no measurable device yet. */
  uptime: number | null;
  target?: number;
  /** Name of the SLA definition this card reports on. */
  definitionName?: string;
  exclusions?: SlaExclusions;
};

export default function SLAComplianceCard({
  uptime,
  target = 99.9,
  definitionName,
  exclusions
}: SLAComplianceCardProps) {
  const { t } = useTranslation('reports');
  const status = uptime === null
    ? null
    : uptime >= target ? 'compliant' : uptime >= target - 0.2 ? 'at-risk' : 'breach';
  const statusMeta = status === null ? null : {
    compliant: {
      label: t('analytics.slaComplianceCard.status.compliant'),
      icon: CheckCircle,
      className: 'text-success'
    },
    'at-risk': {
      label: t('analytics.slaComplianceCard.status.atRisk'),
      icon: AlertTriangle,
      className: 'text-warning'
    },
    breach: {
      label: t('analytics.slaComplianceCard.status.breach'),
      icon: XCircle,
      className: 'text-destructive'
    }
  }[status];
  const Icon = statusMeta?.icon;

  const exclusionLabels: string[] = [];
  if (exclusions?.weekends) exclusionLabels.push(t('analytics.slaComplianceCard.exclusions.weekends'));
  if (exclusions?.maintenance === 'applied') {
    exclusionLabels.push(t('analytics.slaComplianceCard.exclusions.maintenanceApplied'));
  } else if (exclusions?.maintenance === 'skipped') {
    exclusionLabels.push(t('analytics.slaComplianceCard.exclusions.maintenanceSkipped'));
  } else if (exclusions?.maintenance === 'unavailable') {
    exclusionLabels.push(t('analytics.slaComplianceCard.exclusions.maintenanceUnavailable'));
  }

  return (
    <div
      className="flex h-full flex-col justify-between rounded-lg border bg-card p-4 shadow-xs"
      data-testid="analytics-sla-card"
    >
      <div className="flex items-start justify-between">
        <div>
          <p className="text-sm font-semibold">{t('analytics.slaComplianceCard.title')}</p>
          {definitionName && <p className="text-xs text-muted-foreground">{definitionName}</p>}
        </div>
        {statusMeta && Icon && (
          <div className={cn('flex items-center gap-1 text-xs font-medium', statusMeta.className)}>
            <Icon className="h-4 w-4" />
            {statusMeta.label}
          </div>
        )}
      </div>
      <div className="mt-4">
        {uptime === null ? (
          <div className="text-sm text-muted-foreground">{t('analytics.slaComplianceCard.noDevices')}</div>
        ) : (
          <div className="text-3xl font-semibold">
            {formatPercent(uptime / 100, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
          </div>
        )}
        <div className="text-xs text-muted-foreground">
          {t('analytics.slaComplianceCard.targetUptime', { target })}
        </div>
      </div>
      {exclusions && (
        <div className="mt-4">
          <p className="text-xs font-medium">{t('analytics.slaComplianceCard.exclusions.title')}</p>
          <ul className="mt-1 space-y-0.5 text-xs text-muted-foreground" data-testid="analytics-sla-exclusions">
            {exclusionLabels.length === 0 ? (
              <li>{t('analytics.slaComplianceCard.exclusions.none')}</li>
            ) : (
              exclusionLabels.map(label => <li key={label}>{label}</li>)
            )}
          </ul>
        </div>
      )}
      {uptime !== null && (
        <div className="mt-4 flex items-center justify-end text-xs text-muted-foreground">
          <span>
            {t('analytics.slaComplianceCard.downtime', {
              value: formatPercent(Math.max(0, 100 - uptime) / 100, { minimumFractionDigits: 2, maximumFractionDigits: 2 })
            })}
          </span>
        </div>
      )}
    </div>
  );
}

export type { SLAComplianceCardProps };
