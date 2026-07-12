import { useState, useEffect, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import { Plus } from 'lucide-react';
import AutomationList, { type Automation } from './AutomationList';
import AutomationRunHistory, {
  type AutomationRun as RunHistoryRun,
  type DeviceRunResult,
} from './AutomationRunHistory';
import { fetchWithAuth } from '../../stores/auth';
import { navigateTo } from '@/lib/navigation';

type ModalMode = 'closed' | 'delete' | 'history' | 'run';

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
    description: asString(item.description),
    triggerType,
    triggerConfig: {
      cronExpression: asString(trigger.cronExpression) ?? asString(trigger.cron),
      eventType: asString(trigger.eventType),
      webhookUrl: asString(trigger.webhookUrl)
    },
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
  };
}

export default function AutomationsPage() {
  const { t } = useTranslation('scripts');
  const [automations, setAutomations] = useState<Automation[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const [modalMode, setModalMode] = useState<ModalMode>('closed');
  const [selectedAutomation, setSelectedAutomation] = useState<Automation | null>(null);
  const [runHistory, setRunHistory] = useState<RunHistoryRun[]>([]);
  const [submitting, setSubmitting] = useState(false);

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
      setAutomations(Array.isArray(rows) ? rows.map((row: unknown) => toListAutomation(row, t)) : []);
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
    void navigateTo(`/automations/${automation.id}`);
  };

  const handleDelete = (automation: Automation) => {
    setSelectedAutomation(automation);
    setModalMode('delete');
  };

  const handleRun = async (automation: Automation) => {
    setSubmitting(true);
    try {
      const response = await fetchWithAuth(`/automations/${automation.id}/trigger`, {
        method: 'POST'
      });

      if (!response.ok) {
        throw new Error(t('automationsPage.errors.run'));
      }

      await fetchAutomations();
    } catch (err) {
      setError(err instanceof Error ? err.message : t('automationsPage.errors.generic'));
    } finally {
      setSubmitting(false);
    }
  };

  const handleToggle = async (automation: Automation, enabled: boolean) => {
    try {
      const response = await fetchWithAuth(`/automations/${automation.id}`, {
        method: 'PUT',
        body: JSON.stringify({ enabled })
      });

      if (!response.ok) {
        throw new Error(enabled ? t('automationsPage.errors.enable') : t('automationsPage.errors.disable'));
      }

      setAutomations(prev =>
        prev.map(a => (a.id === automation.id ? { ...a, enabled } : a))
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : t('automationsPage.errors.generic'));
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
      const response = await fetchWithAuth(`/automations/${selectedAutomation.id}`, {
        method: 'DELETE'
      });

      if (!response.ok) {
        throw new Error(t('automationsPage.errors.delete'));
      }

      await fetchAutomations();
      handleCloseModal();
    } catch (err) {
      setError(err instanceof Error ? err.message : t('automationsPage.errors.generic'));
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
          href="/automations/new"
          className="inline-flex h-10 items-center justify-center gap-2 rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground transition hover:opacity-90"
        >
          <Plus className="h-4 w-4" />
          {t('automationsPage.actions.new')}
        </a>
      </div>

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
        />
      )}
    </div>
  );
}
