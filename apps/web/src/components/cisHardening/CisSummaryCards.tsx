import { Activity, AlertTriangle, ClipboardCheck, Layers } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { CisSummary } from './types';

interface CisSummaryCardsProps {
  summary: CisSummary | null;
  baselinesCount: number;
  pendingRemediations: number;
}

export default function CisSummaryCards({ summary, baselinesCount, pendingRemediations }: CisSummaryCardsProps) {
  const score = summary?.averageScore ?? 0;
  const scoreColor = score >= 80 ? 'text-emerald-600' : score >= 60 ? 'text-amber-600' : 'text-red-600';
  const barColor = score >= 80 ? 'bg-emerald-500' : score >= 60 ? 'bg-amber-500' : 'bg-red-500';
  const failingDevices = summary?.failingDevices ?? 0;

  return (
    <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
      <div className="rounded-lg border bg-card p-4 shadow-sm">
        <div className="flex items-center gap-3">
          <div className="rounded-full border bg-muted/30 p-2">
            <Activity className="h-4 w-4 text-muted-foreground" />
          </div>
          <div className="min-w-0">
            <p className="text-xs text-muted-foreground">Average Score</p>
            <p className={cn('text-xl font-semibold', scoreColor)}>{Math.round(score)}%</p>
          </div>
        </div>
        <div className="mt-3 h-1.5 w-full rounded-full bg-muted">
          <div className={cn('h-1.5 rounded-full', barColor)} style={{ width: `${score}%` }} />
        </div>
      </div>

      <div className="rounded-lg border bg-card p-4 shadow-sm">
        <div className="flex items-center gap-3">
          <div className="rounded-full border bg-muted/30 p-2">
            <AlertTriangle className="h-4 w-4 text-muted-foreground" />
          </div>
          <div className="min-w-0">
            <p className="text-xs text-muted-foreground">Failing Devices</p>
            <p className={cn('text-xl font-semibold', failingDevices > 0 ? 'text-red-600' : 'text-foreground')}>
              {failingDevices}
            </p>
          </div>
        </div>
      </div>

      <div className="rounded-lg border bg-card p-4 shadow-sm">
        <div className="flex items-center gap-3">
          <div className="rounded-full border bg-muted/30 p-2">
            <Layers className="h-4 w-4 text-muted-foreground" />
          </div>
          <div className="min-w-0">
            <p className="text-xs text-muted-foreground">Active Baselines</p>
            <p className="text-xl font-semibold">{baselinesCount}</p>
          </div>
        </div>
      </div>

      <div className="rounded-lg border bg-card p-4 shadow-sm">
        <div className="flex items-center gap-3">
          <div className="rounded-full border bg-muted/30 p-2">
            <ClipboardCheck className="h-4 w-4 text-muted-foreground" />
          </div>
          <div className="min-w-0">
            <p className="text-xs text-muted-foreground">Pending Remediations</p>
            <p className={cn('text-xl font-semibold', pendingRemediations > 0 ? 'text-amber-600' : 'text-foreground')}>
              {pendingRemediations}
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
