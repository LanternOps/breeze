import { useEffect, useState } from 'react';
import { RefreshCw } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useAuthStore } from '../../stores/auth';
import { useOrgStore } from '../../stores/orgStore';
import { useAiStore } from '@/stores/aiStore';
import { DEFAULT_DASHBOARD_EXCLUDE_ACTIONS } from '@/lib/auditFormat';
import { useTranslation } from 'react-i18next';
// Initializes the shared i18next singleton. Islands hydrate independently, so
// an island that hydrates before whichever other island happens to pull i18n in
// would otherwise render raw keys (and mismatch the SSR markup).
import '../../lib/i18n';
import { useDashboardQuery } from '../../hooks/useDashboardQuery';
import KpiStrip from './KpiStrip';
import AlertsFeed from './AlertsFeed';
import FleetStatusCard from './FleetStatusCard';
import SecurityPostureCard from './SecurityPostureCard';
import PatchComplianceCard from './PatchComplianceCard';
import VulnerabilitiesCard from './VulnerabilitiesCard';
import RecentActivity from './RecentActivity';
import type {
  AlertRow,
  AlertsSummary,
  AuditLogEntry,
  DeviceStats,
  OfflineDevice,
  PatchCompliance,
  SecurityOverview,
  TicketStats,
  VulnerabilityStats,
} from './types';

function getGreetingKey(): string {
  const hour = new Date().getHours();
  if (hour < 12) return 'dashboard.greeting.morning';
  if (hour < 17) return 'dashboard.greeting.afternoon';
  return 'dashboard.greeting.evening';
}

const AUDIT_PATH = `/audit-logs/logs?limit=5&skipCount=true&excludeActions=${encodeURIComponent(
  DEFAULT_DASHBOARD_EXCLUDE_ACTIONS.join(',')
)}`;

/**
 * The dashboard island. Owns one refresh cycle for every widget: `tick`
 * bumps every 60s (and by 5 on manual refresh), the heavier posture
 * endpoints only re-poll every 5th tick, and every query re-fetches when
 * the global org scope changes.
 */
export default function DashboardPage() {
  const { t } = useTranslation('common');
  const { user } = useAuthStore();
  const currentOrgId = useOrgStore((s) => s.currentOrgId);
  const [greeting, setGreeting] = useState(t('dashboard.greeting.welcome'));
  const [tick, setTick] = useState(0);
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);
  const [updatedText, setUpdatedText] = useState('');

  // Heavy endpoints (security/patch/vuln aggregations) poll at 1/5th the
  // rate of the cheap counters. A manual refresh bumps tick by 5 so it
  // always crosses a boundary and refreshes these too.
  const heavyTick = Math.floor(tick / 5);

  const devices = useDashboardQuery<DeviceStats>('/devices/stats', tick, (j: any) => j.data);
  const alertsSummary = useDashboardQuery<AlertsSummary>('/alerts/summary', tick, (j: any) => j);
  // No sort param: the alerts list always orders by triggeredAt desc.
  const alerts = useDashboardQuery<AlertRow[]>(
    '/alerts?status=active,acknowledged&limit=6',
    tick,
    (j: any) => j.data ?? []
  );
  const offline = useDashboardQuery<OfflineDevice[]>(
    '/devices?status=offline&limit=25',
    tick,
    (j: any) => j.data ?? []
  );
  const tickets = useDashboardQuery<TicketStats>('/tickets/stats', tick, (j: any) => j.data);
  const activity = useDashboardQuery<AuditLogEntry[]>(
    AUDIT_PATH,
    tick,
    (j: any) => j.logs ?? j.auditLogs ?? j.data ?? []
  );
  const patch = useDashboardQuery<PatchCompliance>('/patches/compliance', heavyTick, (j: any) => j.data);
  const security = useDashboardQuery<SecurityOverview>('/security/dashboard', heavyTick, (j: any) => j.data);
  const vulns = useDashboardQuery<VulnerabilityStats>('/vulnerabilities/stats', heavyTick, (j: any) => j);

  useEffect(() => {
    setGreeting(t(/* i18n-dynamic */ getGreetingKey()));
  }, [t]);

  // Auto-refresh every 60 seconds.
  useEffect(() => {
    const interval = setInterval(() => setTick((c) => c + 1), 60_000);
    return () => clearInterval(interval);
  }, []);

  // A fresh devices payload marks the whole page as freshly updated.
  useEffect(() => {
    if (devices.data) setLastUpdated(new Date());
  }, [devices.data]);

  // Update the "updated Xs ago" text every 10 seconds.
  useEffect(() => {
    if (!lastUpdated) return;
    const tickText = () => {
      const diffMs = Date.now() - lastUpdated.getTime();
      const diffSecs = Math.floor(diffMs / 1000);
      const diffMins = Math.floor(diffMs / 60000);
      if (diffSecs < 10) setUpdatedText(t('dashboard.updated.justNow'));
      else if (diffMins < 1) setUpdatedText(t('dashboard.updated.secondsAgo', { count: diffSecs }));
      else if (diffMins < 60) setUpdatedText(t('dashboard.updated.minutesAgo', { count: diffMins }));
      else setUpdatedText(t('dashboard.updated.hoursAgo', { count: Math.floor(diffMs / 3600000) }));
    };
    tickText();
    const interval = setInterval(tickText, 10_000);
    return () => clearInterval(interval);
  }, [lastUpdated, t]);

  // Keep the AI sidebar's page context current.
  useEffect(() => {
    if (!devices.data || !alertsSummary.data) return;
    useAiStore.getState().setPageContext({
      type: 'dashboard',
      deviceCount: devices.data.total,
      alertCount: alertsSummary.data.byStatus.active,
    });
  }, [devices.data, alertsSummary.data]);

  const refresh = () => setTick((c) => c + 5);
  const firstName = user?.name?.split(' ')[0];
  const allQueries = [devices, alertsSummary, alerts, offline, tickets, activity, patch, security, vulns];
  const isRefreshing = allQueries.some((q) => q.isFetching);
  // Widgets keep stale data on a failed poll — that's deliberate — but the
  // failure itself must be visible somewhere, or a wall-mounted dashboard
  // ages silently during an outage.
  const refreshFailed = allQueries.some((q) => q.error != null && q.data != null);
  const showPosture = !(security.unavailable && patch.unavailable && vulns.unavailable);

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 data-testid="dashboard-heading" className="text-xl font-semibold tracking-tight">
          {greeting}
          {firstName ? `, ${firstName}` : ''}
        </h1>
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          {refreshFailed && (
            <span className="rounded-full bg-warning/15 px-2 py-0.5 font-medium text-warning-strong" role="status">
              {t('dashboard.refreshFailed')}
            </span>
          )}
          {updatedText && <span aria-live="polite">{updatedText}</span>}
          <button
            onClick={refresh}
            className="rounded-md p-1 transition-colors hover:bg-muted"
            title={t('dashboard.refresh')}
            aria-label={t('dashboard.refresh')}
          >
            <RefreshCw className={cn('h-3.5 w-3.5', isRefreshing && 'animate-spin')} />
          </button>
        </div>
      </div>

      <KpiStrip devices={devices} alerts={alertsSummary} tickets={tickets} patch={patch} onRetry={refresh} />

      <div className="grid items-start gap-6 lg:grid-cols-3">
        <div className="lg:col-span-2">
          <AlertsFeed alerts={alerts} summary={alertsSummary} showOrg={currentOrgId === null} onRetry={refresh} />
        </div>
        <FleetStatusCard devices={devices} offline={offline} />
      </div>

      {showPosture && (
        <div className="grid items-start gap-6 md:grid-cols-2 xl:grid-cols-3">
          <SecurityPostureCard security={security} />
          <PatchComplianceCard patch={patch} />
          <VulnerabilitiesCard vulns={vulns} />
        </div>
      )}

      <RecentActivity activity={activity} onRetry={refresh} />
    </div>
  );
}
