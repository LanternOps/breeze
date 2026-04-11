import { useState, useMemo, useEffect } from 'react';
import { X, Search, Play, Loader2, ChevronLeft } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Dialog } from '../shared/Dialog';
import { fetchWithAuth } from '../../stores/auth';
import type { ScriptParameter } from '../scripts/ScriptFormSchema';
import ScriptParametersForm, { validateParameters } from '../scripts/ScriptParametersForm';

export type ScriptLanguage = 'powershell' | 'bash' | 'python' | 'cmd';
export type OSType = 'windows' | 'macos' | 'linux';
export type ScriptRunAsSelection = 'system' | 'user';

export type Script = {
  id: string;
  name: string;
  description?: string;
  language: ScriptLanguage;
  category: string;
  osTypes: OSType[];
  isSystem?: boolean;
  parameters?: ScriptParameter[];
};

type ScriptPickerModalProps = {
  isOpen: boolean;
  onClose: () => void;
  onSelect: (script: Script, runAs: ScriptRunAsSelection, parameters?: Record<string, unknown>) => void;
  deviceHostname?: string;
  deviceOs?: OSType | OSType[];
};

const languageConfig: Record<ScriptLanguage, { label: string; color: string; icon: string }> = {
  powershell: { label: 'PowerShell', color: 'bg-blue-500/20 text-blue-700', icon: 'PS' },
  bash: { label: 'Bash', color: 'bg-green-500/20 text-green-700', icon: '$' },
  python: { label: 'Python', color: 'bg-yellow-500/20 text-yellow-700', icon: 'Py' },
  cmd: { label: 'CMD', color: 'bg-gray-500/20 text-gray-700', icon: '>' }
};

export default function ScriptPickerModal({
  isOpen,
  onClose,
  onSelect,
  deviceHostname,
  deviceOs
}: ScriptPickerModalProps) {
  const [scripts, setScripts] = useState<Script[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const [query, setQuery] = useState('');
  const [categoryFilter, setCategoryFilter] = useState<string>('all');
  const [runAs, setRunAs] = useState<ScriptRunAsSelection>('system');

  // Parameter step state
  const [view, setView] = useState<'list' | 'params'>('list');
  const [selectedScript, setSelectedScript] = useState<Script | null>(null);
  const [paramValues, setParamValues] = useState<Record<string, unknown>>({});
  const [paramError, setParamError] = useState<string | undefined>();

  useEffect(() => {
    if (isOpen) {
      setRunAs('system');
      setView('list');
      setSelectedScript(null);
      setParamValues({});
      setParamError(undefined);
      fetchScripts();
    }
  }, [isOpen]);

  async function fetchScripts() {
    try {
      setLoading(true);
      setError(undefined);

      const response = await fetchWithAuth('/scripts');
      if (!response.ok) {
        throw new Error('Failed to fetch scripts');
      }

      const data = await response.json();
      const scriptList = data.data ?? data.scripts ?? data ?? [];

      // Transform scripts
      const transformedScripts: Script[] = scriptList
        .map((s: Record<string, unknown>) => ({
          id: s.id as string,
          name: (s.name ?? 'Unnamed Script') as string,
          description: s.description as string | undefined,
          language: (s.language ?? 'bash') as ScriptLanguage,
          category: (s.category ?? 'General') as string,
          osTypes: (s.osTypes ?? s.os_types ?? ['macos', 'linux']) as OSType[],
          isSystem: s.isSystem as boolean | undefined,
          parameters: Array.isArray(s.parameters) ? (s.parameters as ScriptParameter[]) : undefined
        }));

      setScripts(transformedScripts);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load scripts');
    } finally {
      setLoading(false);
    }
  }

  const categories = useMemo(() => {
    const cats = new Set(scripts.map(s => s.category));
    return Array.from(cats).sort();
  }, [scripts]);

  const filteredScripts = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase();
    let osFilter: OSType[] | null = null;
    if (deviceOs) {
      osFilter = Array.isArray(deviceOs) ? deviceOs : [deviceOs];
    }

    return scripts.filter(script => {
      const matchesQuery = normalizedQuery.length === 0
        ? true
        : script.name.toLowerCase().includes(normalizedQuery) ||
          (script.description?.toLowerCase().includes(normalizedQuery) ?? false);
      const matchesCategory = categoryFilter === 'all' ? true : script.category === categoryFilter;
      const matchesOs = !osFilter || osFilter.some(os => script.osTypes.includes(os));

      return matchesQuery && matchesCategory && matchesOs;
    });
  }, [scripts, query, categoryFilter, deviceOs]);

  const handleSelect = (script: Script) => {
    if (script.parameters && script.parameters.length > 0) {
      // Seed param values from defaults
      const defaults: Record<string, unknown> = {};
      for (const param of script.parameters) {
        if (param.defaultValue !== undefined) {
          if (param.type === 'number') {
            defaults[param.name] = Number(param.defaultValue) || 0;
          } else if (param.type === 'boolean') {
            defaults[param.name] = param.defaultValue === 'true';
          } else {
            defaults[param.name] = param.defaultValue;
          }
        } else {
          defaults[param.name] = param.type === 'boolean' ? false : param.type === 'number' ? 0 : '';
        }
      }
      setParamValues(defaults);
      setSelectedScript(script);
      setParamError(undefined);
      setView('params');
    } else {
      onSelect(script, runAs, undefined);
      onClose();
    }
  };

  const handleBack = () => {
    setSelectedScript(null);
    setParamValues({});
    setParamError(undefined);
    setView('list');
  };

  const handleRunScript = () => {
    if (!selectedScript?.parameters) return;
    const error = validateParameters(selectedScript.parameters, paramValues);
    if (error) {
      setParamError(error);
      return;
    }
    onSelect(selectedScript, runAs, paramValues);
    onClose();
  };

  return (
    <Dialog open={isOpen} onClose={onClose} title="Select Script" maxWidth="2xl" className="max-h-[80vh] overflow-hidden flex flex-col">
      {view === 'list' ? (
        <>
          {/* Header */}
          <div className="flex items-center justify-between border-b px-6 py-4">
            <div>
              <h2 className="text-lg font-semibold">Select Script</h2>
              {deviceHostname && (
                <p className="text-sm text-muted-foreground">
                  Run script on {deviceHostname}
                </p>
              )}
            </div>
            <button
              type="button"
              onClick={onClose}
              className="flex h-8 w-8 items-center justify-center rounded-md hover:bg-muted"
            >
              <X className="h-5 w-5" />
            </button>
          </div>

          {/* Filters */}
          <div className="border-b px-6 py-3">
            <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
              <div className="relative flex-1">
                <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                <input
                  type="search"
                  placeholder="Search scripts..."
                  value={query}
                  onChange={e => setQuery(e.target.value)}
                  className="h-9 w-full rounded-md border bg-background pl-9 pr-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                />
              </div>
              {categories.length > 0 && (
                <select
                  value={categoryFilter}
                  onChange={e => setCategoryFilter(e.target.value)}
                  className="h-9 rounded-md border bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                >
                  <option value="all">All Categories</option>
                  {categories.map(cat => (
                    <option key={cat} value={cat}>
                      {cat}
                    </option>
                  ))}
                </select>
              )}
              <select
                value={runAs}
                onChange={e => setRunAs(e.target.value as ScriptRunAsSelection)}
                className="h-9 rounded-md border bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
              >
                <option value="system">Run as: System</option>
                <option value="user">Run as: Logged-in user</option>
              </select>
            </div>
          </div>

          {/* Content */}
          <div className="flex-1 overflow-y-auto p-4">
            {loading ? (
              <div className="flex items-center justify-center py-12">
                <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
              </div>
            ) : error ? (
              <div className="rounded-md border border-destructive/40 bg-destructive/10 px-4 py-3 text-sm text-destructive">
                {error}
              </div>
            ) : filteredScripts.length === 0 ? (
              <div className="py-12 text-center text-sm text-muted-foreground">
                {scripts.length === 0 ? 'No scripts available' : 'No scripts match your search'}
              </div>
            ) : (
              <div className="space-y-2">
                {filteredScripts.map(script => (
                  <button
                    key={script.id}
                    type="button"
                    onClick={() => handleSelect(script)}
                    className="flex w-full items-start gap-3 rounded-lg border p-4 text-left transition hover:bg-muted/50"
                  >
                    <div className={cn(
                      'flex h-8 w-8 shrink-0 items-center justify-center rounded text-xs font-bold',
                      languageConfig[script.language].color
                    )}>
                      {languageConfig[script.language].icon}
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
                        <span>
                          {script.osTypes.join(', ')}
                        </span>
                        {script.parameters && script.parameters.length > 0 && (
                          <span className="inline-flex items-center rounded-full bg-muted px-2 py-0.5">
                            {script.parameters.length} param{script.parameters.length !== 1 ? 's' : ''}
                          </span>
                        )}
                      </div>
                    </div>
                    <Play className="h-4 w-4 shrink-0 text-muted-foreground" />
                  </button>
                ))}
              </div>
            )}
          </div>

          {/* Footer */}
          <div className="flex items-center justify-between border-t px-6 py-4">
            <p className="text-sm text-muted-foreground">
              {filteredScripts.length} script(s) available
            </p>
            <button
              type="button"
              onClick={onClose}
              className="h-10 rounded-md border px-4 text-sm font-medium text-muted-foreground transition hover:text-foreground"
            >
              Cancel
            </button>
          </div>
        </>
      ) : (
        <>
          {/* Parameter step header */}
          <div className="flex items-center justify-between border-b px-6 py-4">
            <div className="flex items-center gap-3">
              <button
                type="button"
                onClick={handleBack}
                className="flex h-8 w-8 items-center justify-center rounded-md hover:bg-muted"
                aria-label="Back to script list"
              >
                <ChevronLeft className="h-5 w-5" />
              </button>
              <div>
                <h2 className="text-lg font-semibold">Configure Parameters</h2>
                {selectedScript && (
                  <p className="text-sm text-muted-foreground">{selectedScript.name}</p>
                )}
              </div>
            </div>
            <button
              type="button"
              onClick={onClose}
              className="flex h-8 w-8 items-center justify-center rounded-md hover:bg-muted"
            >
              <X className="h-5 w-5" />
            </button>
          </div>

          {/* Parameter step content */}
          <div className="flex-1 overflow-y-auto p-6 space-y-4">
            {paramError && (
              <div className="rounded-md border border-destructive/40 bg-destructive/10 px-4 py-3 text-sm text-destructive">
                {paramError}
              </div>
            )}
            {selectedScript?.parameters && (
              <ScriptParametersForm
                parameters={selectedScript.parameters}
                values={paramValues}
                onChange={(name, value) => setParamValues(prev => ({ ...prev, [name]: value }))}
              />
            )}
          </div>

          {/* Parameter step footer */}
          <div className="flex items-center justify-end gap-3 border-t px-6 py-4">
            <button
              type="button"
              onClick={onClose}
              className="h-10 rounded-md border px-4 text-sm font-medium text-muted-foreground transition hover:text-foreground"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={handleRunScript}
              className="inline-flex h-10 items-center justify-center gap-2 rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground transition hover:bg-primary/90"
            >
              <Play className="h-4 w-4" />
              Run Script
            </button>
          </div>
        </>
      )}
    </Dialog>
  );
}
