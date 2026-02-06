import { useState, useMemo, useEffect } from 'react';
import { X, Search, Play, Loader2, CheckCircle, AlertCircle, Filter } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { Script, ScriptLanguage } from './ScriptList';
import type { ScriptParameter } from './ScriptForm';
import type { FilterConditionGroup } from '@breeze/shared';
import { FilterBuilder, DEFAULT_FILTER_FIELDS } from '../filters/FilterBuilder';
import { useFilterPreview } from '../../hooks/useFilterPreview';

export type Device = {
  id: string;
  hostname: string;
  os: 'windows' | 'macos' | 'linux';
  status: 'online' | 'offline' | 'maintenance';
  siteId: string;
  siteName: string;
};

export type Site = {
  id: string;
  name: string;
};

type ScriptExecutionModalProps = {
  script: Script & { parameters?: ScriptParameter[]; content?: string };
  devices: Device[];
  sites?: Site[];
  isOpen: boolean;
  onClose: () => void;
  onExecute: (scriptId: string, deviceIds: string[], parameters: Record<string, string | number | boolean>) => Promise<void>;
};

type ExecutionState = 'idle' | 'executing' | 'success' | 'error';

const languageLabels: Record<ScriptLanguage, string> = {
  powershell: 'PowerShell',
  bash: 'Bash',
  python: 'Python',
  cmd: 'CMD'
};

export default function ScriptExecutionModal({
  script,
  devices,
  sites = [],
  isOpen,
  onClose,
  onExecute
}: ScriptExecutionModalProps) {
  const [query, setQuery] = useState('');
  const [siteFilter, setSiteFilter] = useState<string>('all');
  const [statusFilter, setStatusFilter] = useState<string>('online');
  const [selectedDeviceIds, setSelectedDeviceIds] = useState<Set<string>>(new Set());
  const [parameters, setParameters] = useState<Record<string, string | number | boolean>>({});
  const [executionState, setExecutionState] = useState<ExecutionState>('idle');
  const [errorMessage, setErrorMessage] = useState<string>();
  const [showConfirm, setShowConfirm] = useState(false);
  const [showAdvancedFilter, setShowAdvancedFilter] = useState(false);
  const [advancedFilter, setAdvancedFilter] = useState<FilterConditionGroup>({
    operator: 'AND',
    conditions: [{ field: 'hostname', operator: 'contains', value: '' }]
  });

  const { preview: filterPreview } = useFilterPreview(
    showAdvancedFilter ? advancedFilter : null,
    { enabled: showAdvancedFilter }
  );
  const advancedFilterIds = useMemo(() => {
    if (!showAdvancedFilter || !filterPreview) return null;
    return new Set(filterPreview.devices.map(d => d.id));
  }, [showAdvancedFilter, filterPreview]);

  // Initialize parameters with defaults
  useEffect(() => {
    if (script.parameters) {
      const defaults: Record<string, string | number | boolean> = {};
      script.parameters.forEach(param => {
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
      });
      setParameters(defaults);
    }
  }, [script.parameters]);

  // Filter devices based on script OS requirements
  const compatibleDevices = useMemo(() => {
    return devices.filter(device => script.osTypes.includes(device.os));
  }, [devices, script.osTypes]);

  const filteredDevices = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase();

    return compatibleDevices.filter(device => {
      // Apply advanced filter if active
      if (advancedFilterIds !== null && !advancedFilterIds.has(device.id)) {
        return false;
      }

      const matchesQuery = normalizedQuery.length === 0
        ? true
        : device.hostname.toLowerCase().includes(normalizedQuery);
      const matchesSite = siteFilter === 'all' ? true : device.siteId === siteFilter;
      const matchesStatus = statusFilter === 'all' ? true : device.status === statusFilter;

      return matchesQuery && matchesSite && matchesStatus;
    });
  }, [compatibleDevices, query, siteFilter, statusFilter, advancedFilterIds]);

  const handleDeviceToggle = (deviceId: string) => {
    const newSet = new Set(selectedDeviceIds);
    if (newSet.has(deviceId)) {
      newSet.delete(deviceId);
    } else {
      newSet.add(deviceId);
    }
    setSelectedDeviceIds(newSet);
  };

  const handleSelectAll = () => {
    const onlineDevices = filteredDevices.filter(d => d.status === 'online');
    setSelectedDeviceIds(new Set(onlineDevices.map(d => d.id)));
  };

  const handleClearSelection = () => {
    setSelectedDeviceIds(new Set());
  };

  const handleParameterChange = (name: string, value: string | number | boolean) => {
    setParameters(prev => ({ ...prev, [name]: value }));
  };

  const validateParameters = (): boolean => {
    if (!script.parameters) return true;

    for (const param of script.parameters) {
      if (param.required) {
        const value = parameters[param.name];
        if (value === undefined || value === '' || (param.type === 'string' && String(value).trim() === '')) {
          setErrorMessage(`Parameter "${param.name}" is required`);
          return false;
        }
      }
    }
    return true;
  };

  const handleExecute = async () => {
    if (!showConfirm) {
      if (!validateParameters()) return;
      if (selectedDeviceIds.size === 0) {
        setErrorMessage('Please select at least one device');
        return;
      }
      setShowConfirm(true);
      return;
    }

    setExecutionState('executing');
    setErrorMessage(undefined);

    try {
      await onExecute(script.id, Array.from(selectedDeviceIds), parameters);
      setExecutionState('success');
      setTimeout(() => {
        onClose();
        setExecutionState('idle');
        setShowConfirm(false);
        setSelectedDeviceIds(new Set());
      }, 1500);
    } catch (err) {
      setExecutionState('error');
      setErrorMessage(err instanceof Error ? err.message : 'Execution failed');
      setShowConfirm(false);
    }
  };

  const handleClose = () => {
    if (executionState === 'executing') return;
    onClose();
    setExecutionState('idle');
    setShowConfirm(false);
    setErrorMessage(undefined);
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-background/80 px-4 py-8">
      <div className="w-full max-w-3xl max-h-[90vh] overflow-hidden rounded-lg border bg-card shadow-lg flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between border-b px-6 py-4">
          <div>
            <h2 className="text-lg font-semibold">Execute Script</h2>
            <p className="text-sm text-muted-foreground">{script.name}</p>
          </div>
          <button
            type="button"
            onClick={handleClose}
            disabled={executionState === 'executing'}
            className="flex h-8 w-8 items-center justify-center rounded-md hover:bg-muted disabled:opacity-50"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto p-6 space-y-6">
          {/* Script Info */}
          <div className="rounded-md border bg-muted/20 p-4">
            <div className="grid gap-4 sm:grid-cols-3">
              <div>
                <p className="text-xs font-medium text-muted-foreground">Language</p>
                <p className="text-sm font-medium">{languageLabels[script.language]}</p>
              </div>
              <div>
                <p className="text-xs font-medium text-muted-foreground">Category</p>
                <p className="text-sm font-medium">{script.category}</p>
              </div>
              <div>
                <p className="text-xs font-medium text-muted-foreground">Target OS</p>
                <p className="text-sm font-medium">{script.osTypes.join(', ')}</p>
              </div>
            </div>
            {script.description && (
              <p className="mt-3 text-sm text-muted-foreground">{script.description}</p>
            )}
          </div>

          {/* Parameters */}
          {script.parameters && script.parameters.length > 0 && (
            <div className="space-y-4">
              <h3 className="text-sm font-semibold">Parameters</h3>
              <div className="grid gap-4 sm:grid-cols-2">
                {script.parameters.map(param => (
                  <div key={param.name} className="space-y-1">
                    <label className="text-sm font-medium">
                      {param.name}
                      {param.required && <span className="text-destructive ml-1">*</span>}
                    </label>
                    {param.type === 'boolean' ? (
                      <div className="flex items-center h-10">
                        <input
                          type="checkbox"
                          checked={Boolean(parameters[param.name])}
                          onChange={e => handleParameterChange(param.name, e.target.checked)}
                          className="h-4 w-4 rounded border-gray-300"
                        />
                        <span className="ml-2 text-sm">Enabled</span>
                      </div>
                    ) : param.type === 'select' && param.options ? (
                      <select
                        value={String(parameters[param.name] || '')}
                        onChange={e => handleParameterChange(param.name, e.target.value)}
                        className="h-10 w-full rounded-md border bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                      >
                        <option value="">Select...</option>
                        {param.options.split(',').map(opt => (
                          <option key={opt.trim()} value={opt.trim()}>
                            {opt.trim()}
                          </option>
                        ))}
                      </select>
                    ) : (
                      <input
                        type={param.type === 'number' ? 'number' : 'text'}
                        value={String(parameters[param.name] ?? '')}
                        onChange={e => handleParameterChange(
                          param.name,
                          param.type === 'number' ? Number(e.target.value) : e.target.value
                        )}
                        placeholder={param.defaultValue || ''}
                        className="h-10 w-full rounded-md border bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                      />
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Device Selection */}
          <div className="space-y-4">
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-semibold">Select Devices</h3>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={handleSelectAll}
                  className="text-xs text-primary hover:underline"
                >
                  Select all online
                </button>
                {selectedDeviceIds.size > 0 && (
                  <button
                    type="button"
                    onClick={handleClearSelection}
                    className="text-xs text-muted-foreground hover:underline"
                  >
                    Clear ({selectedDeviceIds.size})
                  </button>
                )}
              </div>
            </div>

            {/* Filters */}
            <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
              <div className="relative flex-1">
                <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                <input
                  type="search"
                  placeholder="Search by hostname..."
                  value={query}
                  onChange={e => setQuery(e.target.value)}
                  className="h-9 w-full rounded-md border bg-background pl-9 pr-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                />
              </div>
              {sites.length > 0 && (
                <select
                  value={siteFilter}
                  onChange={e => setSiteFilter(e.target.value)}
                  className="h-9 rounded-md border bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                >
                  <option value="all">All Sites</option>
                  {sites.map(site => (
                    <option key={site.id} value={site.id}>
                      {site.name}
                    </option>
                  ))}
                </select>
              )}
              <select
                value={statusFilter}
                onChange={e => setStatusFilter(e.target.value)}
                className="h-9 rounded-md border bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
              >
                <option value="all">All Status</option>
                <option value="online">Online</option>
                <option value="offline">Offline</option>
                <option value="maintenance">Maintenance</option>
              </select>
            </div>

            {/* Advanced Filter Toggle */}
            <div>
              <button
                type="button"
                onClick={() => setShowAdvancedFilter(!showAdvancedFilter)}
                className={cn(
                  'inline-flex h-8 items-center gap-2 rounded-md border px-3 text-xs font-medium transition',
                  showAdvancedFilter ? 'border-primary bg-primary/10 text-primary' : 'hover:bg-muted'
                )}
              >
                <Filter className="h-3 w-3" />
                Advanced Filters
                {showAdvancedFilter && advancedFilterIds && (
                  <span className="rounded-full bg-primary/20 px-1.5 py-0.5 text-[10px]">
                    {advancedFilterIds.size} match
                  </span>
                )}
              </button>
              {showAdvancedFilter && (
                <div className="mt-3">
                  <FilterBuilder
                    value={advancedFilter}
                    onChange={setAdvancedFilter}
                    filterFields={DEFAULT_FILTER_FIELDS}
                    showPreview={false}
                  />
                </div>
              )}
            </div>

            {/* Device List */}
            <div className="rounded-md border max-h-60 overflow-y-auto">
              {filteredDevices.length === 0 ? (
                <div className="p-4 text-center text-sm text-muted-foreground">
                  No compatible devices found. This script requires {script.osTypes.join(' or ')}.
                </div>
              ) : (
                <div className="divide-y">
                  {filteredDevices.map(device => (
                    <label
                      key={device.id}
                      className={cn(
                        'flex items-center gap-3 px-4 py-3 cursor-pointer transition',
                        device.status !== 'online' && 'opacity-50',
                        selectedDeviceIds.has(device.id) && 'bg-primary/5'
                      )}
                    >
                      <input
                        type="checkbox"
                        checked={selectedDeviceIds.has(device.id)}
                        onChange={() => handleDeviceToggle(device.id)}
                        disabled={device.status !== 'online'}
                        className="h-4 w-4 rounded border-gray-300"
                      />
                      <div className="flex-1 min-w-0">
                        <p className="text-sm font-medium truncate">{device.hostname}</p>
                        <p className="text-xs text-muted-foreground">{device.siteName}</p>
                      </div>
                      <div className="flex items-center gap-2">
                        <span className="text-xs text-muted-foreground capitalize">{device.os}</span>
                        <span className={cn(
                          'inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium',
                          device.status === 'online' && 'bg-green-500/20 text-green-700',
                          device.status === 'offline' && 'bg-red-500/20 text-red-700',
                          device.status === 'maintenance' && 'bg-yellow-500/20 text-yellow-700'
                        )}>
                          {device.status}
                        </span>
                      </div>
                    </label>
                  ))}
                </div>
              )}
            </div>
          </div>

          {/* Error Message */}
          {errorMessage && (
            <div className="rounded-md border border-destructive/40 bg-destructive/10 px-4 py-3 text-sm text-destructive">
              {errorMessage}
            </div>
          )}

          {/* Confirmation */}
          {showConfirm && executionState === 'idle' && (
            <div className="rounded-md border border-yellow-500/40 bg-yellow-500/10 px-4 py-3">
              <p className="text-sm font-medium text-yellow-700">
                Confirm Execution
              </p>
              <p className="text-sm text-yellow-600 mt-1">
                You are about to execute "{script.name}" on {selectedDeviceIds.size} device(s).
                This action cannot be undone.
              </p>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between border-t px-6 py-4">
          <p className="text-sm text-muted-foreground">
            {selectedDeviceIds.size} device(s) selected
          </p>
          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={handleClose}
              disabled={executionState === 'executing'}
              className="h-10 rounded-md border px-4 text-sm font-medium text-muted-foreground transition hover:text-foreground disabled:opacity-50"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={handleExecute}
              disabled={executionState === 'executing' || executionState === 'success' || selectedDeviceIds.size === 0}
              className={cn(
                'inline-flex h-10 items-center justify-center gap-2 rounded-md px-4 text-sm font-medium transition disabled:cursor-not-allowed disabled:opacity-60',
                executionState === 'success'
                  ? 'bg-green-600 text-white'
                  : showConfirm
                    ? 'bg-yellow-600 text-white hover:bg-yellow-700'
                    : 'bg-primary text-primary-foreground hover:opacity-90'
              )}
            >
              {executionState === 'executing' && (
                <Loader2 className="h-4 w-4 animate-spin" />
              )}
              {executionState === 'success' && (
                <CheckCircle className="h-4 w-4" />
              )}
              {executionState === 'error' && (
                <AlertCircle className="h-4 w-4" />
              )}
              {executionState === 'idle' && !showConfirm && (
                <Play className="h-4 w-4" />
              )}
              {executionState === 'executing'
                ? 'Executing...'
                : executionState === 'success'
                  ? 'Started!'
                  : showConfirm
                    ? 'Confirm Execute'
                    : 'Execute'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
