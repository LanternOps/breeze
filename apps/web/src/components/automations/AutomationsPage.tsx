import { useState, useEffect, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import { Plus } from 'lucide-react';
import AutomationList, { type Automation } from './AutomationList';
import AutomationRunHistory, {
  type AutomationRun as RunHistoryRun,
  type DeviceRunResult,
  type DeviceScriptResult,
} from './AutomationRunHistory';
import { fetchWithAuth, handleSessionExpired, useAuthStore } from '../../stores/auth';
import { runAction, handleActionError } from '@/lib/runAction';
import { navigateTo } from '@/lib/navigation';
import { usePermissions } from '@/lib/permissions';
import { useHashTab } from '@/lib/useHashState';
import type { TriggerFilter } from './AutomationList';
// Initializes the shared i18next singleton. Islands hydrate independently, so
// an island that hydrates before whichever other island happens to pull i18n in
// would otherwise render raw keys (and mismatch the SSR markup).
import '../../lib/i18n';

type ModalMode = 'closed' | 'delete' | 'history' | 'run';

export const JOB_TABS = ['all', 'scheduled', 'on-demand', 'webhooks', 'event-rules'] as const;
export type JobTab = typeof JOB_TABS[number];

const TAB_TO_FILTER: Record<JobTab, TriggerFilter> = {
  all: 'all',
  scheduled: 'schedule',
  'on-demand': 'manual',
  webhooks: 'webhook',
  'event-rules': 'event',
};
const FILTER_TO_TAB: Record<TriggerFilter, JobTab> = {
  all: 'all',
  schedule: 'scheduled',
  manual: 'on-demand',
  webhook: 'webhooks',
  event: 'event-rules',
};

export function triggerFilterForTab(tab: JobTab): TriggerFilter {
  return TAB_TO_FILTER[tab];
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

type ScriptsT = TFunction<'scripts'>;

function toListAutomation(raw: unknown, t: ScriptsT): Automation {
  const item = isPlainRecord(raw) ? raw : {};
  const trigger = isPlainRecord(item.trigger)
    ? item.trigger
    : isPlainRecord(item.triggerConfig)
      ? item.triggerConfig
      : {};

  const triggerType = (
    asString(item.triggerType)
    ?? asString(trigger.type)
    ?? 'manual'
  ) as Automation['triggerType'];

  return {
    id: asString(item.id) ?? '',
    name: asString(item.name) ?? t('automationsPage.fallback.untitled'),
    // orgId === null marks a partner-wide ("All orgs") automation (#2133).
    orgId: item.orgId === null ? null : asString(item.orgId),
    // Seeded, agent-owned automations are read-only in the UI (#3824). The
    // field has to survive this mapping or the badge and the edit lock silently
    // never render.
    managedByAgentId:
      item.managedByAgentId === null ? null : asString(item.managedByAgentId),
    // Compiled-from-monitor automations (#5287) carry this so the fetch layer
    // can filter them out below — a monitor-managed row is an implementation
    // detail of its monitor, not a Job the operator manages here.
    managedByMonitorId:
      item.managedByMonitorId === null ? null : asString(item.managedByMonitorId),
    description: asString(item.description),
    triggerType,
    triggerConfig: {
      cronExpression: asString(trigger.cronExpression) ?? asString(trigger.cron),
      eventType: asString(trigger.eventType),
      webhookUrl: asString(trigger.webhookUrl)
    },
    actions: Array.isArray(item.actions)
      ? item.actions.filter(isPlainRecord).map(action => ({
        type: asString(action.type) ?? '',
        runAs: asString(action.runAs),
      }))
      : [],
    enabled: Boolean(item.enabled),
    lastRunAt: asString(item.lastRunAt),
    lastRunStatus: undefined,
    recentRuns: undefined,
    createdAt: asString(item.createdAt) ?? new Date().toISOString(),
    updatedAt: asString(item.updatedAt) ?? new Date().toISOString()
  };
}

function toRunHistoryRun(raw: unknown, automation: Automation): RunHistoryRun {
  const run = isPlainRecord(raw) ? raw : {};

  const status = asString(run.status) === 'completed'
    ? 'success'
    : ((asString(run.status) ?? 'running') as RunHistoryRun['status']);

  const triggeredByRaw = asString(run.triggeredBy) ?? 'manual';
  const triggeredBy = (triggeredByRaw.split(':')[0] ?? triggeredByRaw) as RunHistoryRun['triggeredBy'];

  const logLines = Array.isArray(run.logs)
    ? run.logs
      .map((entry) => {
        if (typeof entry === 'string') return entry;
        if (isPlainRecord(entry)) {
          const message = asString(entry.message);
          if (!message) return null;
          const level = asString(entry.level) ?? 'info';
          return `[${level}] ${message}`;
        }
        return null;
      })
      .filter((value): value is string => Boolean(value))
    : [];

  return {
    id: asString(run.id) ?? '',
    automationId: automation.id,
    automationName: automation.name,
    triggeredBy,
    startedAt: asString(run.startedAt) ?? new Date().toISOString(),
    completedAt: asString(run.completedAt),
    status,
    devicesTotal: Number(run.devicesTargeted ?? 0),
    devicesSuccess: Number(run.devicesSucceeded ?? 0),
    devicesFailed: Number(run.devicesFailed ?? 0),
    devicesSkipped: 0,
    deviceResults: [],
    logs: logLines
  };
}

const RUN_HISTORY_POLL_MS = 4000;

const DEVICE_RESULT_STATUSES = ['pending', 'running', 'success', 'failed', 'skipped'] as const;

/** Parse the per-device script executions a run queued (#3162). */
function toDeviceScriptResults(raw: unknown): DeviceScriptResult[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const parsed = raw
    .map((entry): DeviceScriptResult | null => {
      if (!isPlainRecord(entry)) return null;
      const executionId = asString(entry.executionId);
      const scriptId = asString(entry.scriptId);
      if (!executionId || !scriptId) return null;
      return {
        executionId,
        scriptId,
        scriptName: asString(entry.scriptName),
        status: asString(entry.status) ?? 'pending',
        exitCode: typeof entry.exitCode === 'number' ? entry.exitCode : undefined,
        stdout: asString(entry.stdout),
        stdoutTruncated: entry.stdoutTruncated === true,
        stderr: asString(entry.stderr),
        stderrTruncated: entry.stderrTruncated === true,
        error: asString(entry.error),
      };
    })
    .filter((entry): entry is DeviceScriptResult => entry !== null);
  // Dropping every row silently would render identically to "this run queued no
  // scripts", hiding a backend contract break (renamed field, null scriptId)
  // behind an empty panel. Say so.
  if (raw.length > 0 && parsed.length === 0) {
    console.warn(
      `[AutomationsPage] discarded all ${raw.length} script result(s) for a device — unexpected payload shape`,
    );
  }
  return parsed.length > 0 ? parsed : undefined;
}

function toDeviceRunResult(raw: unknown): DeviceRunResult | null {
  if (!isPlainRecord(raw)) return null;
  const deviceId = asString(raw.deviceId);
  if (!deviceId) return null;
  const statusRaw = asString(raw.status) ?? 'pending';
  const status = (DEVICE_RESULT_STATUSES as readonly string[]).includes(statusRaw)
    ? (statusRaw as DeviceRunResult['status'])
    : 'pending';
  const duration = typeof raw.duration === 'number' ? raw.duration : undefined;
  return {
    deviceId,
    deviceName: asString(raw.deviceName) ?? deviceId,
    status,
    startedAt: asString(raw.startedAt),
    completedAt: asString(raw.completedAt),
    duration,
    output: asString(raw.output),
    error: asString(raw.error),
    scriptResults: toDeviceScriptResults(raw.scriptResults),
  };
}

export default function AutomationsPage() {
  const { t } = useTranslation('scripts');
  const { permissions } = usePermissions();
  // #3262 — mirrors canManagePartnerWidePolicies(auth) server-side. UX only;
  // the cancel route re-checks this on every request.
  const canManagePartnerWide = useAuthStore((s) => s.user?.canManagePartnerWide);
  const [automations, setAutomations] = useState<Automation[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const [modalMode, setModalMode] = useState<ModalMode>('closed');
  const [selectedAutomation, setSelectedAutomation] = useState<Automation | null>(null);
  const [runHistory, setRunHistory] = useState<RunHistoryRun[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [tab, setTab] = useHashTab<JobTab>(JOB_TABS, 'all');
  const switchTab = (next: JobTab) => {
    window.location.hash = next;
    setTab(next);
  };

  const fetchAutomations = useCallback(async () => {
    try {
      setLoading(true);
      setError(undefined);
      const response = await fetchWithAuth('/automations');
      if (!response.ok) {
        throw new Error(t('automationsPage.errors.fetch'));
      }
      const data = await response.json();
      const rows = data.data ?? data.automations ?? [];
      // Monitor-managed automations (#5287) are compiled artifacts of their
      // monitor, not Jobs an operator manages here — hide them from the list.
      // (Non-monitor-managed automations still show, including agent-managed
      // ones, which render read-only inline instead of being hidden — #3824.)
      setAutomations(
        Array.isArray(rows)
          ? rows.map((row: unknown) => toListAutomation(row, t)).filter((automation) => !automation.managedByMonitorId)
          : []
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : t('automationsPage.errors.generic'));
    } finally {
      setLoading(false);
    }
  }, [t]);

  const fetchRunHistory = useCallback(async (automation: Automation) => {
    try {
      const response = await fetchWithAuth(`/automations/${automation.id}/runs`);
      if (response.ok) {
        const data = await response.json();
        const rows = data.data ?? data.runs ?? [];
        setRunHistory(Array.isArray(rows) ? rows.map((row: unknown) => toRunHistoryRun(row, automation)) : []);
      }
    } catch {
      // Silently fail
    }
  }, []);

  const fetchRunDetail = useCallback(async (runId: string) => {
    try {
      const response = await fetchWithAuth(`/automations/runs/${runId}`);
      if (!response.ok) return null;
      const data = await response.json();
      const deviceResults = Array.isArray(data.deviceResults)
        ? data.deviceResults
          .map(toDeviceRunResult)
          .filter((r: DeviceRunResult | null): r is DeviceRunResult => r !== null)
        : [];
      const logs = Array.isArray(data.logs)
        ? data.logs.filter((l: unknown): l is string => typeof l === 'string')
        : undefined;
      return { deviceResults, logs };
    } catch {
      return null;
    }
  }, []);

  useEffect(() => {
    fetchAutomations();
  }, [fetchAutomations]);

  // Live progress: while the history modal is open and any run is still in
  // progress, re-poll the run list so counts/statuses update (#2023). Stops
  // automatically once no run is running (or the modal closes).
  useEffect(() => {
    if (modalMode !== 'history' || !selectedAutomation) return;
    const hasRunningRun = runHistory.some((run) => run.status === 'running');
    if (!hasRunningRun) return;
    const timer = setInterval(() => {
      void fetchRunHistory(selectedAutomation);
    }, RUN_HISTORY_POLL_MS);
    return () => clearInterval(timer);
  }, [modalMode, selectedAutomation, runHistory, fetchRunHistory]);

  const handleEdit = (automation: Automation) => {
    void navigateTo(`/jobs/${automation.id}`);
  };

  const handleDelete = (automation: Automation) => {
    setSelectedAutomation(automation);
    setModalMode('delete');
  };

  // Run / toggle / delete go through runAction so every failure is toasted
  // (#3531). The page-level `error` banner renders behind the delete modal's
  // fixed z-50 scrim, so a failed delete used to be invisible.
  const handleRun = async (automation: Automation) => {
    setSubmitting(true);
    try {
      await runAction({
        request: () =>
          fetchWithAuth(`/automations/${automation.id}/trigger`, {
            method: 'POST'
          }),
        errorFallback: t('automationsPage.errors.run'),
        onUnauthorized: handleSessionExpired,
      });
      await fetchAutomations();
    } catch (err) {
      handleActionError(err, t('automationsPage.errors.run'));
    } finally {
      setSubmitting(false);
    }
  };

  const handleToggle = async (automation: Automation, enabled: boolean) => {
    const fallback = enabled ? t('automationsPage.errors.enable') : t('automationsPage.errors.disable');
    try {
      await runAction({
        request: () =>
          fetchWithAuth(`/automations/${automation.id}`, {
            method: 'PUT',
            body: JSON.stringify({ enabled })
          }),
        errorFallback: fallback,
        onUnauthorized: handleSessionExpired,
      });
      setAutomations(prev =>
        prev.map(a => (a.id === automation.id ? { ...a, enabled } : a))
      );
    } catch (err) {
      handleActionError(err, fallback);
    }
  };

  const handleViewHistory = async (automation: Automation) => {
    setSelectedAutomation(automation);
    await fetchRunHistory(automation);
    setModalMode('history');
  };

  const handleCloseModal = () => {
    setModalMode('closed');
    setSelectedAutomation(null);
    setRunHistory([]);
  };

  const handleConfirmDelete = async () => {
    if (!selectedAutomation) return;

    setSubmitting(true);
    try {
      await runAction({
        request: () =>
          fetchWithAuth(`/automations/${selectedAutomation.id}`, {
            method: 'DELETE'
          }),
        errorFallback: t('automationsPage.errors.delete'),
        onUnauthorized: handleSessionExpired,
      });
      await fetchAutomations();
      handleCloseModal();
    } catch (err) {
      // runAction already toasted; keep the confirmation modal open so the
      // operator can retry or cancel, and do not refetch as if it succeeded.
      handleActionError(err, t('automationsPage.errors.delete'));
    } finally {
      setSubmitting(false);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <div className="text-center">
          <div className="h-8 w-8 animate-spin rounded-full border-4 border-primary border-t-transparent mx-auto" />
          <p className="mt-4 text-sm text-muted-foreground">{t('automationsPage.loading')}</p>
        </div>
      </div>
    );
  }

  if (error && automations.length === 0) {
    return (
      <div className="rounded-lg border border-destructive/40 bg-destructive/10 p-6 text-center">
        <p className="text-sm text-destructive">{error}</p>
        <button
          type="button"
          onClick={fetchAutomations}
          className="mt-4 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:opacity-90"
        >
          {t('common:actions.retry')}
        </button>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">{t('automationsPage.title')}</h1>
          <p className="text-muted-foreground">{t('automationsPage.description')}</p>
        </div>
        <a
          href="/jobs/new"
          className="inline-flex h-10 items-center justify-center gap-2 rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground transition hover:opacity-90"
        >
          <Plus className="h-4 w-4" />
          {t('automationsPage.actions.new')}
        </a>
      </div>

      <nav className="flex gap-1 border-b" aria-label={t('automationsPage.tabs.ariaLabel')}>
        {JOB_TABS.map((key) => (
          <button
            key={key}
            type="button"
            onClick={() => switchTab(key)}
            aria-current={tab === key ? 'page' : undefined}
            className={`-mb-px border-b-2 px-3 py-2 text-sm ${tab === key ? 'border-primary font-medium text-foreground' : 'border-transparent text-muted-foreground hover:text-foreground'}`}
          >
            {t(/* i18n-dynamic */ `automationsPage.tabs.${key}`)}
          </button>
        ))}
      </nav>

      {error && (
        <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {error}
        </div>
      )}

      <AutomationList
        automations={automations}
        onEdit={handleEdit}
        onDelete={handleDelete}
        onRun={handleRun}
        onToggle={handleToggle}
        onViewHistory={handleViewHistory}
        triggerFilter={triggerFilterForTab(tab)}
        onTriggerFilterChange={(value) => switchTab(FILTER_TO_TAB[value])}
      />

      {/* Delete Confirmation Modal */}
      {modalMode === 'delete' && selectedAutomation && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-background/80 px-4 py-8">
          <div className="w-full max-w-md rounded-lg border bg-card p-6 shadow-xs">
            <h2 className="text-lg font-semibold">{t('automationsPage.deleteDialog.title')}</h2>
            <p className="mt-2 text-sm text-muted-foreground">
              {t('automationsPage.deleteDialog.confirmPrefix')}{' '}
              <span className="font-medium">{selectedAutomation.name}</span>?{' '}
              {t('automationsPage.deleteDialog.confirmSuffix')}
            </p>
            <div className="mt-6 flex justify-end gap-3">
              <button
                type="button"
                onClick={handleCloseModal}
                className="h-10 rounded-md border px-4 text-sm font-medium text-muted-foreground transition hover:text-foreground"
              >
                {t('common:actions.cancel')}
              </button>
              <button
                type="button"
                onClick={handleConfirmDelete}
                disabled={submitting}
                className="inline-flex h-10 items-center justify-center rounded-md bg-destructive px-4 text-sm font-medium text-destructive-foreground transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-60"
              >
                {submitting ? t('automationsPage.actions.deleting') : t('common:actions.delete')}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Run History Modal */}
      {modalMode === 'history' && selectedAutomation && (
        <AutomationRunHistory
          runs={runHistory}
          isOpen={true}
          onClose={handleCloseModal}
          automationName={selectedAutomation.name}
          onLoadRunDetail={fetchRunDetail}
          permissions={permissions}
          canManagePartnerWide={canManagePartnerWide}
          onRunCancelled={() => void fetchRunHistory(selectedAutomation)}
        />
      )}
    </div>
  );
}
