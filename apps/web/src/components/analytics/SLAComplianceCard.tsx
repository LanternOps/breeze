import { AlertTriangle, CheckCircle, XCircle } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { cn } from '@/lib/utils';
import { formatPercent } from '@/lib/i18n/format';

type SLAComplianceCardProps = {
  uptime: number;
  target?: number;
  incidents?: number;
  periodLabel?: string;
};

export default function SLAComplianceCard({
  uptime,
  target = 99.9,
  incidents = 0,
  periodLabel
}: SLAComplianceCardProps) {
  const { t } = useTranslation('reports');
  const displayPeriodLabel = periodLabel ?? t('analytics.slaComplianceCard.defaultPeriodLabel');
  const status = uptime >= target ? 'compliant' : uptime >= target - 0.2 ? 'at-risk' : 'breach';
  const statusMeta = {
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
  const Icon = statusMeta.icon;

  return (
    <div className="flex h-full flex-col justify-between rounded-lg border bg-card p-4 shadow-xs">
      <div className="flex items-start justify-between">
        <div>
          <p className="text-sm font-semibold">{t('analytics.slaComplianceCard.title')}</p>
          <p className="text-xs text-muted-foreground">{displayPeriodLabel}</p>
        </div>
        <div className={cn('flex items-center gap-1 text-xs font-medium', statusMeta.className)}>
          <Icon className="h-4 w-4" />
          {statusMeta.label}
        </div>
      </div>
      <div className="mt-4">
        <div className="text-3xl font-semibold">
          {formatPercent(uptime / 100, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
        </div>
        <div className="text-xs text-muted-foreground">
          {t('analytics.slaComplianceCard.targetUptime', { target })}
        </div>
      </div>
      <div className="mt-4 flex items-center justify-between text-xs text-muted-foreground">
        <span>{t('analytics.slaComplianceCard.incidents', { count: incidents })}</span>
        <span>
          {t('analytics.slaComplianceCard.downtime', {
            value: formatPercent(Math.max(0, 100 - uptime) / 100, { minimumFractionDigits: 2, maximumFractionDigits: 2 })
          })}
        </span>
      </div>
    </div>
  );
}

export type { SLAComplianceCardProps };
