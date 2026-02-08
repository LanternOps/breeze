import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Editor from '@monaco-editor/react';
import {
  ArrowLeft,
  Copy,
  Loader2,
  Play,
  Plus,
  Save,
  Trash2
} from 'lucide-react';
import { cn } from '@/lib/utils';
import type { ScriptLanguage, OSType } from './ScriptList';

type ParameterType = 'string' | 'number' | 'boolean' | 'dropdown' | 'filePath';

type ScriptParameter = {
  id: string;
  name: string;
  type: ParameterType;
  defaultValue?: string;
  required?: boolean;
  options?: string;
};

type ScriptRecord = {
  id: string;
  name: string;
  description?: string | null;
  category?: string | null;
  osTypes: OSType[];
  language: ScriptLanguage;
  content: string;
  parameters?: Array<{
    name: string;
    type?: string;
    defaultValue?: string;
    required?: boolean;
    options?: string;
  }>;
  timeoutSeconds?: number;
  runAs?: 'system' | 'user' | 'elevated';
  version?: number;
  createdAt?: string;
  updatedAt?: string;
};

type ScriptFormState = {
  name: string;
  description: string;
  category: string;
  osTypes: OSType[];
  language: ScriptLanguage;
  content: string;
  parameters: ScriptParameter[];
  timeoutSeconds: number;
  runAs: 'system' | 'user' | 'elevated';
};

type Device = {
  id: string;
  hostname: string;
  status?: string;
  os?: OSType;
  osType?: OSType;
};

type ExecutionStatus =
  | 'pending'
  | 'queued'
  | 'running'
  | 'completed'
  | 'failed'
  | 'timeout'
  | 'cancelled';

type ExecutionDetails = {
  id: string;
  status: ExecutionStatus;
  stdout?: string;
  stderr?: string;
  errorMessage?: string;
  exitCode?: number;
  startedAt?: string;
  completedAt?: string;
};

type VersionEntry = {
  id: string;
  version: number;
  updatedAt: string;
  label?: string;
};

type ScriptEditorProps = {
  scriptId: string;
  timezone?: string;
};

const categoryOptions = [
  'Maintenance',
  'Security',
  'Monitoring',
  'Deployment',
  'Backup',
  'Network',
  'User Management',
  'Software',
  'Custom'
];

const parameterTypeOptions: { value: ParameterType; label: string }[] = [
  { value: 'string', label: 'String' },
  { value: 'number', label: 'Number' },
  { value: 'boolean', label: 'Boolean' },
  { value: 'dropdown', label: 'Dropdown' },
  { value: 'filePath', label: 'File path' }
];

const languageOptions: { value: ScriptLanguage; label: string; monaco: string }[] = [
  { value: 'powershell', label: 'PowerShell', monaco: 'powershell' },
  { value: 'bash', label: 'Bash', monaco: 'shell' },
  { value: 'python', label: 'Python', monaco: 'python' },
  { value: 'cmd', label: 'CMD', monaco: 'bat' }
];

const executionStatusStyles: Record<ExecutionStatus, string> = {
  pending: 'bg-gray-500/10 text-gray-700',
  queued: 'bg-blue-500/10 text-blue-700',
  running: 'bg-blue-500/10 text-blue-700',
  completed: 'bg-green-500/10 text-green-700',
  failed: 'bg-red-500/10 text-red-700',
  timeout: 'bg-yellow-500/10 text-yellow-700',
  cancelled: 'bg-gray-500/10 text-gray-700'
};

let idCounter = 0;
const createId = (prefix: string = 'id') => {
  idCounter += 1;
  return `${prefix}-${idCounter}`;
};

const createParameterId = () => createId('param');

const normalizeParameterType = (type?: string): ParameterType => {
  if (!type) return 'string';
  if (type === 'select' || type === 'dropdown') return 'dropdown';
  if (type === 'file_path' || type === 'filePath') return 'filePath';
  if (type === 'number') return 'number';
  if (type === 'boolean') return 'boolean';
  return 'string';
};

const serializeParameterType = (type: ParameterType) => {
  if (type === 'dropdown') return 'select';
  return type;
};

const formatDateTime = (value?: string, timezone?: string) => {
  if (!value) return 'Unknown';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  const tz = timezone || Intl.DateTimeFormat().resolvedOptions().timeZone;
  return date.toLocaleString([], {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    timeZone: tz
  });
};

const buildConsoleOutput = (details: ExecutionDetails | null, events: string[]) => {
  const lines: string[] = [];
  lines.push(...events);

  if (details?.stdout) {
    lines.push('--- stdout ---', details.stdout.trim());
  }

  if (details?.stderr) {
    lines.push('--- stderr ---', details.stderr.trim());
  }

  if (lines.length === 0) {
    return 'Run a test to see output here.';
  }

  return lines.filter(line => line !== '').join('\n');
};

const normalizeParameters = (parameters: ScriptRecord['parameters']): ScriptParameter[] => {
  if (!Array.isArray(parameters)) return [];
  return parameters.map(param => ({
    id: createParameterId(),
    name: param.name ?? '',
    type: normalizeParameterType(param.type),
    defaultValue: param.defaultValue ?? '',
    required: Boolean(param.required),
    options: param.options ?? ''
  }));
};

export default function ScriptEditor({ scriptId, timezone }: ScriptEditorProps) {
  const [script, setScript] = useState<ScriptRecord | null>(null);
  const [formState, setFormState] = useState<ScriptFormState | null>(null);
  const [versionHistory, setVersionHistory] = useState<VersionEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saveAsLoading, setSaveAsLoading] = useState(false);
  const [saveAsOpen, setSaveAsOpen] = useState(false);
  const [saveAsName, setSaveAsName] = useState('');
  const [saveAsError, setSaveAsError] = useState<string>();
  const [error, setError] = useState<string>();
  const [validationErrors, setValidationErrors] = useState<Record<string, string>>({});

  const [devices, setDevices] = useState<Device[]>([]);
  const [devicesLoading, setDevicesLoading] = useState(false);
  const [selectedDeviceId, setSelectedDeviceId] = useState('');
  const [testParameters, setTestParameters] = useState<Record<string, string | number | boolean>>({});
  const [executionState, setExecutionState] = useState<'idle' | 'running' | 'error'>('idle');
  const [executionDetails, setExecutionDetails] = useState<ExecutionDetails | null>(null);
  const [executionError, setExecutionError] = useState<string>();
  const [consoleEvents, setConsoleEvents] = useState<string[]>([]);
  const [activeExecutionId, setActiveExecutionId] = useState<string | null>(null);
  const pollingRef = useRef<number | null>(null);

  const monacoLanguage = useMemo(() => {
    const match = languageOptions.find(option => option.value === formState?.language);
    return match?.monaco ?? 'plaintext';
  }, [formState?.language]);

  const loadScript = useCallback(async () => {
    try {
      setLoading(true);
      setError(undefined);
      const response = await fetch(`/api/scripts/${scriptId}`);
      if (!response.ok) {
        throw new Error('Failed to fetch script');
      }
      const data = await response.json();
      const scriptData: ScriptRecord = data.script ?? data;
      setScript(scriptData);
      setFormState({
        name: scriptData.name ?? '',
        description: scriptData.description ?? '',
        category: scriptData.category ?? 'Custom',
        osTypes: scriptData.osTypes ?? [],
        language: scriptData.language ?? 'powershell',
        content: scriptData.content ?? '',
        parameters: normalizeParameters(scriptData.parameters),
        timeoutSeconds: scriptData.timeoutSeconds ?? 300,
        runAs: scriptData.runAs ?? 'system'
      });
      setSaveAsName(`${scriptData.name ?? 'Script'} Copy`);
      if (scriptData.version) {
        setVersionHistory([
          {
            id: `version-${scriptData.version}`,
            version: scriptData.version,
            updatedAt: scriptData.updatedAt ?? scriptData.createdAt ?? new Date().toISOString(),
            label: 'Current'
          }
        ]);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'An error occurred');
    } finally {
      setLoading(false);
    }
  }, [scriptId]);

  const loadDevices = useCallback(async () => {
    try {
      setDevicesLoading(true);
      const response = await fetch('/api/devices');
      if (response.ok) {
        const data = await response.json();
        const deviceList: Device[] = data.devices ?? data ?? [];
        setDevices(deviceList);
        if (deviceList.length > 0) {
          setSelectedDeviceId(prev => prev || deviceList[0].id);
        }
      }
    } catch {
      // Silently ignore device fetch failures.
    } finally {
      setDevicesLoading(false);
    }
  }, []);

  useEffect(() => {
    loadScript();
    loadDevices();
  }, [loadDevices, loadScript]);

  useEffect(() => {
    if (!formState) return;
    setTestParameters(prev => {
      const next: Record<string, string | number | boolean> = { ...prev };
      const names = new Set<string>();

      formState.parameters.forEach(param => {
        const key = param.name.trim();
        if (!key) return;
        names.add(key);
        if (!(key in next)) {
          if (param.type === 'number') {
            next[key] = Number(param.defaultValue ?? 0);
          } else if (param.type === 'boolean') {
            next[key] = param.defaultValue === 'true';
          } else {
            next[key] = param.defaultValue ?? '';
          }
        }
      });

      Object.keys(next).forEach(key => {
        if (!names.has(key)) {
          delete next[key];
        }
      });

      return next;
    });
  }, [formState?.parameters]);

  useEffect(() => {
    if (!activeExecutionId) return;
    let cancelled = false;

    const poll = async () => {
      try {
        const response = await fetch(`/api/scripts/executions/${activeExecutionId}`);
        if (!response.ok) {
          throw new Error('Failed to fetch execution output');
        }
        const data: ExecutionDetails = await response.json();
        if (cancelled) return;
        setExecutionDetails(data);
        if (data.status !== 'running' && data.status !== 'queued' && data.status !== 'pending') {
          if (pollingRef.current) {
            window.clearInterval(pollingRef.current);
          }
          setExecutionState(data.status === 'completed' ? 'idle' : 'error');
          setConsoleEvents(prev => [
            ...prev,
            `Execution ${data.status} (exit code ${data.exitCode ?? 'n/a'})`
          ]);
          setActiveExecutionId(null);
        }
      } catch (err) {
        if (cancelled) return;
        setExecutionError(err instanceof Error ? err.message : 'Failed to fetch execution output');
        if (pollingRef.current) {
          window.clearInterval(pollingRef.current);
        }
        setActiveExecutionId(null);
      }
    };

    poll();
    pollingRef.current = window.setInterval(poll, 2000);

    return () => {
      cancelled = true;
      if (pollingRef.current) {
        window.clearInterval(pollingRef.current);
      }
    };
  }, [activeExecutionId]);

  const updateFormState = <K extends keyof ScriptFormState>(key: K, value: ScriptFormState[K]) => {
    setFormState(prev => (prev ? { ...prev, [key]: value } : prev));
    setValidationErrors(prev => {
      const next = { ...prev };
      delete next[key as string];
      return next;
    });
  };

  const handleOsToggle = (os: OSType) => {
    if (!formState) return;
    const current = formState.osTypes;
    if (current.includes(os)) {
      if (current.length === 1) return;
      updateFormState('osTypes', current.filter(item => item !== os));
    } else {
      updateFormState('osTypes', [...current, os]);
    }
  };

  const addParameter = () => {
    if (!formState) return;
    updateFormState('parameters', [
      ...formState.parameters,
      {
        id: createParameterId(),
        name: '',
        type: 'string',
        defaultValue: '',
        required: false,
        options: ''
      }
    ]);
  };

  const updateParameter = (id: string, patch: Partial<ScriptParameter>) => {
    if (!formState) return;
    updateFormState(
      'parameters',
      formState.parameters.map(param => (param.id === id ? { ...param, ...patch } : param))
    );
  };

  const removeParameter = (id: string) => {
    if (!formState) return;
    updateFormState(
      'parameters',
      formState.parameters.filter(param => param.id !== id)
    );
  };

  const validateForm = () => {
    if (!formState) return false;
    const nextErrors: Record<string, string> = {};
    if (!formState.name.trim()) {
      nextErrors.name = 'Script name is required';
    }
    if (!formState.category.trim()) {
      nextErrors.category = 'Category is required';
    }
    if (!formState.content.trim()) {
      nextErrors.content = 'Script content is required';
    }
    if (formState.osTypes.length === 0) {
      nextErrors.osTypes = 'Select at least one OS target';
    }
    setValidationErrors(nextErrors);
    return Object.keys(nextErrors).length === 0;
  };

  const buildPayload = (nameOverride?: string) => {
    if (!formState) return null;
    return {
      name: nameOverride ?? formState.name.trim(),
      description: formState.description.trim(),
      category: formState.category.trim(),
      osTypes: formState.osTypes,
      language: formState.language,
      content: formState.content,
      parameters: formState.parameters
        .filter(param => param.name.trim())
        .map(param => ({
          name: param.name.trim(),
          type: serializeParameterType(param.type),
          defaultValue: param.defaultValue?.toString() ?? '',
          required: Boolean(param.required),
          options: param.type === 'dropdown' ? param.options?.trim() ?? '' : undefined
        })),
      timeoutSeconds: formState.timeoutSeconds,
      runAs: formState.runAs
    };
  };

  const handleSave = async () => {
    if (!validateForm() || !formState) return;
    const payload = buildPayload();
    if (!payload) return;
    setSaving(true);
    setError(undefined);
    try {
      const response = await fetch(`/api/scripts/${scriptId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      if (!response.ok) {
        const data = await response.json();
        throw new Error(data.error || 'Failed to save script');
      }
      const data = await response.json();
      const updated: ScriptRecord = data.script ?? data;
      setScript(updated);
      const nextVersion = updated.version;
      if (typeof nextVersion === 'number') {
        setVersionHistory(prev => {
          const last = prev[0];
          if (last?.version === nextVersion) {
            return [
              {
                ...last,
                updatedAt: updated.updatedAt ?? last.updatedAt
              },
              ...prev.slice(1)
            ];
          }
          return [
            {
              id: `version-${nextVersion}`,
              version: nextVersion,
              updatedAt: updated.updatedAt ?? new Date().toISOString(),
              label: 'Current'
            },
            ...prev.map(entry => ({ ...entry, label: undefined }))
          ];
        });
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'An error occurred');
    } finally {
      setSaving(false);
    }
  };

  const handleSaveAs = async () => {
    if (!validateForm() || !formState) return;
    if (!saveAsName.trim()) {
      setSaveAsError('Provide a name for the new script.');
      return;
    }
    const payload = buildPayload(saveAsName);
    if (!payload) return;
    setSaveAsLoading(true);
    setSaveAsError(undefined);
    try {
      const response = await fetch('/api/scripts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      if (!response.ok) {
        const data = await response.json();
        throw new Error(data.error || 'Failed to save script');
      }
      const data = await response.json();
      const created: ScriptRecord = data.script ?? data;
      window.location.href = `/scripts/${created.id}`;
    } catch (err) {
      setSaveAsError(err instanceof Error ? err.message : 'An error occurred');
    } finally {
      setSaveAsLoading(false);
    }
  };

  const handleTestParamChange = (name: string, value: string | number | boolean) => {
    setTestParameters(prev => ({ ...prev, [name]: value }));
  };

  const handleRunTest = async () => {
    if (!script || !formState) return;
    if (!selectedDeviceId) {
      setExecutionError('Select a device to run the test.');
      return;
    }

    setExecutionError(undefined);
    setExecutionState('running');
    setExecutionDetails(null);
    const deviceLabel = devices.find(device => device.id === selectedDeviceId)?.hostname ?? selectedDeviceId;
    setConsoleEvents([`Starting test on ${deviceLabel}`]);

    try {
      const response = await fetch(`/api/scripts/${script.id}/execute`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          deviceIds: [selectedDeviceId],
          parameters: testParameters
        })
      });

      if (!response.ok) {
        const data = await response.json();
        throw new Error(data.error || 'Failed to execute script');
      }

      const data = await response.json();
      const executionId = data.executions?.[0]?.executionId ?? data.executionId ?? null;
      if (executionId) {
        setActiveExecutionId(executionId);
        setConsoleEvents(prev => [...prev, `Execution queued (${executionId})`]);
      } else {
        setExecutionState('idle');
        setConsoleEvents(prev => [...prev, 'Execution queued. Awaiting output...']);
      }
    } catch (err) {
      setExecutionError(err instanceof Error ? err.message : 'Failed to execute script');
      setExecutionState('error');
    }
  };

  const filteredDevices = useMemo(() => {
    if (!formState) return devices;
    return devices.filter(device => {
      const os = device.os ?? device.osType;
      if (!os) return true;
      return formState.osTypes.includes(os);
    });
  }, [devices, formState]);

  useEffect(() => {
    if (filteredDevices.length === 0) return;
    if (!selectedDeviceId || !filteredDevices.some(device => device.id === selectedDeviceId)) {
      setSelectedDeviceId(filteredDevices[0].id);
    }
  }, [filteredDevices, selectedDeviceId]);

  const consoleOutput = useMemo(
    () => buildConsoleOutput(executionDetails, consoleEvents),
    [consoleEvents, executionDetails]
  );

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <div className="text-center">
          <div className="h-8 w-8 animate-spin rounded-full border-4 border-primary border-t-transparent mx-auto" />
          <p className="mt-4 text-sm text-muted-foreground">Loading script editor...</p>
        </div>
      </div>
    );
  }

  if (error && !formState) {
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
            onClick={loadScript}
            className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:opacity-90"
          >
            Try again
          </button>
        </div>
      </div>
    );
  }

  if (!formState) {
    return null;
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
        <div className="flex items-center gap-4">
          <a
            href="/scripts"
            className="flex h-10 w-10 items-center justify-center rounded-md border hover:bg-muted"
          >
            <ArrowLeft className="h-5 w-5" />
          </a>
          <div>
            <h1 className="text-2xl font-bold">Script Editor</h1>
            <p className="text-sm text-muted-foreground">
              {script?.name || 'Untitled script'}
            </p>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <button
            type="button"
            onClick={() => {
              setSaveAsError(undefined);
              setSaveAsOpen(true);
            }}
            className="inline-flex h-10 items-center justify-center gap-2 rounded-md border px-4 text-sm font-medium transition hover:bg-muted"
          >
            <Copy className="h-4 w-4" />
            Save As
          </button>
          <button
            type="button"
            onClick={handleSave}
            disabled={saving}
            className="inline-flex h-10 items-center justify-center gap-2 rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
            {saving ? 'Saving...' : 'Save'}
          </button>
        </div>
      </div>

      {error && (
        <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {error}
        </div>
      )}

      <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_320px]">
        <div className="space-y-6">
          <div className="rounded-lg border bg-card p-6 shadow-sm">
            <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
              <div>
                <h2 className="text-lg font-semibold">Script Content</h2>
                <p className="text-sm text-muted-foreground">Edit and test script logic.</p>
              </div>
              <select
                value={formState.language}
                onChange={event => updateFormState('language', event.target.value as ScriptLanguage)}
                className="h-10 w-full rounded-md border bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring md:w-48"
              >
                {languageOptions.map(option => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            </div>
            <div className="mt-4 overflow-hidden rounded-md border">
              <Editor
                height="420px"
                language={monacoLanguage}
                value={formState.content}
                onChange={value => updateFormState('content', value || '')}
                theme="vs-dark"
                options={{
                  minimap: { enabled: false },
                  fontSize: 14,
                  lineNumbers: 'on',
                  scrollBeyondLastLine: false,
                  wordWrap: 'on',
                  automaticLayout: true,
                  tabSize: 2,
                  padding: { top: 12, bottom: 12 }
                }}
                loading={
                  <div className="flex items-center justify-center h-[420px] bg-[#1e1e1e]">
                    <div className="text-center text-white/60">
                      <div className="h-6 w-6 animate-spin rounded-full border-2 border-white/40 border-t-white mx-auto" />
                      <p className="mt-2 text-sm">Loading editor...</p>
                    </div>
                  </div>
                }
              />
            </div>
            {validationErrors.content && (
              <p className="mt-2 text-sm text-destructive">{validationErrors.content}</p>
            )}
          </div>

          <div className="rounded-lg border bg-card p-6 shadow-sm">
            <h2 className="text-lg font-semibold">Script Metadata</h2>
            <p className="text-sm text-muted-foreground">Define script details and target environments.</p>

            <div className="mt-5 grid gap-5 md:grid-cols-2">
              <div className="space-y-2">
                <label htmlFor="script-name" className="text-sm font-medium">
                  Script name
                </label>
                <input
                  id="script-name"
                  value={formState.name}
                  onChange={event => updateFormState('name', event.target.value)}
                  placeholder="Clear Temp Files"
                  className="h-10 w-full rounded-md border bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                />
                {validationErrors.name && <p className="text-sm text-destructive">{validationErrors.name}</p>}
              </div>

              <div className="space-y-2">
                <label htmlFor="script-category" className="text-sm font-medium">
                  Category
                </label>
                <select
                  id="script-category"
                  value={formState.category}
                  onChange={event => updateFormState('category', event.target.value)}
                  className="h-10 w-full rounded-md border bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                >
                  {categoryOptions.map(category => (
                    <option key={category} value={category}>
                      {category}
                    </option>
                  ))}
                </select>
                {validationErrors.category && (
                  <p className="text-sm text-destructive">{validationErrors.category}</p>
                )}
              </div>

              <div className="space-y-2 md:col-span-2">
                <label htmlFor="script-description" className="text-sm font-medium">
                  Description
                </label>
                <textarea
                  id="script-description"
                  value={formState.description}
                  onChange={event => updateFormState('description', event.target.value)}
                  rows={2}
                  placeholder="Describe what this script does..."
                  className="w-full rounded-md border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring resize-none"
                />
              </div>

              <div className="space-y-2 md:col-span-2">
                <label className="text-sm font-medium">Target OS</label>
                <div className="flex flex-wrap gap-2">
                  {(['windows', 'macos', 'linux'] as OSType[]).map(os => (
                    <button
                      key={os}
                      type="button"
                      onClick={() => handleOsToggle(os)}
                      className={cn(
                        'rounded-md border px-3 py-2 text-sm font-medium transition',
                        formState.osTypes.includes(os)
                          ? 'border-primary bg-primary text-primary-foreground'
                          : 'border-input bg-background hover:bg-muted'
                      )}
                    >
                      {os === 'windows' ? 'Windows' : os === 'macos' ? 'macOS' : 'Linux'}
                    </button>
                  ))}
                </div>
                {validationErrors.osTypes && (
                  <p className="text-sm text-destructive">{validationErrors.osTypes}</p>
                )}
              </div>
            </div>
          </div>

          <div className="rounded-lg border bg-card p-6 shadow-sm">
            <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
              <div>
                <h2 className="text-lg font-semibold">Parameters</h2>
                <p className="text-sm text-muted-foreground">Define runtime inputs for this script.</p>
              </div>
              <button
                type="button"
                onClick={addParameter}
                className="inline-flex h-9 items-center justify-center gap-2 rounded-md border px-3 text-sm font-medium hover:bg-muted"
              >
                <Plus className="h-4 w-4" />
                Add Parameter
              </button>
            </div>

            <div className="mt-4 space-y-3">
              {formState.parameters.length === 0 && (
                <div className="rounded-md border border-dashed p-6 text-center text-sm text-muted-foreground">
                  No parameters defined yet.
                </div>
              )}
              {formState.parameters.map(param => (
                <div key={param.id} className="rounded-md border bg-muted/20 p-4">
                  <div className="grid gap-4 md:grid-cols-[1.2fr_1fr_1fr_0.6fr_auto]">
                    <div className="space-y-1">
                      <label className="text-xs font-medium text-muted-foreground">Name</label>
                      <input
                        value={param.name}
                        onChange={event => updateParameter(param.id, { name: event.target.value })}
                        placeholder="parameterName"
                        className="h-9 w-full rounded-md border bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                      />
                    </div>
                    <div className="space-y-1">
                      <label className="text-xs font-medium text-muted-foreground">Type</label>
                      <select
                        value={param.type}
                        onChange={event =>
                          updateParameter(param.id, { type: event.target.value as ParameterType })
                        }
                        className="h-9 w-full rounded-md border bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                      >
                        {parameterTypeOptions.map(option => (
                          <option key={option.value} value={option.value}>
                            {option.label}
                          </option>
                        ))}
                      </select>
                    </div>
                    <div className="space-y-1">
                      <label className="text-xs font-medium text-muted-foreground">Default</label>
                      {param.type === 'boolean' ? (
                        <select
                          value={param.defaultValue ?? 'false'}
                          onChange={event => updateParameter(param.id, { defaultValue: event.target.value })}
                          className="h-9 w-full rounded-md border bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                        >
                          <option value="false">false</option>
                          <option value="true">true</option>
                        </select>
                      ) : (
                        <input
                          value={param.defaultValue ?? ''}
                          onChange={event => updateParameter(param.id, { defaultValue: event.target.value })}
                          placeholder={param.type === 'filePath' ? '/var/log' : 'Default value'}
                          className="h-9 w-full rounded-md border bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                        />
                      )}
                    </div>
                    <div className="space-y-1">
                      <label className="text-xs font-medium text-muted-foreground">Required</label>
                      <div className="flex h-9 items-center gap-2">
                        <input
                          type="checkbox"
                          checked={Boolean(param.required)}
                          onChange={event => updateParameter(param.id, { required: event.target.checked })}
                          className="h-4 w-4 rounded border-gray-300"
                        />
                        <span className="text-sm">Yes</span>
                      </div>
                    </div>
                    <button
                      type="button"
                      onClick={() => removeParameter(param.id)}
                      className="flex h-9 w-9 items-center justify-center rounded-md text-destructive hover:bg-destructive/10"
                      title="Remove parameter"
                    >
                      <Trash2 className="h-4 w-4" />
                    </button>
                  </div>
                  {param.type === 'dropdown' && (
                    <div className="mt-4 space-y-1">
                      <label className="text-xs font-medium text-muted-foreground">
                        Dropdown options (comma-separated)
                      </label>
                      <input
                        value={param.options ?? ''}
                        onChange={event => updateParameter(param.id, { options: event.target.value })}
                        placeholder="option1, option2, option3"
                        className="h-9 w-full rounded-md border bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                      />
                    </div>
                  )}
                </div>
              ))}
            </div>
          </div>

          <div className="rounded-lg border bg-card p-6 shadow-sm">
            <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
              <div>
                <h2 className="text-lg font-semibold">Test Execution</h2>
                <p className="text-sm text-muted-foreground">Run the current version on a single device.</p>
              </div>
              <button
                type="button"
                onClick={handleRunTest}
                disabled={executionState === 'running' || !selectedDeviceId}
                className="inline-flex h-10 items-center justify-center gap-2 rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-60"
              >
                {executionState === 'running' ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <Play className="h-4 w-4" />
                )}
                {executionState === 'running' ? 'Running...' : 'Run Test'}
              </button>
            </div>

            <div className="mt-4 grid gap-4 md:grid-cols-[1.2fr_1fr]">
              <div className="space-y-2">
                <label className="text-sm font-medium">Device</label>
                <select
                  value={selectedDeviceId}
                  onChange={event => setSelectedDeviceId(event.target.value)}
                  disabled={devicesLoading || filteredDevices.length === 0}
                  className="h-10 w-full rounded-md border bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring disabled:opacity-60"
                >
                  {devicesLoading && <option>Loading devices...</option>}
                  {!devicesLoading && filteredDevices.length === 0 && (
                    <option>No compatible devices</option>
                  )}
                  {filteredDevices.map(device => (
                    <option key={device.id} value={device.id}>
                      {device.hostname} {device.status ? `(${device.status})` : ''}
                    </option>
                  ))}
                </select>
              </div>
              <div className="space-y-2">
                <label className="text-sm font-medium">Target OS</label>
                <div className="rounded-md border bg-muted/20 px-3 py-2 text-sm text-muted-foreground">
                  {formState.osTypes.length > 0 ? formState.osTypes.join(', ') : 'Select OS targets'}
                </div>
              </div>
            </div>

            {formState.parameters.length > 0 && (
              <div className="mt-5 space-y-3">
                <h3 className="text-sm font-semibold">Test Parameters</h3>
                <div className="grid gap-3 sm:grid-cols-2">
                  {formState.parameters.map(param => {
                    const paramName = param.name.trim();
                    if (!paramName) return null;
                    const value = testParameters[paramName];
                    if (param.type === 'boolean') {
                      return (
                        <label key={param.id} className="flex items-center gap-3 rounded-md border bg-muted/20 px-3 py-2">
                          <input
                            type="checkbox"
                            checked={Boolean(value)}
                            onChange={event => handleTestParamChange(paramName, event.target.checked)}
                            className="h-4 w-4 rounded border-gray-300"
                          />
                          <span className="text-sm font-medium">{paramName}</span>
                        </label>
                      );
                    }

                    if (param.type === 'dropdown') {
                      const options = (param.options ?? '').split(',').map(opt => opt.trim()).filter(Boolean);
                      return (
                        <div key={param.id} className="space-y-1">
                          <label className="text-xs font-medium text-muted-foreground">{paramName}</label>
                          <select
                            value={String(value ?? '')}
                            onChange={event => handleTestParamChange(paramName, event.target.value)}
                            className="h-9 w-full rounded-md border bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                          >
                            <option value="">Select...</option>
                            {options.map(option => (
                              <option key={option} value={option}>
                                {option}
                              </option>
                            ))}
                          </select>
                        </div>
                      );
                    }

                    return (
                      <div key={param.id} className="space-y-1">
                        <label className="text-xs font-medium text-muted-foreground">{paramName}</label>
                        <input
                          type={param.type === 'number' ? 'number' : 'text'}
                          value={value === undefined ? '' : String(value)}
                          onChange={event =>
                            handleTestParamChange(
                              paramName,
                              param.type === 'number' ? Number(event.target.value) : event.target.value
                            )
                          }
                          placeholder={param.defaultValue ?? ''}
                          className="h-9 w-full rounded-md border bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                        />
                      </div>
                    );
                  })}
                </div>
              </div>
            )}

            {executionError && (
              <div className="mt-4 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
                {executionError}
              </div>
            )}
          </div>

          <div className="rounded-lg border bg-card p-6 shadow-sm">
            <div className="flex items-center justify-between">
              <div>
                <h2 className="text-lg font-semibold">Execution Output</h2>
                <p className="text-sm text-muted-foreground">Live output from the most recent test run.</p>
              </div>
              {executionDetails?.status && (
                <span
                  className={cn(
                    'rounded-full px-2.5 py-1 text-xs font-medium capitalize',
                    executionStatusStyles[executionDetails.status]
                  )}
                >
                  {executionDetails.status}
                </span>
              )}
            </div>
            <div className="mt-4 rounded-md border bg-muted/20 p-4">
              <pre className="max-h-64 overflow-auto whitespace-pre-wrap text-xs font-mono text-foreground">
                {consoleOutput}
              </pre>
            </div>
            {executionDetails?.errorMessage && (
              <p className="mt-3 text-sm text-destructive">{executionDetails.errorMessage}</p>
            )}
          </div>
        </div>

        <div className="space-y-6">
          <div className="rounded-lg border bg-card p-6 shadow-sm">
            <h2 className="text-lg font-semibold">Version History</h2>
            <p className="text-sm text-muted-foreground">Track saved revisions.</p>
            <div className="mt-4 space-y-3">
              {versionHistory.length === 0 && (
                <div className="rounded-md border border-dashed p-4 text-sm text-muted-foreground">
                  No version history available yet.
                </div>
              )}
              {versionHistory.map(entry => (
                <div
                  key={entry.id}
                  className={cn(
                    'rounded-md border px-3 py-2',
                    entry.label ? 'border-primary/40 bg-primary/5' : 'bg-muted/20'
                  )}
                >
                  <div className="flex items-center justify-between">
                    <span className="text-sm font-medium">v{entry.version}</span>
                    {entry.label && (
                      <span className="rounded-full bg-primary/10 px-2 py-0.5 text-xs font-medium text-primary">
                        {entry.label}
                      </span>
                    )}
                  </div>
                  <p className="mt-1 text-xs text-muted-foreground">{formatDateTime(entry.updatedAt, timezone)}</p>
                </div>
              ))}
            </div>
          </div>

          <div className="rounded-lg border bg-card p-6 shadow-sm">
            <h2 className="text-lg font-semibold">Metadata</h2>
            <div className="mt-4 space-y-3 text-sm text-muted-foreground">
              <div className="flex items-center justify-between">
                <span>Script ID</span>
                <span className="font-mono text-xs text-foreground">{script?.id}</span>
              </div>
              <div className="flex items-center justify-between">
                <span>Last updated</span>
                <span className="text-foreground">{formatDateTime(script?.updatedAt, timezone)}</span>
              </div>
              <div className="flex items-center justify-between">
                <span>Created</span>
                <span className="text-foreground">{formatDateTime(script?.createdAt, timezone)}</span>
              </div>
              <div className="flex items-center justify-between">
                <span>Language</span>
                <span className="text-foreground capitalize">{script?.language}</span>
              </div>
            </div>
          </div>
        </div>
      </div>

      {saveAsOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-background/80 px-4 py-8">
          <div className="w-full max-w-md rounded-lg border bg-card p-6 shadow-lg">
            <h2 className="text-lg font-semibold">Save Script As</h2>
            <p className="mt-1 text-sm text-muted-foreground">
              Create a new script based on this version.
            </p>
            <div className="mt-4 space-y-2">
              <label htmlFor="save-as-name" className="text-sm font-medium">
                New script name
              </label>
              <input
                id="save-as-name"
                value={saveAsName}
                onChange={event => setSaveAsName(event.target.value)}
                className="h-10 w-full rounded-md border bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
              />
            </div>
            {saveAsError && (
              <div className="mt-3 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
                {saveAsError}
              </div>
            )}
            <div className="mt-6 flex justify-end gap-3">
              <button
                type="button"
                onClick={() => setSaveAsOpen(false)}
                className="h-10 rounded-md border px-4 text-sm font-medium text-muted-foreground transition hover:text-foreground"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={handleSaveAs}
                disabled={saveAsLoading}
                className="inline-flex h-10 items-center justify-center rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-60"
              >
                {saveAsLoading ? 'Saving...' : 'Save As'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
