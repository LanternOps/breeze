import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ClipboardList,
  Eye,
  FilePenLine,
  Loader2,
  PlayCircle,
  Plus,
  RefreshCw,
  ShieldAlert,
  TimerReset,
  X,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { formatDateTime } from '@/lib/dateTimeFormat';
import { useHashState } from '@/lib/useHashState';
import { Dialog } from '../shared/Dialog';
import { fetchWithAuth } from '../../stores/auth';
import DRExecutionView from './DRExecutionView';
import DRPlanEditor from './DRPlanEditor';
import AlphaBadge from '../shared/AlphaBadge';
import { useTranslation } from 'react-i18next';
import { OrgRequiredGate } from '../shared/OrgRequiredGate';
import '../../lib/i18n';

type DRTab = 'plans' | 'executions';

type DRPlan = {
  id: string;
  name: string;
  description: string | null;
  status: string;
  rpoTargetMinutes: number | null;
  rtoTargetMinutes: number | null;
  createdAt: string;
  updatedAt: string;
};

type DRExecution = {
  id: string;
  planId: string;
  executionType: string;
  status: string;
  startedAt: string | null;
  completedAt: string | null;
  initiatedBy: string | null;
  createdAt: string;
};

function formatDate(value: string | null): string {
  return formatDateTime(value, { fallback: '-' });
}

function formatDuration(startedAt: string | null, completedAt: string | null): string {
  if (!startedAt) return '-';
  const start = new Date(startedAt).getTime();
  const end = completedAt ? new Date(completedAt).getTime() : Date.now();
  const totalMinutes = Math.max(0, Math.round((end - start) / 60000));
  if (totalMinutes < 60) return `${totalMinutes}m`;
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return `${hours}h ${minutes}m`;
}

function statusBadge(status: string) {
  const normalized = status.toLowerCase();
  if (normalized === 'active' || normalized === 'completed') {
    return <span className="rounded-full bg-success/10 px-2.5 py-1 text-xs font-medium text-success">{status}</span>;
  }
  if (normalized === 'running' || normalized === 'pending') {
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-primary/10 px-2.5 py-1 text-xs font-medium text-primary">
        {normalized === 'running' && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
        {status}
      </span>
    );
  }
  if (normalized === 'failed' || normalized === 'archived' || normalized === 'aborted') {
    return <span className="rounded-full bg-destructive/10 px-2.5 py-1 text-xs font-medium text-destructive">{status}</span>;
  }
  return <span className="rounded-full bg-muted px-2.5 py-1 text-xs font-medium text-muted-foreground">{status}</span>;
}

function DRDashboardInner() {
  const { t } = useTranslation('backup');
  // SSR-safe hash tab (#2421): starts at the default, adopts the hash post-mount.
  const [activeTab, setActiveTab] = useHashState<DRTab>('plans', (h) => (h === 'executions' ? 'executions' : undefined));
  const [plans, setPlans] = useState<DRPlan[]>([]);
  const [executions, setExecutions] = useState<DRExecution[]>([]);
  const [groupCounts, setGroupCounts] = useState<Record<string, number>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const [planEditorOpen, setPlanEditorOpen] = useState(false);
  const [editingPlanId, setEditingPlanId] = useState<string | null>(null);
  const [executionViewId, setExecutionViewId] = useState<string | null>(null);
  const [executionPlan, setExecutionPlan] = useState<DRPlan | null>(null);
  const [executionType, setExecutionType] = useState<'rehearsal' | 'failover' | 'failback'>('rehearsal');
  const [startingExecution, setStartingExecution] = useState(false);

  const fetchPlans = useCallback(async () => {
    const plansResponse = await fetchWithAuth('/dr/plans');
    if (!plansResponse.ok) throw new Error('Failed to load recovery plans');
    const plansPayload = await plansResponse.json();
    const nextPlans = (plansPayload?.data ?? plansPayload ?? []) as DRPlan[];
    setPlans(Array.isArray(nextPlans) ? nextPlans : []);

    const details = await Promise.allSettled(
      (Array.isArray(nextPlans) ? nextPlans : []).map(async (plan) => {
        const detailResponse = await fetchWithAuth(`/dr/plans/${plan.id}`);
        if (!detailResponse.ok) return [plan.id, 0] as const;
        const detailPayload = await detailResponse.json();
        const groups = detailPayload?.data?.groups ?? detailPayload?.groups ?? [];
        return [plan.id, Array.isArray(groups) ? groups.length : 0] as const;
      })
    );

    setGroupCounts(
      details.reduce<Record<string, number>>((accumulator, result) => {
        if (result.status === 'fulfilled') {
          const [planId, count] = result.value;
          accumulator[planId] = count;
        }
        return accumulator;
      }, {})
    );
  }, []);

  const fetchExecutions = useCallback(async () => {
    const response = await fetchWithAuth('/dr/executions?limit=100');
    if (!response.ok) throw new Error('Failed to load executions');
    const payload = await response.json();
    const nextExecutions = (payload?.data ?? payload ?? []) as DRExecution[];
    setExecutions(Array.isArray(nextExecutions) ? nextExecutions : []);
  }, []);

  const refreshAll = useCallback(async () => {
    try {
      setLoading(true);
      setError(undefined);
      await Promise.all([fetchPlans(), fetchExecutions()]);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load disaster recovery data');
    } finally {
      setLoading(false);
    }
  }, [fetchExecutions, fetchPlans]);

  useEffect(() => {
    void refreshAll();
  }, [refreshAll]);

  const hasRunningExecution = useMemo(
    () => executions.some((execution) => ['pending', 'running'].includes(execution.status)),
    [executions]
  );

  useEffect(() => {
    if (!hasRunningExecution) return;
    const timer = window.setInterval(() => {
      void fetchExecutions();
    }, 5000);
    return () => window.clearInterval(timer);
  }, [fetchExecutions, hasRunningExecution]);

  const planNames = useMemo(
    () =>
      plans.reduce<Record<string, string>>((accumulator, plan) => {
        accumulator[plan.id] = plan.name;
        return accumulator;
      }, {}),
    [plans]
  );

  const tabs: Array<{ id: DRTab; label: string; icon: typeof ClipboardList }> = [
    { id: 'plans', label: 'Plans', icon: ClipboardList },
    { id: 'executions', label: 'Executions', icon: TimerReset },
  ];

  if (loading) {
    return (
      <div className="flex items-center justify-center py-16">
        <div className="text-center">
          <div className="mx-auto h-8 w-8 animate-spin rounded-full border-4 border-primary border-t-transparent" />
          <p className="mt-4 text-sm text-muted-foreground">{t('dRDashboard.loadingDisasterRecovery')}</p>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <AlphaBadge variant="banner" disclaimer="Disaster Recovery orchestration is in early access. DR plans, recovery groups, and rehearsal executions are functional but should be thoroughly tested in a non-production environment before relying on them for actual disaster recovery." />
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-foreground">{t('dRDashboard.disasterRecovery')}</h1>
          <p className="text-sm text-muted-foreground">
            {t('dRDashboard.buildRecoveryPlansLaunchRehearsalsAndTrackLive')} </p>
        </div>
        <div className="flex gap-3">
          <button
            type="button"
            onClick={() => void refreshAll()}
            className="inline-flex items-center gap-2 rounded-md border px-4 py-2 text-sm font-medium hover:bg-muted"
          >
            <RefreshCw className="h-4 w-4" />
            {t('dRDashboard.refresh')} </button>
          <button
            type="button"
            onClick={() => {
              setEditingPlanId(null);
              setPlanEditorOpen(true);
            }}
            className="inline-flex items-center gap-2 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:opacity-90"
          >
            <Plus className="h-4 w-4" />
            {t('dRDashboard.createPlan')} </button>
        </div>
      </div>

      {error && (
        <div className="rounded-lg border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">
          {error}
        </div>
      )}

      <div className="flex gap-1 border-b">
        {tabs.map((tab) => (
          <button
            key={tab.id}
            type="button"
            onClick={() => {
              setActiveTab(tab.id);
              window.location.hash = tab.id === 'plans' ? '' : tab.id;
            }}
            className={cn(
              'inline-flex items-center gap-2 border-b-2 px-4 py-2 text-sm font-medium transition-colors',
              activeTab === tab.id
                ? 'border-primary text-primary'
                : 'border-transparent text-muted-foreground hover:text-foreground'
            )}
          >
            <tab.icon className="h-4 w-4" />
            {tab.label}
          </button>
        ))}
      </div>

      {activeTab === 'plans' && (
        <div className="rounded-lg border">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b bg-muted/50">
                <th className="px-4 py-3 text-left font-medium">{t('dRDashboard.name')}</th>
                <th className="px-4 py-3 text-left font-medium">{t('dRDashboard.status')}</th>
                <th className="px-4 py-3 text-left font-medium">{t('dRDashboard.rpoRto')}</th>
                <th className="px-4 py-3 text-right font-medium">{t('dRDashboard.groups')}</th>
                <th className="px-4 py-3 text-left font-medium">{t('dRDashboard.updated')}</th>
                <th className="px-4 py-3 text-right font-medium">{t('dRDashboard.actions')}</th>
              </tr>
            </thead>
            <tbody>
              {plans.length === 0 ? (
                <tr>
                  <td colSpan={6} className="px-4 py-10 text-center text-muted-foreground">
                    {t('dRDashboard.noRecoveryPlansYetCreateAPlanTo')} </td>
                </tr>
              ) : (
                plans.map((plan) => (
                  <tr key={plan.id} className="border-b last:border-0 hover:bg-muted/30">
                    <td className="px-4 py-3">
                      <div className="font-medium text-foreground">{plan.name}</div>
                      {plan.description && <div className="max-w-[320px] truncate text-xs text-muted-foreground">{plan.description}</div>}
                    </td>
                    <td className="px-4 py-3">{statusBadge(plan.status)}</td>
                    <td className="px-4 py-3 text-muted-foreground">
                      {plan.rpoTargetMinutes ?? '—'}{t('dRDashboard.m')} {plan.rtoTargetMinutes ?? '—'}{t('dRDashboard.m2')} </td>
                    <td className="px-4 py-3 text-right font-medium text-foreground">{groupCounts[plan.id] ?? 0}</td>
                    <td className="px-4 py-3 text-muted-foreground">{formatDate(plan.updatedAt)}</td>
                    <td className="px-4 py-3">
                      <div className="flex justify-end gap-2">
                        <button
                          type="button"
                          onClick={() => {
                            setEditingPlanId(plan.id);
                            setPlanEditorOpen(true);
                          }}
                          className="inline-flex items-center gap-1 rounded-md border px-2.5 py-1.5 text-xs font-medium hover:bg-muted"
                        >
                          <FilePenLine className="h-3.5 w-3.5" />
                          {t('dRDashboard.edit')} </button>
                        <button
                          type="button"
                          onClick={() => {
                            setExecutionPlan(plan);
                            setExecutionType('rehearsal');
                          }}
                          className="inline-flex items-center gap-1 rounded-md bg-primary px-2.5 py-1.5 text-xs font-medium text-primary-foreground hover:opacity-90"
                        >
                          <PlayCircle className="h-3.5 w-3.5" />
                          {t('dRDashboard.execute')} </button>
                      </div>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      )}

      {activeTab === 'executions' && (
        <div className="rounded-lg border">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b bg-muted/50">
                <th className="px-4 py-3 text-left font-medium">{t('dRDashboard.type')}</th>
                <th className="px-4 py-3 text-left font-medium">{t('dRDashboard.status')}</th>
                <th className="px-4 py-3 text-left font-medium">{t('dRDashboard.duration')}</th>
                <th className="px-4 py-3 text-left font-medium">{t('dRDashboard.initiatedBy')}</th>
                <th className="px-4 py-3 text-left font-medium">{t('dRDashboard.started')}</th>
                <th className="px-4 py-3 text-right font-medium">{t('dRDashboard.actions')}</th>
              </tr>
            </thead>
            <tbody>
              {executions.length === 0 ? (
                <tr>
                  <td colSpan={6} className="px-4 py-10 text-center text-muted-foreground">
                    {t('dRDashboard.noDrExecutionsHaveBeenLaunchedYet')} </td>
                </tr>
              ) : (
                executions.map((execution) => (
                  <tr key={execution.id} className="border-b last:border-0 hover:bg-muted/30">
                    <td className="px-4 py-3">
                      <div className="font-medium capitalize text-foreground">{execution.executionType}</div>
                      <div className="text-xs text-muted-foreground">{planNames[execution.planId] ?? execution.planId.slice(0, 8)}</div>
                    </td>
                    <td className="px-4 py-3">{statusBadge(execution.status)}</td>
                    <td className="px-4 py-3 text-muted-foreground">{formatDuration(execution.startedAt, execution.completedAt)}</td>
                    <td className="px-4 py-3 text-muted-foreground">
                      {execution.initiatedBy ? execution.initiatedBy.slice(0, 8) : 'System'}
                    </td>
                    <td className="px-4 py-3 text-muted-foreground">{formatDate(execution.startedAt)}</td>
                    <td className="px-4 py-3">
                      <div className="flex justify-end">
                        <button
                          type="button"
                          onClick={() => setExecutionViewId(execution.id)}
                          className="inline-flex items-center gap-1 rounded-md border px-2.5 py-1.5 text-xs font-medium hover:bg-muted"
                        >
                          <Eye className="h-3.5 w-3.5" />
                          {t('dRDashboard.view')} </button>
                      </div>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      )}

      <DRPlanEditor
        open={planEditorOpen}
        planId={editingPlanId}
        onClose={() => setPlanEditorOpen(false)}
        onSaved={() => {
          setPlanEditorOpen(false);
          setEditingPlanId(null);
          void refreshAll();
        }}
      />

      <DRExecutionView
        open={!!executionViewId}
        executionId={executionViewId}
        onClose={() => setExecutionViewId(null)}
        onUpdated={() => {
          void fetchExecutions();
          void fetchPlans();
        }}
      />

      <Dialog
        open={!!executionPlan}
        onClose={() => {
          if (!startingExecution) setExecutionPlan(null);
        }}
        title={t('dRDashboard.executeRecoveryPlan')}
        maxWidth="md"
        className="p-6"
      >
        <div className="flex items-start justify-between gap-4">
          <div>
            <h3 className="text-base font-semibold text-foreground">{t('dRDashboard.launchExecution')}</h3>
            <p className="mt-1 text-sm text-muted-foreground">
              {t('dRDashboard.startANewDrRunFor')} <span className="font-medium text-foreground">{executionPlan?.name}</span>.
            </p>
          </div>
          <button
            type="button"
            onClick={() => !startingExecution && setExecutionPlan(null)}
            className="rounded-md p-1 hover:bg-muted"
          >
            <X className="h-4 w-4 text-muted-foreground" />
          </button>
        </div>

        <div className="mt-5 grid gap-3">
          {(['rehearsal', 'failover', 'failback'] as const).map((type) => (
            <button
              key={type}
              type="button"
              onClick={() => setExecutionType(type)}
              className={cn(
                'rounded-lg border p-4 text-left transition-colors',
                executionType === type ? 'border-primary bg-primary/5' : 'hover:bg-muted/40'
              )}
            >
              <div className="flex items-center gap-2 text-sm font-medium capitalize text-foreground">
                {type === 'failover' ? <ShieldAlert className="h-4 w-4 text-primary" /> : <PlayCircle className="h-4 w-4 text-primary" />}
                {type}
              </div>
              <p className="mt-1 text-xs text-muted-foreground">
                {type === 'rehearsal'
                  ? 'Run a test execution without treating it as a production failover.'
                  : type === 'failover'
                    ? 'Promote the plan into an active recovery event.'
                    : 'Guide systems back to the primary environment after recovery.'}
              </p>
            </button>
          ))}
        </div>

        <div className="mt-6 flex justify-end gap-3">
          <button
            type="button"
            onClick={() => setExecutionPlan(null)}
            disabled={startingExecution}
            className="rounded-md border px-4 py-2 text-sm font-medium hover:bg-muted disabled:opacity-50"
          >
            {t('dRDashboard.cancel')} </button>
          <button
            type="button"
            onClick={async () => {
              if (!executionPlan) return;
              try {
                setStartingExecution(true);
                setError(undefined);
                const response = await fetchWithAuth(`/dr/plans/${executionPlan.id}/execute`, {
                  method: 'POST',
                  body: JSON.stringify({ executionType }),
                });
                if (!response.ok) {
                  const payload = await response.json().catch(() => null);
                  throw new Error(payload?.error ?? 'Failed to start execution');
                }
                const payload = await response.json();
                const executionId = payload?.data?.id ?? payload?.id ?? null;
                setExecutionPlan(null);
                setActiveTab('executions');
                window.location.hash = 'executions';
                await fetchExecutions();
                if (executionId) setExecutionViewId(executionId);
              } catch (err) {
                setError(err instanceof Error ? err.message : 'Failed to start execution');
              } finally {
                setStartingExecution(false);
              }
            }}
            disabled={startingExecution}
            className="inline-flex items-center gap-2 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:opacity-90 disabled:opacity-50"
          >
            {startingExecution ? <Loader2 className="h-4 w-4 animate-spin" /> : <PlayCircle className="h-4 w-4" />}
            {t('dRDashboard.startExecution')} </button>
        </div>
      </Dialog>
    </div>
  );
}

// The dr APIs are per-organization (they 400 on an org-less request), so the
// gate resolves loading/error/empty/fleet before the data component — with all
// its fetch effects — ever mounts without an org.
export default function DRDashboard() {
  return (
    <OrgRequiredGate>
      <DRDashboardInner />
    </OrgRequiredGate>
  );
}
