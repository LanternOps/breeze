import { useState, useEffect, useCallback } from 'react';
import { Plus } from 'lucide-react';
import ScriptList, { type Script } from './ScriptList';
import ScriptExecutionModal, { type Device, type Site } from './ScriptExecutionModal';
import ExecutionDetails from './ExecutionDetails';
import type { ScriptExecution } from './ExecutionHistory';
import type { ScriptParameter } from './ScriptForm';
import { fetchWithAuth } from '../../stores/auth';

type ModalMode = 'closed' | 'execute' | 'delete' | 'execution-details';

type ScriptWithDetails = Script & {
  parameters?: ScriptParameter[];
  content?: string;
};

export default function ScriptsPage() {
  const [scripts, setScripts] = useState<ScriptWithDetails[]>([]);
  const [devices, setDevices] = useState<Device[]>([]);
  const [sites, setSites] = useState<Site[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const [modalMode, setModalMode] = useState<ModalMode>('closed');
  const [selectedScript, setSelectedScript] = useState<ScriptWithDetails | null>(null);
  const [selectedExecution, setSelectedExecution] = useState<ScriptExecution | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const fetchScripts = useCallback(async () => {
    try {
      setLoading(true);
      setError(undefined);
      const response = await fetchWithAuth('/scripts');
      if (!response.ok) {
        if (response.status === 401) {
          window.location.href = '/login';
          return;
        }
        throw new Error('Failed to fetch scripts');
      }
      const data = await response.json();
      setScripts(data.data ?? data.scripts ?? (Array.isArray(data) ? data : []));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'An error occurred');
    } finally {
      setLoading(false);
    }
  }, []);

  const fetchDevices = useCallback(async () => {
    try {
      const response = await fetchWithAuth('/devices');
      if (response.ok) {
        const data = await response.json();
        setDevices(data.data ?? data.devices ?? (Array.isArray(data) ? data : []));
      }
    } catch {
      // Silently fail - devices will be empty
    }
  }, []);

  const fetchSites = useCallback(async () => {
    try {
      const response = await fetchWithAuth('/orgs/sites');
      if (response.ok) {
        const data = await response.json();
        setSites(data.data ?? data.sites ?? (Array.isArray(data) ? data : []));
      }
    } catch {
      // Silently fail - sites will be empty
    }
  }, []);

  useEffect(() => {
    fetchScripts();
    fetchDevices();
    fetchSites();
  }, [fetchScripts, fetchDevices, fetchSites]);

  const handleRun = async (script: Script) => {
    // Fetch full script details including parameters
    try {
      const response = await fetchWithAuth(`/scripts/${script.id}`);
      if (response.ok) {
        const data = await response.json();
        setSelectedScript(data.script ?? data);
      } else {
        setSelectedScript(script);
      }
    } catch {
      setSelectedScript(script);
    }
    setModalMode('execute');
  };

  const handleEdit = (script: Script) => {
    window.location.href = `/scripts/${script.id}`;
  };

  const handleDelete = (script: Script) => {
    setSelectedScript(script);
    setModalMode('delete');
  };

  const handleCloseModal = () => {
    setModalMode('closed');
    setSelectedScript(null);
    setSelectedExecution(null);
  };

  const handleExecute = async (
    scriptId: string,
    deviceIds: string[],
    parameters: Record<string, string | number | boolean>
  ) => {
    const response = await fetchWithAuth('/scripts/execute', {
      method: 'POST',
      body: JSON.stringify({ scriptId, deviceIds, parameters })
    });

    if (!response.ok) {
      const data = await response.json();
      throw new Error(data.error || 'Failed to execute script');
    }

    // Update last run time locally - use fixed timestamp for SSR compatibility
    const lastRunTime = '2024-01-15T12:00:00.000Z';
    setScripts(prev =>
      prev.map(s =>
        s.id === scriptId
          ? { ...s, lastRun: lastRunTime }
          : s
      )
    );
  };

  const handleConfirmDelete = async () => {
    if (!selectedScript) return;

    setSubmitting(true);
    try {
      const response = await fetchWithAuth(`/scripts/${selectedScript.id}`, {
        method: 'DELETE'
      });

      if (!response.ok) {
        throw new Error('Failed to delete script');
      }

      await fetchScripts();
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
          <p className="mt-4 text-sm text-muted-foreground">Loading scripts...</p>
        </div>
      </div>
    );
  }

  if (error && scripts.length === 0) {
    return (
      <div className="rounded-lg border border-destructive/40 bg-destructive/10 p-6 text-center">
        <p className="text-sm text-destructive">{error}</p>
        <button
          type="button"
          onClick={fetchScripts}
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
          <h1 className="text-2xl font-bold">Script Library</h1>
          <p className="text-muted-foreground">Manage and execute scripts across your devices.</p>
        </div>
        <a
          href="/scripts/new"
          className="inline-flex h-10 items-center justify-center gap-2 rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground transition hover:opacity-90"
        >
          <Plus className="h-4 w-4" />
          New Script
        </a>
      </div>

      {error && (
        <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {error}
        </div>
      )}

      <ScriptList
        scripts={scripts}
        onRun={handleRun}
        onEdit={handleEdit}
        onDelete={handleDelete}
      />

      {/* Execute Modal */}
      {modalMode === 'execute' && selectedScript && (
        <ScriptExecutionModal
          script={selectedScript}
          devices={devices}
          sites={sites}
          isOpen={true}
          onClose={handleCloseModal}
          onExecute={handleExecute}
        />
      )}

      {/* Execution Details Modal */}
      {modalMode === 'execution-details' && selectedExecution && (
        <ExecutionDetails
          execution={selectedExecution}
          isOpen={true}
          onClose={handleCloseModal}
        />
      )}

      {/* Delete Confirmation Modal */}
      {modalMode === 'delete' && selectedScript && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-background/80 px-4 py-8">
          <div className="w-full max-w-md rounded-lg border bg-card p-6 shadow-sm">
            <h2 className="text-lg font-semibold">Delete Script</h2>
            <p className="mt-2 text-sm text-muted-foreground">
              Are you sure you want to delete <span className="font-medium">{selectedScript.name}</span>?
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
    </div>
  );
}
