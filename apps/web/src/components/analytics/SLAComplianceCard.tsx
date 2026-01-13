import { AlertTriangle, CheckCircle, XCircle } from 'lucide-react';
import { cn } from '@/lib/utils';

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
  periodLabel = 'Last 30 days'
}: SLAComplianceCardProps) {
  const status = uptime >= target ? 'compliant' : uptime >= target - 0.2 ? 'at-risk' : 'breach';
  const statusMeta = {
    compliant: {
      label: 'Compliant',
      icon: CheckCircle,
      className: 'text-success'
    },
    'at-risk': {
      label: 'At risk',
      icon: AlertTriangle,
      className: 'text-warning'
    },
    breach: {
      label: 'Breach',
      icon: XCircle,
      className: 'text-destructive'
    }
  }[status];
  const Icon = statusMeta.icon;

  return (
    <div className="flex h-full flex-col justify-between rounded-lg border bg-card p-4 shadow-sm">
      <div className="flex items-start justify-between">
        <div>
          <p className="text-sm font-semibold">SLA Compliance</p>
          <p className="text-xs text-muted-foreground">{periodLabel}</p>
        </div>
        <div className={cn('flex items-center gap-1 text-xs font-medium', statusMeta.className)}>
          <Icon className="h-4 w-4" />
          {statusMeta.label}
        </div>
      </div>
      <div className="mt-4">
        <div className="text-3xl font-semibold">
          {uptime.toFixed(2)}%
        </div>
        <div className="text-xs text-muted-foreground">Target {target}% uptime</div>
      </div>
      <div className="mt-4 flex items-center justify-between text-xs text-muted-foreground">
        <span>{incidents} incidents</span>
        <span>Downtime {Math.max(0, (100 - uptime)).toFixed(2)}%</span>
      </div>
    </div>
  );
}

export type { SLAComplianceCardProps };
