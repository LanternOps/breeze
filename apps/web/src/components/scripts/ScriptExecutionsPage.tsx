import { useState, useEffect, useCallback } from 'react';
import { ArrowLeft, Play } from 'lucide-react';
import ExecutionHistory, { type ScriptExecution } from './ExecutionHistory';
import ExecutionDetails from './ExecutionDetails';
import ScriptExecutionModal, { type Device, type Site } from './ScriptExecutionModal';
import type { Script } from './ScriptList';
import type { ScriptParameter } from './ScriptForm';
import { fetchWithAuth } from '../../stores/auth';

type ScriptExecutionsPageProps = {
  scriptId: string;
};

type ScriptWithDetails = Script & {
  parameters?: ScriptParameter[];
  content?: string;
};

export default function ScriptExecutionsPage({ scriptId }: ScriptExecutionsPageProps) {
  const [script, setScript] = useState<ScriptWithDetails | null>(null);
  const [executions, setExecutions] = useState<ScriptExecution[]>([]);
  const [devices, setDevices] = useState<Device[]>([]);
  const [sites, setSites] = useState<Site[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const [selectedExecution, setSelectedExecution] = useState<ScriptExecution | null>(null);
  const [showExecuteModal, setShowExecuteModal] = useState(false);

  const fetchScript = useCallback(async () => {
    try {
      const response = await fetchWithAuth(`/scripts/${scriptId}`);
      if (!response.ok) {
        if (response.status === 401) {
          window.location.href = '/login';
          return;
        }
        throw new Error('Failed to fetch script');
      }
      const data = await response.json();
      setScript(data.script ?? data);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'An error occurred');
    }
  }, [scriptId]);

  const fetchExecutions = useCallback(async () => {
    try {
      setLoading(true);
      setError(undefined);
      const response = await fetchWithAuth(`/scripts/${scriptId}/executions`);
      if (!response.ok) {
        if (response.status === 401) {
          window.location.href = '/login';
          return;
        }
        throw new Error('Failed to fetch executions');
      }
      const data = await response.json();
      setExecutions(data.data ?? data.executions ?? (Array.isArray(data) ? data : []));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'An error occurred');
    } finally {
      setLoading(false);
    }
  }, [scriptId]);

  const fetchDevices = useCallback(async () => {
    try {
      const response = await fetchWithAuth('/devices');
      if (response.ok) {
        const data = await response.json();
        setDevices(data.data ?? data.devices ?? (Array.isArray(data) ? data : []));
      }
    } catch {
      // Silently fail
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
      // Silently fail
    }
  }, []);

  useEffect(() => {
    fetchScript();
    fetchExecutions();
    fetchDevices();
    fetchSites();
  }, [fetchScript, fetchExecutions, fetchDevices, fetchSites]);

  const handleViewDetails = (execution: ScriptExecution) => {
    setSelectedExecution(execution);
  };

  const handleCloseDetails = () => {
    setSelectedExecution(null);
  };

  const handleExecute = async (
    _scriptId: string,
    deviceIds: string[],
    parameters: Record<string, string | number | boolean>
  ) => {
    const response = await fetchWithAuth(`/scripts/${scriptId}/execute`, {
      method: 'POST',
      body: JSON.stringify({ deviceIds, parameters })
    });

    if (!response.ok) {
      if (response.status === 401) {
        window.location.href = '/login';
        return;
      }
      const data = await response.json();
      throw new Error(data.error || 'Failed to execute script');
    }

    // Refresh executions list
    await fetchExecutions();
  };

  if (loading && !script) {
    return (
      <div className="flex items-center justify-center py-12">
        <div className="text-center">
          <div className="h-8 w-8 animate-spin rounded-full border-4 border-primary border-t-transparent mx-auto" />
          <p className="mt-4 text-sm text-muted-foreground">Loading executions...</p>
        </div>
      </div>
    );
  }

  if (error && executions.length === 0 && !script) {
    return (
      <div className="rounded-lg border border-destructive/40 bg-destructive/10 p-6 text-center">
        <p className="text-sm text-destructive">{error}</p>
        <div className="mt-4 flex justify-center gap-3">
          <a
            href="/scripts"
            className="rounded-md border px-4 py-2 text-sm font-medium hover:bg-muted"
          >
            Back to Scripts
          </a>
          <button
            type="button"
            onClick={() => {
              fetchScript();
              fetchExecutions();
            }}
            className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:opacity-90"
          >
            Try again
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-4">
          <a
            href={`/scripts/${scriptId}`}
            className="flex h-10 w-10 items-center justify-center rounded-md border hover:bg-muted"
          >
            <ArrowLeft className="h-5 w-5" />
          </a>
          <div>
            <h1 className="text-2xl font-bold">Execution History</h1>
            <p className="text-muted-foreground">
              {script?.name || 'Loading...'}
            </p>
          </div>
        </div>
        {script && (
          <button
            type="button"
            onClick={() => setShowExecuteModal(true)}
            className="inline-flex h-10 items-center justify-center gap-2 rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground transition hover:opacity-90"
          >
            <Play className="h-4 w-4" />
            Run Script
          </button>
        )}
      </div>

      {error && (
        <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {error}
        </div>
      )}

      {script && (
        <div className="rounded-md border bg-muted/20 p-4">
          <div className="grid gap-4 sm:grid-cols-4">
            <div>
              <p className="text-xs font-medium text-muted-foreground">Language</p>
              <p className="text-sm font-medium capitalize">{script.language}</p>
            </div>
            <div>
              <p className="text-xs font-medium text-muted-foreground">Category</p>
              <p className="text-sm font-medium">{script.category}</p>
            </div>
            <div>
              <p className="text-xs font-medium text-muted-foreground">Target OS</p>
              <p className="text-sm font-medium">{script.osTypes.join(', ')}</p>
            </div>
            <div>
              <p className="text-xs font-medium text-muted-foreground">Status</p>
              <p className="text-sm font-medium capitalize">{script.status}</p>
            </div>
          </div>
          {script.description && (
            <p className="mt-3 text-sm text-muted-foreground">{script.description}</p>
          )}
        </div>
      )}

      <ExecutionHistory
        executions={executions}
        onViewDetails={handleViewDetails}
        showScriptName={false}
      />

      {/* Execution Details Modal */}
      {selectedExecution && (
        <ExecutionDetails
          execution={selectedExecution}
          isOpen={true}
          onClose={handleCloseDetails}
        />
      )}

      {/* Execute Modal */}
      {showExecuteModal && script && (
        <ScriptExecutionModal
          script={script}
          devices={devices}
          sites={sites}
          isOpen={true}
          onClose={() => setShowExecuteModal(false)}
          onExecute={handleExecute}
        />
      )}
    </div>
  );
}
