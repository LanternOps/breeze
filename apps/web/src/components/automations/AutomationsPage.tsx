import { useState, useEffect, useCallback } from 'react';
import { Plus } from 'lucide-react';
import AutomationList, { type Automation, type AutomationRun } from './AutomationList';
import AutomationRunHistory, { type AutomationRun as RunHistoryRun } from './AutomationRunHistory';

type ModalMode = 'closed' | 'delete' | 'history' | 'run';

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
      const response = await fetch('/api/automations');
      if (!response.ok) {
        throw new Error('Failed to fetch automations');
      }
      const data = await response.json();
      setAutomations(data.automations ?? data ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'An error occurred');
    } finally {
      setLoading(false);
    }
  }, []);

  const fetchRunHistory = useCallback(async (automationId: string) => {
    try {
      const response = await fetch(`/api/automations/${automationId}/runs`);
      if (response.ok) {
        const data = await response.json();
        setRunHistory(data.runs ?? data ?? []);
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
      const response = await fetch(`/api/automations/${automation.id}/run`, {
        method: 'POST'
      });

      if (!response.ok) {
        throw new Error('Failed to run automation');
      }

      // Refresh list to update status
      await fetchAutomations();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'An error occurred');
    } finally {
      setSubmitting(false);
    }
  };

  const handleToggle = async (automation: Automation, enabled: boolean) => {
    try {
      const response = await fetch(`/api/automations/${automation.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
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
    await fetchRunHistory(automation.id);
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
      const response = await fetch(`/api/automations/${selectedAutomation.id}`, {
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
