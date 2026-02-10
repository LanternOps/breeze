import { useState, useEffect, useCallback } from 'react';
import { Plus } from 'lucide-react';
import AutomationList, { type Automation } from './AutomationList';
import AutomationRunHistory, { type AutomationRun as RunHistoryRun } from './AutomationRunHistory';
import { fetchWithAuth } from '../../stores/auth';

type ModalMode = 'closed' | 'delete' | 'history' | 'run';

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function toListAutomation(raw: unknown): Automation {
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
    name: asString(item.name) ?? 'Untitled Automation',
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

export default function AutomationsPage() {
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
        throw new Error('Failed to fetch automations');
      }
      const data = await response.json();
      const rows = data.data ?? data.automations ?? [];
      setAutomations(Array.isArray(rows) ? rows.map(toListAutomation) : []);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'An error occurred');
    } finally {
      setLoading(false);
    }
  }, []);

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

  useEffect(() => {
    fetchAutomations();
  }, [fetchAutomations]);

  const handleEdit = (automation: Automation) => {
    window.location.href = `/automations/${automation.id}`;
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
        throw new Error('Failed to run automation');
      }

      await fetchAutomations();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'An error occurred');
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
        throw new Error(`Failed to ${enabled ? 'enable' : 'disable'} automation`);
      }

      setAutomations(prev =>
        prev.map(a => (a.id === automation.id ? { ...a, enabled } : a))
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : 'An error occurred');
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
        throw new Error('Failed to delete automation');
      }

      await fetchAutomations();
      handleCloseModal();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'An error occurred');
    } finally {
      setSubmitting(false);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <div className="text-center">
          <div className="h-8 w-8 animate-spin rounded-full border-4 border-primary border-t-transparent mx-auto" />
          <p className="mt-4 text-sm text-muted-foreground">Loading automations...</p>
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
          Try again
        </button>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">Automations</h1>
          <p className="text-muted-foreground">Create and manage automated workflows.</p>
        </div>
        <a
          href="/automations/new"
          className="inline-flex h-10 items-center justify-center gap-2 rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground transition hover:opacity-90"
        >
          <Plus className="h-4 w-4" />
          New Automation
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
          <div className="w-full max-w-md rounded-lg border bg-card p-6 shadow-sm">
            <h2 className="text-lg font-semibold">Delete Automation</h2>
            <p className="mt-2 text-sm text-muted-foreground">
              Are you sure you want to delete <span className="font-medium">{selectedAutomation.name}</span>?
              This action cannot be undone.
            </p>
            <div className="mt-6 flex justify-end gap-3">
              <button
                type="button"
                onClick={handleCloseModal}
                className="h-10 rounded-md border px-4 text-sm font-medium text-muted-foreground transition hover:text-foreground"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={handleConfirmDelete}
                disabled={submitting}
                className="inline-flex h-10 items-center justify-center rounded-md bg-destructive px-4 text-sm font-medium text-destructive-foreground transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-60"
              >
                {submitting ? 'Deleting...' : 'Delete'}
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
        />
      )}
    </div>
  );
}
