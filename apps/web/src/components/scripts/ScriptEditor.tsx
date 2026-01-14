import { useMemo, useState } from 'react';
import { GitCommit, Play, Plus, Save, Trash2 } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { ScriptLanguage } from './ScriptList';

type ParameterType = 'string' | 'number' | 'boolean' | 'json';

type ScriptParameter = {
  id: string;
  name: string;
  type: ParameterType;
  defaultValue: string;
};

type ScriptEditorProps = {
  initialLanguage?: ScriptLanguage;
};

const mockParameters: ScriptParameter[] = [
  { id: 'param-1', name: 'maxRetries', type: 'number', defaultValue: '3' },
  { id: 'param-2', name: 'targetPath', type: 'string', defaultValue: '/var/log' }
];

const mockDevices = [
  { id: 'device-1', name: 'Office Mac Mini', status: 'online' },
  { id: 'device-2', name: 'Warehouse PC', status: 'offline' },
  { id: 'device-3', name: 'Build Agent', status: 'online' }
];

const languageSamples: Record<ScriptLanguage, string> = {
  powershell: `Write-Host "Starting cleanup"
Get-ChildItem $env:TEMP -Recurse | Remove-Item -Force`,
  bash: `echo "Starting cleanup"
find /tmp -type f -mtime +7 -delete`,
  python: `print("Starting cleanup")
import shutil
shutil.rmtree("/tmp/cache")`,
  cmd: `echo Starting cleanup
forfiles /p %TEMP% /s /d -7 /c "cmd /c del @path"`
};

const parameterTypeOptions: { value: ParameterType; label: string }[] = [
  { value: 'string', label: 'Text' },
  { value: 'number', label: 'Number' },
  { value: 'boolean', label: 'Boolean' },
  { value: 'json', label: 'JSON' }
];

export default function ScriptEditor({ initialLanguage = 'powershell' }: ScriptEditorProps) {
  const [language, setLanguage] = useState<ScriptLanguage>(initialLanguage);
  const [parameters, setParameters] = useState<ScriptParameter[]>(mockParameters);
  const [selectedDeviceId, setSelectedDeviceId] = useState(mockDevices[0].id);

  const sampleCode = useMemo(() => languageSamples[language], [language]);

  const addParameter = () => {
    setParameters(prev => [
      ...prev,
      {
        id: `param-${Math.random().toString(36).slice(2, 8)}`,
        name: '',
        type: 'string',
        defaultValue: ''
      }
    ]);
  };

  const updateParameter = <K extends keyof ScriptParameter>(
    id: string,
    field: K,
    value: ScriptParameter[K]
  ) => {
    setParameters(prev => prev.map(param => (param.id === id ? { ...param, [field]: value } : param)));
  };

  const removeParameter = (id: string) => {
    setParameters(prev => prev.filter(param => param.id !== id));
  };

  return (
    <div className="rounded-lg border bg-card p-6 shadow-sm">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h2 className="text-lg font-semibold">Script Editor</h2>
          <p className="text-sm text-muted-foreground">Draft, version, and run scripts quickly.</p>
        </div>
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
          <select
            value={language}
            onChange={event => setLanguage(event.target.value as ScriptLanguage)}
            className="h-10 rounded-md border bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
          >
            <option value="powershell">PowerShell</option>
            <option value="bash">Bash</option>
            <option value="python">Python</option>
            <option value="cmd">CMD</option>
          </select>
          <select
            value={selectedDeviceId}
            onChange={event => setSelectedDeviceId(event.target.value)}
            className="h-10 rounded-md border bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
          >
            {mockDevices.map(device => (
              <option key={device.id} value={device.id}>
                {device.name} ({device.status})
              </option>
            ))}
          </select>
          <button
            type="button"
            className="flex items-center gap-2 rounded-md border px-3 py-2 text-sm font-medium hover:bg-muted"
          >
            <Save className="h-4 w-4" />
            Save
          </button>
          <button
            type="button"
            className="flex items-center gap-2 rounded-md bg-primary px-3 py-2 text-sm font-medium text-primary-foreground"
          >
            <GitCommit className="h-4 w-4" />
            Save Version
          </button>
        </div>
      </div>

      <div className="mt-6 space-y-6">
        <div>
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-semibold">Editor</h3>
            <button
              type="button"
              className="flex items-center gap-2 rounded-md border px-3 py-1.5 text-xs font-medium hover:bg-muted"
            >
              <Play className="h-3 w-3" />
              Run on device
            </button>
          </div>
          <div
            className={cn(
              'monaco-editor mt-3 min-h-[280px] rounded-md border bg-slate-950/90 p-4 text-slate-100',
              `language-${language}`
            )}
          >
            <pre className="whitespace-pre-wrap text-sm leading-6">{sampleCode}</pre>
          </div>
        </div>

        <div>
          <div className="flex items-center justify-between">
            <div>
              <h3 className="text-sm font-semibold">Parameters</h3>
              <p className="text-xs text-muted-foreground">Define runtime inputs for the script.</p>
            </div>
            <button
              type="button"
              onClick={addParameter}
              className="flex items-center gap-2 rounded-md border px-3 py-1.5 text-xs font-medium hover:bg-muted"
            >
              <Plus className="h-3 w-3" />
              Add Parameter
            </button>
          </div>

          <div className="mt-3 space-y-3">
            {parameters.map(param => (
              <div
                key={param.id}
                className="grid gap-3 rounded-md border bg-background p-3 sm:grid-cols-[1.2fr_1fr_1fr_auto]"
              >
                <input
                  value={param.name}
                  onChange={event => updateParameter(param.id, 'name', event.target.value)}
                  placeholder="Parameter name"
                  className="h-9 rounded-md border bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                />
                <select
                  value={param.type}
                  onChange={event => updateParameter(param.id, 'type', event.target.value as ParameterType)}
                  className="h-9 rounded-md border bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                >
                  {parameterTypeOptions.map(option => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
                <input
                  value={param.defaultValue}
                  onChange={event => updateParameter(param.id, 'defaultValue', event.target.value)}
                  placeholder="Default value"
                  className="h-9 rounded-md border bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                />
                <button
                  type="button"
                  onClick={() => removeParameter(param.id)}
                  className="flex h-9 w-9 items-center justify-center rounded-md text-red-500 hover:bg-red-500/10"
                >
                  <Trash2 className="h-4 w-4" />
                </button>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
