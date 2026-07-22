import { Monitor, CheckCircle, AlertTriangle, XCircle, Ticket, ShieldCheck, ArrowRight, AlertCircle } from 'lucide-react';
import { cn } from '@/lib/utils';
import { getErrorMessage, getErrorTitle } from '@/lib/errorMessages';
import { useTranslation } from 'react-i18next';
import { formatNumber } from '@/lib/i18n/format';
import type { DashboardQueryState } from '../../hooks/useDashboardQuery';
import type { AlertsSummary, DeviceStats, PatchCompliance, TicketStats } from './types';

interface Tile {
  key: string;
  testId: string;
  label: string;
  value: string;
  sub?: string;
  subTone?: 'muted' | 'success' | 'warning' | 'destructive';
  icon: typeof Monitor;
  iconTone: string;
  href: string;
}

const GRID_BY_COUNT: Record<number, string> = {
  4: 'xl:grid-cols-4',
  5: 'xl:grid-cols-5',
  6: 'xl:grid-cols-6',
};

/**
 * The KPI row. Device/alert tiles always render — alert tiles show "—"
 * rather than a fabricated 0 when the summary can't be loaded. Tickets and
 * patch compliance drop out when the caller lacks the permission, the
 * feature isn't enabled, or their slot hasn't loaded yet (the grid
 * re-balances); on a load *failure* they degrade to a "—" tile instead of
 * silently disappearing.
 */
export default function KpiStrip({
  devices,
  alerts,
  tickets,
  patch,
  onRetry,
}: {
  devices: DashboardQueryState<DeviceStats>;
  alerts: DashboardQueryState<AlertsSummary>;
  tickets: DashboardQueryState<TicketStats>;
  patch: DashboardQueryState<PatchCompliance>;
  onRetry: () => void;
}) {
  const { t } = useTranslation('common');

  if (devices.isLoading || alerts.isLoading) {
    return (
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-6" data-testid="dashboard-stats">
        {[0, 1, 2, 3, 4, 5].map((i) => (
          <div key={i} className="rounded-lg border bg-card px-4 py-3">
            <div className="skeleton mb-2 h-3 w-16 rounded" />
            <div className="skeleton h-7 w-12 rounded" />
          </div>
        ))}
      </div>
    );
  }

  if (!devices.data && (devices.error || alerts.error)) {
    const err = devices.error ?? alerts.error;
    return (
      <div className="rounded-lg border bg-card px-6 py-4" data-testid="dashboard-stats">
        <div className="flex flex-col items-center justify-center py-6 text-center">
          <div className="mb-3 rounded-full bg-destructive/10 p-3">
            <AlertCircle className="h-5 w-5 text-destructive" />
          </div>
          <p className="mb-1 text-sm font-medium text-foreground">{getErrorTitle(err)}</p>
          <p className="mb-3 text-xs text-muted-foreground">{getErrorMessage(err)}</p>
          <button onClick={onRetry} className="text-xs font-medium text-primary hover:underline">
            {t('actions.retry')}
          </button>
        </div>
      </div>
    );
  }

  if (!devices.data) return null;

  if (devices.data.total === 0) {
    return (
      <div
        className="flex items-center gap-4 rounded-lg border border-dashed border-primary/30 bg-primary/5 px-6 py-5"
        data-testid="dashboard-stats"
      >
        <div className="rounded-full bg-primary/10 p-2.5">
          <Monitor className="h-5 w-5 text-primary" />
        </div>
        <div className="flex-1">
          <p className="text-sm font-medium text-foreground">{t('dashboard.emptyDevices.title')}</p>
          <p className="text-xs text-muted-foreground">{t('dashboard.emptyDevices.description')}</p>
        </div>
        <a
          href="/devices#add-device"
          className="inline-flex items-center gap-1.5 rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground transition-colors hover:bg-primary/90"
        >
          {t('dashboard.emptyDevices.add')}
          <ArrowRight className="h-3.5 w-3.5" />
        </a>
      </div>
    );
  }

  const stats = devices.data;
  const severity = alerts.data?.bySeverity;
  // "unknown" must never render as 0 — a summary outage would otherwise
  // paint an all-clear on the two most safety-critical numbers on the page.
  const criticalCount = severity ? severity.critical + severity.high : null;
  const warningCount = severity ? severity.medium : null;
  const onlinePct = stats.total > 0 ? Math.round((stats.online / stats.total) * 100) : 0;

  const tiles: Tile[] = [
    {
      key: 'total-devices',
      testId: 'dashboard-total-devices-card',
      label: t('dashboard.stats.totalDevices'),
      value: formatNumber(stats.total),
      icon: Monitor,
      iconTone: 'text-muted-foreground',
      href: '/devices',
    },
    {
      key: 'online',
      testId: 'dashboard-online-card',
      label: t('states.online'),
      value: formatNumber(stats.online),
      sub: `${onlinePct}%`,
      // A green "12%" on a mostly-offline fleet reads as praise — only tint
      // the percentage when availability is actually healthy.
      subTone: onlinePct >= 80 ? 'success' : 'muted',
      icon: CheckCircle,
      iconTone: stats.online > 0 ? 'text-success' : 'text-muted-foreground',
      href: '/devices?status=online',
    },
    {
      key: 'critical',
      testId: 'dashboard-critical-card',
      label: t('dashboard.stats.critical'),
      value: criticalCount === null ? '—' : formatNumber(criticalCount),
      sub: criticalCount === null ? t('dashboard.stats.loadFailed') : undefined,
      subTone: 'muted',
      icon: XCircle,
      iconTone: criticalCount !== null && criticalCount > 0 ? 'text-destructive' : 'text-muted-foreground',
      href: '/alerts',
    },
    {
      key: 'warnings',
      testId: 'dashboard-warnings-card',
      label: t('dashboard.stats.warnings'),
      value: warningCount === null ? '—' : formatNumber(warningCount),
      sub: warningCount === null ? t('dashboard.stats.loadFailed') : undefined,
      subTone: 'muted',
      icon: AlertTriangle,
      iconTone: warningCount !== null && warningCount > 0 ? 'text-warning-strong' : 'text-muted-foreground',
      href: '/alerts',
    },
  ];

  // Optional tiles: hidden while unavailable (403/404) or still loading, but
  // a load *failure* renders a degraded "—" tile — a 500 must not be
  // indistinguishable from a permission gate.
  if (tickets.data) {
    tiles.push({
      key: 'tickets',
      testId: 'dashboard-tickets-card',
      label: t('dashboard.stats.openTickets'),
      value: formatNumber(tickets.data.open),
      sub:
        tickets.data.unassigned > 0
          ? t('dashboard.stats.unassignedCount', { count: tickets.data.unassigned })
          : undefined,
      subTone: 'muted',
      icon: Ticket,
      iconTone: 'text-muted-foreground',
      href: '/tickets',
    });
  } else if (tickets.error && !tickets.unavailable) {
    tiles.push({
      key: 'tickets',
      testId: 'dashboard-tickets-card',
      label: t('dashboard.stats.openTickets'),
      value: '—',
      sub: t('dashboard.stats.loadFailed'),
      subTone: 'muted',
      icon: Ticket,
      iconTone: 'text-muted-foreground',
      href: '/tickets',
    });
  }

  if (patch.data) {
    const pct = Math.round(patch.data.compliancePercent);
    tiles.push({
      key: 'patch',
      testId: 'dashboard-patch-card',
      label: t('dashboard.stats.patchCompliance'),
      value: `${formatNumber(pct)}%`,
      icon: ShieldCheck,
      iconTone: pct >= 90 ? 'text-success' : pct >= 70 ? 'text-warning-strong' : 'text-destructive',
      href: '/patches',
    });
  } else if (patch.error && !patch.unavailable) {
    tiles.push({
      key: 'patch',
      testId: 'dashboard-patch-card',
      label: t('dashboard.stats.patchCompliance'),
      value: '—',
      sub: t('dashboard.stats.loadFailed'),
      subTone: 'muted',
      icon: ShieldCheck,
      iconTone: 'text-muted-foreground',
      href: '/patches',
    });
  }

  return (
    <div
      className={cn('grid grid-cols-2 gap-3 sm:grid-cols-3', GRID_BY_COUNT[tiles.length] ?? 'xl:grid-cols-6')}
      data-testid="dashboard-stats"
    >
      {tiles.map((tile) => (
        <a
          key={tile.key}
          href={tile.href}
          data-testid={tile.testId}
          className="group rounded-lg border bg-card px-4 py-3 transition-colors hover:border-primary/40 hover:bg-muted/30"
        >
          <div className="flex items-center justify-between gap-2">
            <span className="truncate text-xs font-medium text-muted-foreground">{tile.label}</span>
            <tile.icon className={cn('h-4 w-4 shrink-0', tile.iconTone)} aria-hidden="true" />
          </div>
          <div className="mt-1 flex items-baseline gap-1.5">
            <span className="text-2xl font-semibold tracking-tight">{tile.value}</span>
            {tile.sub && (
              <span
                className={cn(
                  'truncate text-xs font-medium',
                  tile.subTone === 'success' && 'text-success',
                  tile.subTone === 'warning' && 'text-warning-strong',
                  tile.subTone === 'destructive' && 'text-destructive',
                  (!tile.subTone || tile.subTone === 'muted') && 'text-muted-foreground'
                )}
              >
                {tile.sub}
              </span>
            )}
          </div>
        </a>
      ))}
    </div>
  );
}
