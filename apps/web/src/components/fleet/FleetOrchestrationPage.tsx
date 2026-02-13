import { useEffect, useState } from 'react';
import {
  Shield, Rocket, Package, FolderTree, Clock, Zap, Bell,
  FileText, Loader2, XCircle, RefreshCw, MessageSquare,
  ChevronRight, AlertTriangle, CheckCircle2, TrendingUp
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { fetchWithAuth } from '../../stores/auth';
import { useAiStore } from '@/stores/aiStore';

// ─── Types ──────────────────────────────────────────────────────────────

interface PolicySummary {
  total: number;
  enforcing: number;
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
  approvedPatches: number;
  installedPatches: number;
  criticalPending: number;
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
  maintenanceActive: number;
  groupCount: number;
  reportCount: number;
}

// ─── Quick Actions ──────────────────────────────────────────────────────

const quickActions = [
  { label: 'Check compliance', prompt: 'Show me a compliance summary for all policies', icon: Shield },
  { label: 'Active deployments', prompt: 'List all active deployments and their progress', icon: Rocket },
  { label: 'Critical patches', prompt: 'What critical patches are pending approval?', icon: Package },
  { label: 'Alert overview', prompt: 'Give me a summary of active alerts by severity', icon: Bell },
  { label: 'Maintenance windows', prompt: 'What maintenance windows are active right now?', icon: Clock },
  { label: 'Run automations', prompt: 'List all enabled automations and their recent run history', icon: Zap },
  { label: 'Device groups', prompt: 'Show me all device groups and their member counts', icon: FolderTree },
  { label: 'Generate report', prompt: 'Generate an executive summary report for the fleet', icon: FileText },
];

// ─── Data Fetching ──────────────────────────────────────────────────────

async function fetchFleetStats(): Promise<{ stats: FleetStats; failedEndpoints: string[] }> {
  const endpoints = [
    { name: 'policies', path: '/policies' },
    { name: 'deployments', path: '/deployments' },
    { name: 'patches', path: '/patches/compliance' },
    { name: 'alerts', path: '/alerts/summary' },
    { name: 'automations', path: '/automations' },
    { name: 'maintenance', path: '/maintenance' },
    { name: 'groups', path: '/groups' },
    { name: 'reports', path: '/reports' },
  ] as const;

  const failedEndpoints: string[] = [];
  const results = await Promise.all(
    endpoints.map(async (ep) => {
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
    deploymentsRes,
    patchesRes,
    alertsRes,
    automationsRes,
    maintenanceRes,
    groupsRes,
    reportsRes,
  ] = results;

  const policies = await safeJson(policiesRes);
  const deployments = await safeJson(deploymentsRes);
  const patches = await safeJson(patchesRes);
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

  const enforcingPolicies = Array.isArray(policyList)
    ? policyList.filter((p: Record<string, unknown>) => p.enforcement === 'enforce' || p.enforcementMode === 'enforce').length
    : 0;

  const complianceSummary: Record<string, unknown> = (patches?.summary ?? patches ?? {}) as Record<string, unknown>;

  return { failedEndpoints, stats: {
    policies: {
      total: Array.isArray(policyList) ? policyList.length : 0,
      enforcing: enforcingPolicies,
      compliantPercent: typeof complianceSummary.compliantPercent === 'number'
        ? complianceSummary.compliantPercent
        : 0,
      nonCompliantDevices: typeof complianceSummary.nonCompliantDevices === 'number'
        ? complianceSummary.nonCompliantDevices
        : 0,
    },
    deployments: {
      total: Array.isArray(deploymentList) ? deploymentList.length : 0,
      active: countByStatus(deploymentList, ['running', 'in_progress', 'active']),
      pending: countByStatus(deploymentList, ['pending', 'scheduled']),
      completed: countByStatus(deploymentList, ['completed', 'success']),
      failed: countByStatus(deploymentList, ['failed', 'error']),
    },
    patches: {
      pendingPatches: toNum(complianceSummary.pendingPatches ?? complianceSummary.pending),
      approvedPatches: toNum(complianceSummary.approvedPatches ?? complianceSummary.approved),
      installedPatches: toNum(complianceSummary.installedPatches ?? complianceSummary.installed),
      criticalPending: toNum(complianceSummary.criticalPending ?? complianceSummary.critical),
    },
    alerts: {
      critical: toNum(alerts?.critical),
      high: toNum(alerts?.high),
      medium: toNum(alerts?.medium),
      low: toNum(alerts?.low),
      total: toNum(alerts?.total),
    },
    automationCount: Array.isArray(automationList) ? automationList.length : 0,
    maintenanceActive: Array.isArray(maintenanceList)
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
          enforcingPolicies: data.policies.enforcing,
          activeDeployments: data.deployments.active,
          pendingPatches: data.patches.pendingPatches,
          criticalPatches: data.patches.criticalPending,
          activeAlerts: data.alerts.total,
          criticalAlerts: data.alerts.critical,
          automationCount: data.automationCount,
          maintenanceActive: data.maintenanceActive,
          groupCount: data.groupCount,
          hint: 'User is on the Fleet Orchestration page. You have fleet-level tools: manage_policies, manage_deployments, manage_patches, manage_groups, manage_maintenance_windows, manage_automations, manage_alert_rules, generate_report. Use these to help with fleet operations.',
        },
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load fleet stats');
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
          <h1 className="text-2xl font-bold">Fleet Orchestration</h1>
        </div>
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {[...Array(8)].map((_, i) => (
            <div key={i} className="rounded-lg border bg-card p-6 shadow-sm">
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
        <h1 className="text-2xl font-bold">Fleet Orchestration</h1>
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
          <h1 className="text-2xl font-bold">Fleet Orchestration</h1>
          <p className="text-sm text-muted-foreground mt-1">
            Manage policies, deployments, patches, and automations across your fleet
          </p>
        </div>
        <button
          onClick={loadStats}
          className="flex items-center gap-2 rounded-md border px-3 py-2 text-sm hover:bg-muted transition-colors"
        >
          <RefreshCw className="h-4 w-4" />
          Refresh
        </button>
      </div>

      {/* Partial failure warning */}
      {warnings.length > 0 && (
        <div className="rounded-lg border border-yellow-500/40 bg-yellow-500/10 p-4">
          <div className="flex items-center gap-2 text-yellow-700 dark:text-yellow-400">
            <AlertTriangle className="h-4 w-4 flex-shrink-0" />
            <span className="text-sm">
              Some data may be incomplete. Failed to load: {warnings.join(', ')}
            </span>
          </div>
        </div>
      )}

      {/* Stat Cards */}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard
          title="Policies"
          icon={Shield}
          value={s.policies.total}
          subtitle={`${s.policies.enforcing} enforcing`}
          accent="blue"
          onClick={() => handleQuickAction('Show me a compliance summary for all policies')}
        />
        <StatCard
          title="Deployments"
          icon={Rocket}
          value={s.deployments.active}
          subtitle={`${s.deployments.total} total, ${s.deployments.pending} pending`}
          accent={s.deployments.failed > 0 ? 'red' : 'green'}
          badge={s.deployments.failed > 0 ? `${s.deployments.failed} failed` : undefined}
          onClick={() => handleQuickAction('List all active deployments and their progress')}
        />
        <StatCard
          title="Patches"
          icon={Package}
          value={s.patches.pendingPatches}
          subtitle={`pending approval`}
          accent={s.patches.criticalPending > 0 ? 'red' : 'yellow'}
          badge={s.patches.criticalPending > 0 ? `${s.patches.criticalPending} critical` : undefined}
          onClick={() => handleQuickAction('What critical patches are pending approval?')}
        />
        <StatCard
          title="Alerts"
          icon={Bell}
          value={s.alerts.total}
          subtitle={`${s.alerts.critical} critical, ${s.alerts.high} high`}
          accent={s.alerts.critical > 0 ? 'red' : s.alerts.high > 0 ? 'yellow' : 'green'}
          onClick={() => handleQuickAction('Give me a summary of active alerts by severity')}
        />
        <StatCard
          title="Groups"
          icon={FolderTree}
          value={s.groupCount}
          subtitle="device groups"
          accent="blue"
          onClick={() => handleQuickAction('Show me all device groups and their member counts')}
        />
        <StatCard
          title="Automations"
          icon={Zap}
          value={s.automationCount}
          subtitle="configured"
          accent="purple"
          onClick={() => handleQuickAction('List all enabled automations and their recent run history')}
        />
        <StatCard
          title="Maintenance"
          icon={Clock}
          value={s.maintenanceActive}
          subtitle="active windows"
          accent={s.maintenanceActive > 0 ? 'yellow' : 'green'}
          onClick={() => handleQuickAction('What maintenance windows are active right now?')}
        />
        <StatCard
          title="Reports"
          icon={FileText}
          value={s.reportCount}
          subtitle="report definitions"
          accent="blue"
          onClick={() => handleQuickAction('Generate an executive summary report for the fleet')}
        />
      </div>

      {/* Quick Actions */}
      <div className="rounded-lg border bg-card p-6 shadow-sm">
        <div className="flex items-center gap-2 mb-4">
          <MessageSquare className="h-5 w-5 text-primary" />
          <h2 className="text-lg font-semibold">AI Fleet Actions</h2>
          <span className="text-xs text-muted-foreground ml-2">Click to ask the AI assistant</span>
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
              {action.label}
              <ChevronRight className="h-3 w-3 opacity-50" />
            </button>
          ))}
        </div>
      </div>

      {/* Status Overview Panels */}
      <div className="grid gap-4 lg:grid-cols-2">
        {/* Deployment Status */}
        <div className="rounded-lg border bg-card p-6 shadow-sm">
          <h3 className="text-sm font-semibold mb-4 flex items-center gap-2">
            <Rocket className="h-4 w-4" />
            Deployment Status
          </h3>
          <div className="space-y-3">
            <StatusBar label="Active" value={s.deployments.active} total={s.deployments.total} color="bg-blue-500" />
            <StatusBar label="Pending" value={s.deployments.pending} total={s.deployments.total} color="bg-yellow-500" />
            <StatusBar label="Completed" value={s.deployments.completed} total={s.deployments.total} color="bg-green-500" />
            <StatusBar label="Failed" value={s.deployments.failed} total={s.deployments.total} color="bg-red-500" />
          </div>
        </div>

        {/* Alert Breakdown */}
        <div className="rounded-lg border bg-card p-6 shadow-sm">
          <h3 className="text-sm font-semibold mb-4 flex items-center gap-2">
            <Bell className="h-4 w-4" />
            Alert Breakdown
          </h3>
          <div className="space-y-3">
            <StatusBar label="Critical" value={s.alerts.critical} total={s.alerts.total} color="bg-red-500" />
            <StatusBar label="High" value={s.alerts.high} total={s.alerts.total} color="bg-orange-500" />
            <StatusBar label="Medium" value={s.alerts.medium} total={s.alerts.total} color="bg-yellow-500" />
            <StatusBar label="Low" value={s.alerts.low} total={s.alerts.total} color="bg-blue-500" />
          </div>
        </div>

        {/* Patch Posture */}
        <div className="rounded-lg border bg-card p-6 shadow-sm">
          <h3 className="text-sm font-semibold mb-4 flex items-center gap-2">
            <Package className="h-4 w-4" />
            Patch Posture
          </h3>
          <div className="grid grid-cols-3 gap-4 text-center">
            <MiniStat
              label="Pending"
              value={s.patches.pendingPatches}
              icon={AlertTriangle}
              color="text-yellow-500"
            />
            <MiniStat
              label="Approved"
              value={s.patches.approvedPatches}
              icon={CheckCircle2}
              color="text-blue-500"
            />
            <MiniStat
              label="Installed"
              value={s.patches.installedPatches}
              icon={TrendingUp}
              color="text-green-500"
            />
          </div>
        </div>

        {/* Policy Compliance */}
        <div className="rounded-lg border bg-card p-6 shadow-sm">
          <h3 className="text-sm font-semibold mb-4 flex items-center gap-2">
            <Shield className="h-4 w-4" />
            Policy Compliance
          </h3>
          <div className="grid grid-cols-3 gap-4 text-center">
            <MiniStat
              label="Policies"
              value={s.policies.total}
              icon={Shield}
              color="text-blue-500"
            />
            <MiniStat
              label="Enforcing"
              value={s.policies.enforcing}
              icon={CheckCircle2}
              color="text-green-500"
            />
            <MiniStat
              label="Non-Compliant"
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
} as const;

function StatCard({
  title, icon: Icon, value, subtitle, accent, badge, onClick,
}: {
  title: string;
  icon: React.ComponentType<{ className?: string }>;
  value: number;
  subtitle: string;
  accent: keyof typeof accentColors;
  badge?: string;
  onClick?: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className="rounded-lg border bg-card p-6 shadow-sm text-left hover:bg-muted/50 transition-colors cursor-pointer w-full"
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
        <div className="text-2xl font-bold">{value.toLocaleString()}</div>
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
          className={cn('h-full rounded-full transition-all', color)}
          style={{ width: `${pct}%` }}
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
      <span className="text-xl font-bold">{value.toLocaleString()}</span>
      <span className="text-xs text-muted-foreground">{label}</span>
    </div>
  );
}
