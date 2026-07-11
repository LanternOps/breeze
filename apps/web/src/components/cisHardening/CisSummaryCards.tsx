import { Activity, AlertTriangle, ClipboardCheck, Layers } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import '@/lib/i18n';
import { cn } from '@/lib/utils';
import type { CisSummary } from './types';
import HelpTooltip from '../shared/HelpTooltip';

interface CisSummaryCardsProps {
  summary: CisSummary | null;
  baselinesCount: number;
  pendingRemediations: number;
}

export default function CisSummaryCards({ summary, baselinesCount, pendingRemediations }: CisSummaryCardsProps) {
  const { t } = useTranslation('security');
  const score = summary?.averageScore ?? 0;
  const scoreColor = score >= 80 ? 'text-emerald-600' : score >= 60 ? 'text-amber-600' : 'text-red-600';
  const barColor = score >= 80 ? 'bg-emerald-500' : score >= 60 ? 'bg-amber-500' : 'bg-red-500';
  const failingDevices = summary?.failingDevices ?? 0;

  return (
    <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
      <div className="rounded-lg border bg-card p-4 shadow-xs">
        <div className="flex items-center gap-3">
          <div className="rounded-full border bg-muted/30 p-2">
            <Activity className="h-4 w-4 text-muted-foreground" />
          </div>
          <div className="min-w-0">
            <p className="text-xs text-muted-foreground">
              {t('cisHardeningCisSummaryCards.averageScore')}
              <HelpTooltip text={t('cisHardeningCisSummaryCards.averageScoreTooltip')} />
            </p>
            <p className={cn('text-xl font-semibold', scoreColor)}>{Math.round(score)}%</p>
          </div>
        </div>
        <div className="mt-3 h-1.5 w-full rounded-full bg-muted">
          <div className={cn('h-1.5 rounded-full', barColor)} style={{ width: `${score}%` }} />
        </div>
      </div>

      <div className="rounded-lg border bg-card p-4 shadow-xs">
        <div className="flex items-center gap-3">
          <div className="rounded-full border bg-muted/30 p-2">
            <AlertTriangle className="h-4 w-4 text-muted-foreground" />
          </div>
          <div className="min-w-0">
            <p className="text-xs text-muted-foreground">{t('cisHardeningCisSummaryCards.failingDevices')}</p>
            <p className={cn('text-xl font-semibold', failingDevices > 0 ? 'text-red-600' : 'text-foreground')}>
              {failingDevices}
            </p>
          </div>
        </div>
      </div>

      <div className="rounded-lg border bg-card p-4 shadow-xs">
        <div className="flex items-center gap-3">
          <div className="rounded-full border bg-muted/30 p-2">
            <Layers className="h-4 w-4 text-muted-foreground" />
          </div>
          <div className="min-w-0">
            <p className="text-xs text-muted-foreground">{t('cisHardeningCisSummaryCards.activeBaselines')}</p>
            <p className="text-xl font-semibold">{baselinesCount}</p>
          </div>
        </div>
      </div>

      <div className="rounded-lg border bg-card p-4 shadow-xs">
        <div className="flex items-center gap-3">
          <div className="rounded-full border bg-muted/30 p-2">
            <ClipboardCheck className="h-4 w-4 text-muted-foreground" />
          </div>
          <div className="min-w-0">
            <p className="text-xs text-muted-foreground">
              {t('cisHardeningCisSummaryCards.pendingRemediations')}
              <HelpTooltip text={t('cisHardeningCisSummaryCards.pendingRemediationsTooltip')} />
            </p>
            <p className={cn('text-xl font-semibold', pendingRemediations > 0 ? 'text-amber-600' : 'text-foreground')}>
              {pendingRemediations}
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
