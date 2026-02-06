import { useState, useEffect, useCallback, useMemo } from 'react';
import { Plus, Download, Search, X, Loader2, Check } from 'lucide-react';
import ScriptList, { type Script, type ScriptLanguage, type OSType } from './ScriptList';
import ScriptExecutionModal, { type Device, type Site } from './ScriptExecutionModal';
import ExecutionDetails from './ExecutionDetails';
import type { ScriptExecution } from './ExecutionHistory';
import type { ScriptParameter } from './ScriptForm';
import { fetchWithAuth } from '../../stores/auth';
import { cn } from '@/lib/utils';

type ModalMode = 'closed' | 'execute' | 'delete' | 'execution-details' | 'import-library';

type ScriptWithDetails = Script & {
  parameters?: ScriptParameter[];
  content?: string;
};

type SystemScript = {
  id: string;
  name: string;
  description?: string;
  language: ScriptLanguage;
  category: string;
  osTypes: OSType[];
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
  const [systemScripts, setSystemScripts] = useState<SystemScript[]>([]);
  const [loadingLibrary, setLoadingLibrary] = useState(false);
  const [importingId, setImportingId] = useState<string | null>(null);
  const [libraryQuery, setLibraryQuery] = useState('');
  const [libraryCategoryFilter, setLibraryCategoryFilter] = useState<string>('all');

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
    const response = await fetchWithAuth(`/scripts/${scriptId}/execute`, {
      method: 'POST',
      body: JSON.stringify({ deviceIds, parameters })
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

  const handleOpenLibrary = async () => {
    setModalMode('import-library');
    setLibraryQuery('');
    setLibraryCategoryFilter('all');
    setLoadingLibrary(true);
    try {
      const response = await fetchWithAuth('/scripts/system-library');
      if (response.ok) {
        const data = await response.json();
        setSystemScripts(data.data ?? []);
      }
    } catch {
      // handled inline
    } finally {
      setLoadingLibrary(false);
    }
  };

  const handleImport = async (systemScript: SystemScript) => {
    setImportingId(systemScript.id);
    try {
      const response = await fetchWithAuth(`/scripts/import/${systemScript.id}`, {
        method: 'POST',
        body: JSON.stringify({})
      });

      if (!response.ok) {
        const data = await response.json();
        if (response.status === 409) {
          setError(`"${systemScript.name}" is already in your library`);
        } else {
          throw new Error(data.error || 'Failed to import script');
        }
        return;
      }

      await fetchScripts();
      // Remove imported script from the list so it's clear it was added
      setSystemScripts(prev => prev.filter(s => s.id !== systemScript.id));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to import script');
    } finally {
      setImportingId(null);
    }
  };

  // Filter system scripts that are already imported (by name match)
  const importedNames = useMemo(() => new Set(scripts.map(s => s.name)), [scripts]);

  const filteredSystemScripts = useMemo(() => {
    const q = libraryQuery.trim().toLowerCase();
    return systemScripts.filter(s => {
      const matchesQuery = q.length === 0
        || s.name.toLowerCase().includes(q)
        || s.description?.toLowerCase().includes(q);
      const matchesCategory = libraryCategoryFilter === 'all' || s.category === libraryCategoryFilter;
      return matchesQuery && matchesCategory;
    });
  }, [systemScripts, libraryQuery, libraryCategoryFilter]);

  const libraryCategories = useMemo(() => {
    const cats = new Set(systemScripts.map(s => s.category));
    return Array.from(cats).sort();
  }, [systemScripts]);

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
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={handleOpenLibrary}
            className="inline-flex h-10 items-center justify-center gap-2 rounded-md border px-4 text-sm font-medium transition hover:bg-muted"
          >
            <Download className="h-4 w-4" />
            Import from Library
          </button>
          <a
            href="/scripts/new"
            className="inline-flex h-10 items-center justify-center gap-2 rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground transition hover:opacity-90"
          >
            <Plus className="h-4 w-4" />
            New Script
          </a>
        </div>
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

      {/* Import from Library Modal */}
      {modalMode === 'import-library' && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-background/80 px-4 py-8">
          <div className="w-full max-w-2xl max-h-[80vh] overflow-hidden rounded-lg border bg-card shadow-lg flex flex-col">
            <div className="flex items-center justify-between border-b px-6 py-4">
              <div>
                <h2 className="text-lg font-semibold">System Script Library</h2>
                <p className="text-sm text-muted-foreground">Import scripts into your organization</p>
              </div>
              <button
                type="button"
                onClick={handleCloseModal}
                className="flex h-8 w-8 items-center justify-center rounded-md hover:bg-muted"
              >
                <X className="h-5 w-5" />
              </button>
            </div>

            <div className="border-b px-6 py-3">
              <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
                <div className="relative flex-1">
                  <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                  <input
                    type="search"
                    placeholder="Search system scripts..."
                    value={libraryQuery}
                    onChange={e => setLibraryQuery(e.target.value)}
                    className="h-9 w-full rounded-md border bg-background pl-9 pr-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                  />
                </div>
                {libraryCategories.length > 0 && (
                  <select
                    value={libraryCategoryFilter}
                    onChange={e => setLibraryCategoryFilter(e.target.value)}
                    className="h-9 rounded-md border bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                  >
                    <option value="all">All Categories</option>
                    {libraryCategories.map(cat => (
                      <option key={cat} value={cat}>{cat}</option>
                    ))}
                  </select>
                )}
              </div>
            </div>

            <div className="flex-1 overflow-y-auto p-4">
              {loadingLibrary ? (
                <div className="flex items-center justify-center py-12">
                  <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
                </div>
              ) : filteredSystemScripts.length === 0 ? (
                <div className="py-12 text-center text-sm text-muted-foreground">
                  {systemScripts.length === 0 ? 'No system scripts available' : 'No scripts match your search'}
                </div>
              ) : (
                <div className="space-y-2">
                  {filteredSystemScripts.map(script => {
                    const alreadyImported = importedNames.has(script.name);
                    const isImporting = importingId === script.id;
                    return (
                      <div
                        key={script.id}
                        className="flex items-start gap-3 rounded-lg border p-4"
                      >
                        <div className={cn(
                          'flex h-8 w-8 shrink-0 items-center justify-center rounded text-xs font-bold',
                          script.language === 'powershell' ? 'bg-blue-500/20 text-blue-700' :
                          script.language === 'bash' ? 'bg-green-500/20 text-green-700' :
                          script.language === 'python' ? 'bg-yellow-500/20 text-yellow-700' :
                          'bg-gray-500/20 text-gray-700'
                        )}>
                          {script.language === 'powershell' ? 'PS' : script.language === 'bash' ? '$' : script.language === 'python' ? 'Py' : '>'}
                        </div>
                        <div className="flex-1 min-w-0">
                          <p className="font-medium">{script.name}</p>
                          {script.description && (
                            <p className="mt-0.5 text-sm text-muted-foreground line-clamp-2">
                              {script.description}
                            </p>
                          )}
                          <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                            <span className="inline-flex items-center rounded-full bg-muted px-2 py-0.5">
                              {script.category}
                            </span>
                            <span>{script.osTypes.join(', ')}</span>
                          </div>
                        </div>
                        {alreadyImported ? (
                          <span className="inline-flex items-center gap-1 text-xs text-muted-foreground shrink-0">
                            <Check className="h-4 w-4" />
                            Imported
                          </span>
                        ) : (
                          <button
                            type="button"
                            onClick={() => handleImport(script)}
                            disabled={isImporting}
                            className="inline-flex h-8 items-center justify-center gap-1.5 rounded-md border px-3 text-xs font-medium transition hover:bg-muted disabled:opacity-60 shrink-0"
                          >
                            {isImporting ? (
                              <Loader2 className="h-3 w-3 animate-spin" />
                            ) : (
                              <Download className="h-3 w-3" />
                            )}
                            Import
                          </button>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </div>

            <div className="flex items-center justify-between border-t px-6 py-4">
              <p className="text-sm text-muted-foreground">
                {filteredSystemScripts.length} script(s) available
              </p>
              <button
                type="button"
                onClick={handleCloseModal}
                className="h-10 rounded-md border px-4 text-sm font-medium text-muted-foreground transition hover:text-foreground"
              >
                Done
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
