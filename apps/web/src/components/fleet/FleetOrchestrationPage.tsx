import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Shield, Rocket, Package, FolderTree, Clock, Zap, Bell,
  FileText, Loader2, XCircle, RefreshCw, MessageSquare,
  ChevronRight, AlertTriangle, CheckCircle2
} from 'lucide-react';
import { cn, widthPercentClass } from '@/lib/utils';
import { formatNumber } from '@/lib/i18n/format';
import { fetchWithAuth } from '../../stores/auth';
import { getOrgScope } from '@/hooks/useOrgScope';
import { useAiStore } from '@/stores/aiStore';

// ─── Types ──────────────────────────────────────────────────────────────

interface PolicySummary {
  total: number;
  active: number;
  compliantPercent: number;
  nonCompliantDevices: number;
}

interface DeploymentSummary {
  total: number;
  active: number;
  pending: number;
  completed: number;
  failed: number;
}

interface PatchSummary {
  pendingPatches: number;
  installedPatches: number;
  failedPatches: number;
  missingPatches: number;
}

interface AlertSummary {
  critical: number;
  high: number;
  medium: number;
  low: number;
  total: number;
}

interface FleetStats {
  policies: PolicySummary;
  deployments: DeploymentSummary;
  patches: PatchSummary;
  alerts: AlertSummary;
  automationCount: number;
  // null when the per-org maintenance endpoint is skipped in fleet view — the
  // count isn't zero, it's unknown, so the card reads "—" rather than a
  // fabricated healthy "0 active windows".
  maintenanceActive: number | null;
  groupCount: number;
  reportCount: number;
}

// ─── Quick Actions ──────────────────────────────────────────────────────

const quickActions = [
  { label: 'Check compliance', labelKey: 'longTail.fleet.FleetOrchestrationPage.quickActions.checkCompliance', prompt: 'Show me a compliance summary for all configuration policies', icon: Shield },
  { label: 'Active deployments', labelKey: 'longTail.fleet.FleetOrchestrationPage.quickActions.activeDeployments', prompt: 'List all active deployments and their progress', icon: Rocket },
  { label: 'Critical patches', labelKey: 'longTail.fleet.FleetOrchestrationPage.quickActions.criticalPatches', prompt: 'What critical patches are pending approval?', icon: Package },
  { label: 'Alert overview', labelKey: 'longTail.fleet.FleetOrchestrationPage.quickActions.alertOverview', prompt: 'Give me a summary of active alerts by severity', icon: Bell },
  { label: 'Maintenance windows', labelKey: 'longTail.fleet.FleetOrchestrationPage.quickActions.maintenanceWindows', prompt: 'What maintenance windows are active right now?', icon: Clock },
  { label: 'Run automations', labelKey: 'longTail.fleet.FleetOrchestrationPage.quickActions.runAutomations', prompt: 'List all enabled automations and their recent run history', icon: Zap },
  { label: 'Device groups', labelKey: 'longTail.fleet.FleetOrchestrationPage.quickActions.deviceGroups', prompt: 'Show me all device groups and their member counts', icon: FolderTree },
  { label: 'Generate report', labelKey: 'longTail.fleet.FleetOrchestrationPage.quickActions.generateReport', prompt: 'Generate an executive summary report for the fleet', icon: FileText },
];

// ─── Data Fetching ──────────────────────────────────────────────────────

async function fetchFleetStats(): Promise<{ stats: FleetStats; failedEndpoints: string[] }> {
  const endpoints = [
    { name: 'policies', path: '/configuration-policies' },
    { name: 'policyCompliance', path: '/policies/compliance/stats' },
    { name: 'deployments', path: '/deployments' },
    { name: 'patchCompliance', path: '/patches/compliance' },
    { name: 'alerts', path: '/alerts/summary' },
    { name: 'automations', path: '/automations' },
    { name: 'maintenance', path: '/maintenance/windows' },
    { name: 'groups', path: '/groups' },
    { name: 'reports', path: '/reports' },
  ] as const;

  // Maintenance windows are per-org (the endpoint 400s with no org); in fleet
  // view we skip that one call. Capture the scope once so the stat below can be
  // reported as null (unknown), not a fabricated 0.
  const fleetView = getOrgScope().scope === 'all';
  const failedEndpoints: string[] = [];
  const results = await Promise.all(
    endpoints.map(async (ep) => {
      if (ep.name === 'maintenance' && fleetView) return null;
      try {
        const res = await fetchWithAuth(ep.path);
        if (!res.ok) {
          failedEndpoints.push(ep.name);
          return null;
        }
        return res;
      } catch {
        failedEndpoints.push(ep.name);
        return null;
      }
    }),
  );

  const [
    policiesRes,
    policyComplianceRes,
    deploymentsRes,
    patchComplianceRes,
    alertsRes,
    automationsRes,
    maintenanceRes,
    groupsRes,
    reportsRes,
  ] = results;

  const policies = await safeJson(policiesRes);
  const policyCompliance = await safeJson(policyComplianceRes);
  const deployments = await safeJson(deploymentsRes);
  const patchCompliance = await safeJson(patchComplianceRes);
  const alerts = await safeJson(alertsRes);
  const automations = await safeJson(automationsRes);
  const maintenance = await safeJson(maintenanceRes);
  const groups = await safeJson(groupsRes);
  const reports = await safeJson(reportsRes);

  const policyList = policies?.data ?? policies?.policies ?? [];
  const deploymentList = deployments?.data ?? deployments?.deployments ?? [];
  const automationList = automations?.data ?? automations?.automations ?? [];
  const maintenanceList = maintenance?.data ?? maintenance?.windows ?? [];
  const groupList = groups?.data ?? groups?.groups ?? [];
  const reportList = reports?.data ?? reports?.reports ?? [];

  const activePolicies = Array.isArray(policyList)
    ? policyList.filter((p: Record<string, unknown>) => p.status === 'active').length
    : 0;

  // Policy compliance from /policies/compliance/stats (config policy system)
  const policyCompData = (policyCompliance?.data ?? policyCompliance ?? {}) as Record<string, unknown>;
  const complianceOverview = (policyCompData.complianceOverview ?? {}) as Record<string, unknown>;

  // Patch compliance from /patches/compliance (operational patch data)
  const patchCompData = (patchCompliance?.data ?? patchCompliance ?? {}) as Record<string, unknown>;
  const patchSummary = (patchCompData.summary ?? {}) as Record<string, unknown>;

  // Alert severity from /alerts/summary
  const alertBySeverity = (alerts?.bySeverity ?? {}) as Record<string, unknown>;

  return { failedEndpoints, stats: {
    policies: {
      total: Array.isArray(policyList) ? policyList.length : 0,
      active: activePolicies,
      compliantPercent: toNum(policyCompData.complianceRate),
      nonCompliantDevices: toNum(complianceOverview.non_compliant),
    },
    deployments: {
      total: Array.isArray(deploymentList) ? deploymentList.length : 0,
      active: countByStatus(deploymentList, ['running', 'in_progress', 'active']),
      pending: countByStatus(deploymentList, ['pending', 'scheduled']),
      completed: countByStatus(deploymentList, ['completed', 'success']),
      failed: countByStatus(deploymentList, ['failed', 'error']),
    },
    patches: {
      pendingPatches: toNum(patchSummary.pending),
      installedPatches: toNum(patchSummary.installed),
      failedPatches: toNum(patchSummary.failed),
      missingPatches: toNum(patchSummary.missing),
    },
    alerts: {
      critical: toNum(alertBySeverity.critical),
      high: toNum(alertBySeverity.high),
      medium: toNum(alertBySeverity.medium),
      low: toNum(alertBySeverity.low),
      total: toNum(alerts?.total),
    },
    automationCount: Array.isArray(automationList) ? automationList.length : 0,
    // Unknown (null) in fleet view where the call was skipped; a real count
    // otherwise. Never a fabricated 0 that reads as "no active windows".
    maintenanceActive: fleetView
      ? null
      : Array.isArray(maintenanceList)
        ? maintenanceList.filter((w: Record<string, unknown>) => w.status === 'active' || w.isActive).length
        : 0,
    groupCount: Array.isArray(groupList) ? groupList.length : 0,
    reportCount: Array.isArray(reportList) ? reportList.length : 0,
  } };
}

async function safeJson(res: Response | null): Promise<Record<string, unknown> | null> {
  if (!res) return null;
  try {
    return await res.json();
  } catch {
    return null;
  }
}

function toNum(v: unknown): number {
  return typeof v === 'number' ? v : 0;
}

function countByStatus(list: unknown, statuses: string[]): number {
  if (!Array.isArray(list)) return 0;
  return list.filter((item: Record<string, unknown>) =>
    statuses.includes(String(item.status ?? '').toLowerCase())
  ).length;
}

// ─── Component ──────────────────────────────────────────────────────────

export default function FleetOrchestrationPage() {
  const { t } = useTranslation('common');
  const [stats, setStats] = useState<FleetStats | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [warnings, setWarnings] = useState<string[]>([]);

  const loadStats = async () => {
    try {
      setIsLoading(true);
      setError(null);
      setWarnings([]);
      const { stats: data, failedEndpoints } = await fetchFleetStats();
      setStats(data);
      if (failedEndpoints.length > 0) {
        setWarnings(failedEndpoints);
      }

      useAiStore.getState().setPageContext({
        type: 'custom',
        label: 'Fleet Orchestration',
        data: {
          page: 'fleet',
          policyCount: data.policies.total,
          activePolicies: data.policies.active,
          activeDeployments: data.deployments.active,
          pendingPatches: data.patches.pendingPatches,
          failedPatches: data.patches.failedPatches,
          activeAlerts: data.alerts.total,
          criticalAlerts: data.alerts.critical,
          automationCount: data.automationCount,
          // Omit entirely in fleet view (null) so the assistant doesn't assert a
          // fabricated "0 active maintenance windows" across the fleet.
          ...(data.maintenanceActive != null ? { maintenanceActive: data.maintenanceActive } : {}),
          groupCount: data.groupCount,
          hint: 'User is on the Fleet Orchestration page. You have fleet-level tools: manage_configuration_policy, get_configuration_policy, configuration_policy_compliance, list_configuration_policies, apply_configuration_policy, remove_configuration_policy_assignment, preview_configuration_change, get_effective_configuration, manage_deployments, manage_patches, manage_groups, manage_maintenance_windows, manage_automations, manage_alert_rules, generate_report. Use these to help with fleet operations.',
        },
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : t('longTail.fleet.FleetOrchestrationPage.errors.loadFailed'));
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    loadStats();
  }, []);

  const handleQuickAction = (prompt: string) => {
    const store = useAiStore.getState();
    store.open();
    store.sendMessage(prompt);
  };

  if (isLoading) {
    return (
      <div className="space-y-6 p-6">
        <div className="flex items-center justify-between">
          <h1 className="text-xl font-semibold tracking-tight">{t('longTail.fleet.FleetOrchestrationPage.title')}</h1>
        </div>
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {[...Array(8)].map((_, i) => (
            <div key={i} className="rounded-lg border bg-card p-6 shadow-xs">
              <div className="flex items-center justify-center h-20">
                <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
              </div>
            </div>
          ))}
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="space-y-6 p-6">
        <h1 className="text-xl font-semibold tracking-tight">{t('longTail.fleet.FleetOrchestrationPage.title')}</h1>
        <div className="rounded-lg border border-destructive/40 bg-destructive/10 p-6">
          <div className="flex items-center gap-2 text-destructive">
            <XCircle className="h-5 w-5" />
            <span className="text-sm font-medium">{error}</span>
          </div>
        </div>
      </div>
    );
  }

  const s = stats!;

  return (
    <div className="space-y-6 p-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">{t('longTail.fleet.FleetOrchestrationPage.title')}</h1>
          <p className="text-sm text-muted-foreground mt-1">
            {t('longTail.fleet.FleetOrchestrationPage.description')}
          </p>
        </div>
        <button
          onClick={loadStats}
          className="flex items-center gap-2 rounded-md border px-3 py-2 text-sm hover:bg-muted transition-colors"
        >
          <RefreshCw className="h-4 w-4" />
          {t('common:actions.refresh')}
        </button>
      </div>

      {/* Partial failure warning */}
      {warnings.length > 0 && (
        <div className="rounded-lg border border-yellow-500/40 bg-yellow-500/10 p-4">
          <div className="flex items-center gap-2 text-yellow-700 dark:text-yellow-400">
            <AlertTriangle className="h-4 w-4 shrink-0" />
            <span className="text-sm">
              {t('longTail.fleet.FleetOrchestrationPage.partialWarning', { endpoints: warnings.join(', ') })}
            </span>
          </div>
        </div>
      )}

      {/* Stat Cards */}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard
          title={t('longTail.fleet.FleetOrchestrationPage.cards.policies')}
          icon={Shield}
          value={s.policies.total}
          subtitle={t('longTail.fleet.FleetOrchestrationPage.cards.activeCount', { count: s.policies.active })}
          accent="blue"
          onClick={() => handleQuickAction('Show me a compliance summary for all configuration policies')}
        />
        <StatCard
          title={t('longTail.fleet.FleetOrchestrationPage.cards.deployments')}
          icon={Rocket}
          value={s.deployments.active}
          subtitle={t('longTail.fleet.FleetOrchestrationPage.cards.deploymentsSubtitle', {
            total: s.deployments.total,
            pending: s.deployments.pending,
          })}
          accent={s.deployments.failed > 0 ? 'red' : 'green'}
          badge={s.deployments.failed > 0 ? t('longTail.fleet.FleetOrchestrationPage.cards.failedCount', { count: s.deployments.failed }) : undefined}
          onClick={() => handleQuickAction('List all active deployments and their progress')}
        />
        <StatCard
          title={t('longTail.fleet.FleetOrchestrationPage.cards.patches')}
          icon={Package}
          value={s.patches.pendingPatches}
          subtitle={t('longTail.fleet.FleetOrchestrationPage.cards.pendingInstallation')}
          accent={s.patches.failedPatches > 0 ? 'red' : 'yellow'}
          badge={s.patches.failedPatches > 0 ? t('longTail.fleet.FleetOrchestrationPage.cards.failedCount', { count: s.patches.failedPatches }) : undefined}
          onClick={() => handleQuickAction('What critical patches are pending approval?')}
        />
        <StatCard
          title={t('longTail.fleet.FleetOrchestrationPage.cards.alerts')}
          icon={Bell}
          value={s.alerts.total}
          subtitle={t('longTail.fleet.FleetOrchestrationPage.cards.alertsSubtitle', {
            critical: s.alerts.critical,
            high: s.alerts.high,
          })}
          accent={s.alerts.critical > 0 ? 'red' : s.alerts.high > 0 ? 'yellow' : 'green'}
          onClick={() => handleQuickAction('Give me a summary of active alerts by severity')}
        />
        <StatCard
          title={t('longTail.fleet.FleetOrchestrationPage.cards.groups')}
          icon={FolderTree}
          value={s.groupCount}
          subtitle={t('longTail.fleet.FleetOrchestrationPage.cards.deviceGroupsSubtitle')}
          accent="blue"
          onClick={() => handleQuickAction('Show me all device groups and their member counts')}
        />
        <StatCard
          title={t('longTail.fleet.FleetOrchestrationPage.cards.automations')}
          icon={Zap}
          value={s.automationCount}
          subtitle={t('longTail.fleet.FleetOrchestrationPage.cards.configured')}
          accent="purple"
          onClick={() => handleQuickAction('List all enabled automations and their recent run history')}
        />
        <StatCard
          title={t('longTail.fleet.FleetOrchestrationPage.cards.maintenance')}
          icon={Clock}
          value={s.maintenanceActive ?? '—'}
          subtitle={t('longTail.fleet.FleetOrchestrationPage.cards.activeWindows')}
          accent={s.maintenanceActive == null ? 'gray' : s.maintenanceActive > 0 ? 'yellow' : 'green'}
          onClick={() => handleQuickAction('What maintenance windows are active right now?')}
        />
        <StatCard
          title={t('longTail.fleet.FleetOrchestrationPage.cards.reports')}
          icon={FileText}
          value={s.reportCount}
          subtitle={t('longTail.fleet.FleetOrchestrationPage.cards.reportDefinitions')}
          accent="blue"
          onClick={() => handleQuickAction('Generate an executive summary report for the fleet')}
        />
      </div>

      {/* Quick Actions */}
      <div className="rounded-lg border bg-card p-6 shadow-xs">
        <div className="flex items-center gap-2 mb-4">
          <MessageSquare className="h-5 w-5 text-primary" />
          <h2 className="text-lg font-semibold">{t('longTail.fleet.FleetOrchestrationPage.aiFleetActions')}</h2>
          <span className="text-xs text-muted-foreground ml-2">{t('longTail.fleet.FleetOrchestrationPage.aiFleetActionsHint')}</span>
        </div>
        <div className="flex flex-wrap gap-2">
          {quickActions.map((action) => (
            <button
              key={action.label}
              onClick={() => handleQuickAction(action.prompt)}
              className="flex items-center gap-2 rounded-full border px-4 py-2 text-sm font-medium
                         hover:bg-primary hover:text-primary-foreground hover:border-primary
                         transition-colors cursor-pointer"
            >
              <action.icon className="h-4 w-4" />
              {t(/* i18n-dynamic */ action.labelKey)}
              <ChevronRight className="h-3 w-3 opacity-50" />
            </button>
          ))}
        </div>
      </div>

      {/* Status Overview Panels */}
      <div className="grid gap-4 lg:grid-cols-2">
        {/* Deployment Status */}
        <div className="rounded-lg border bg-card p-6 shadow-xs">
          <h3 className="text-sm font-semibold mb-4 flex items-center gap-2">
            <Rocket className="h-4 w-4" />
            {t('longTail.fleet.FleetOrchestrationPage.deploymentStatus')}
          </h3>
          <div className="space-y-3">
            <StatusBar label={t('common:states.active')} value={s.deployments.active} total={s.deployments.total} color="bg-blue-500" />
            <StatusBar label={t('common:states.pending')} value={s.deployments.pending} total={s.deployments.total} color="bg-yellow-500" />
            <StatusBar label={t('longTail.fleet.FleetOrchestrationPage.status.completed')} value={s.deployments.completed} total={s.deployments.total} color="bg-green-500" />
            <StatusBar label={t('longTail.fleet.FleetOrchestrationPage.status.failed')} value={s.deployments.failed} total={s.deployments.total} color="bg-red-500" />
          </div>
        </div>

        {/* Alert Breakdown */}
        <div className="rounded-lg border bg-card p-6 shadow-xs">
          <h3 className="text-sm font-semibold mb-4 flex items-center gap-2">
            <Bell className="h-4 w-4" />
            {t('longTail.fleet.FleetOrchestrationPage.alertBreakdown')}
          </h3>
          <div className="space-y-3">
            <StatusBar label={t('longTail.fleet.FleetOrchestrationPage.severity.critical')} value={s.alerts.critical} total={s.alerts.total} color="bg-red-500" />
            <StatusBar label={t('longTail.fleet.FleetOrchestrationPage.severity.high')} value={s.alerts.high} total={s.alerts.total} color="bg-orange-500" />
            <StatusBar label={t('longTail.fleet.FleetOrchestrationPage.severity.medium')} value={s.alerts.medium} total={s.alerts.total} color="bg-yellow-500" />
            <StatusBar label={t('longTail.fleet.FleetOrchestrationPage.severity.low')} value={s.alerts.low} total={s.alerts.total} color="bg-blue-500" />
          </div>
        </div>

        {/* Patch Posture */}
        <div className="rounded-lg border bg-card p-6 shadow-xs">
          <h3 className="text-sm font-semibold mb-4 flex items-center gap-2">
            <Package className="h-4 w-4" />
            {t('longTail.fleet.FleetOrchestrationPage.patchPosture')}
          </h3>
          <div className="grid grid-cols-3 gap-4 text-center">
            <MiniStat
              label={t('common:states.pending')}
              value={s.patches.pendingPatches}
              icon={AlertTriangle}
              color="text-yellow-500"
            />
            <MiniStat
              label={t('longTail.fleet.FleetOrchestrationPage.installed')}
              value={s.patches.installedPatches}
              icon={CheckCircle2}
              color="text-green-500"
            />
            <MiniStat
              label={t('longTail.fleet.FleetOrchestrationPage.status.failed')}
              value={s.patches.failedPatches}
              icon={XCircle}
              color={s.patches.failedPatches > 0 ? 'text-red-500' : 'text-green-500'}
            />
          </div>
        </div>

        {/* Policy Compliance */}
        <div className="rounded-lg border bg-card p-6 shadow-xs">
          <h3 className="text-sm font-semibold mb-4 flex items-center gap-2">
            <Shield className="h-4 w-4" />
            {t('longTail.fleet.FleetOrchestrationPage.policyCompliance')}
          </h3>
          <div className="grid grid-cols-3 gap-4 text-center">
            <MiniStat
              label={t('longTail.fleet.FleetOrchestrationPage.cards.policies')}
              value={s.policies.total}
              icon={Shield}
              color="text-blue-500"
            />
            <MiniStat
              label={t('common:states.active')}
              value={s.policies.active}
              icon={CheckCircle2}
              color="text-green-500"
            />
            <MiniStat
              label={t('longTail.fleet.FleetOrchestrationPage.nonCompliant')}
              value={s.policies.nonCompliantDevices}
              icon={AlertTriangle}
              color={s.policies.nonCompliantDevices > 0 ? 'text-red-500' : 'text-green-500'}
            />
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── Sub-components ──────────────────────────────────────────────────────

const accentColors = {
  blue: 'text-blue-500',
  green: 'text-green-500',
  yellow: 'text-yellow-500',
  red: 'text-red-500',
  purple: 'text-purple-500',
  gray: 'text-muted-foreground',
} as const;

function StatCard({
  title, icon: Icon, value, subtitle, accent, badge, onClick,
}: {
  title: string;
  icon: React.ComponentType<{ className?: string }>;
  // A string value is rendered verbatim (e.g. "—" for a stat that isn't
  // available in the current scope); a number is locale-formatted.
  value: number | string;
  subtitle: string;
  accent: keyof typeof accentColors;
  badge?: string;
  onClick?: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className="rounded-lg border bg-card p-6 shadow-xs text-left hover:bg-muted/50 transition-colors cursor-pointer w-full"
    >
      <div className="flex items-center justify-between">
        <Icon className={cn('h-5 w-5', accentColors[accent])} />
        {badge && (
          <span className="text-xs font-medium px-2 py-0.5 rounded-full bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400">
            {badge}
          </span>
        )}
      </div>
      <div className="mt-4">
        <div className="text-2xl font-bold">{typeof value === 'number' ? formatNumber(value) : value}</div>
        <div className="text-sm text-muted-foreground">{title}</div>
        <div className="text-xs text-muted-foreground/70 mt-1">{subtitle}</div>
      </div>
    </button>
  );
}

function StatusBar({ label, value, total, color }: {
  label: string;
  value: number;
  total: number;
  color: string;
}) {
  const pct = total > 0 ? Math.round((value / total) * 100) : 0;
  return (
    <div className="flex items-center gap-3">
      <span className="text-sm text-muted-foreground w-20">{label}</span>
      <div className="flex-1 h-2 rounded-full bg-muted overflow-hidden">
        <div
          className={cn('h-full rounded-full transition-all', color, widthPercentClass(pct))}
        />
      </div>
      <span className="text-sm font-medium w-10 text-right">{value}</span>
    </div>
  );
}

function MiniStat({ label, value, icon: Icon, color }: {
  label: string;
  value: number;
  icon: React.ComponentType<{ className?: string }>;
  color: string;
}) {
  return (
    <div className="flex flex-col items-center gap-1">
      <Icon className={cn('h-5 w-5', color)} />
      <span className="text-xl font-bold">{formatNumber(value)}</span>
      <span className="text-xs text-muted-foreground">{label}</span>
    </div>
  );
}
