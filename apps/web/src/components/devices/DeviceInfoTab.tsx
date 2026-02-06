import { useCallback, useEffect, useState } from 'react';
import { Monitor, Cpu, HardDrive, MemoryStick, Shield, Tag, Info, ListChecks, Pencil, Check, X } from 'lucide-react';
import { fetchWithAuth } from '../../stores/auth';

type DeviceInfoTabProps = {
  deviceId: string;
};

type CustomFieldDef = {
  id: string;
  name: string;
  fieldKey: string;
  type: 'text' | 'number' | 'boolean' | 'dropdown' | 'date';
  options: { choices?: Array<{ label: string; value: string }>; min?: number; max?: number; maxLength?: number; pattern?: string } | null;
  required: boolean;
  defaultValue: unknown;
  deviceTypes: string[] | null;
};

type DeviceInfo = {
  hostname?: string | null;
  displayName?: string | null;
  osType?: string | null;
  osVersion?: string | null;
  osBuild?: string | null;
  architecture?: string | null;
  agentVersion?: string | null;
  status?: string | null;
  lastSeenAt?: string | null;
  enrolledAt?: string | null;
  tags?: string[];
  customFields?: Record<string, unknown>;
  hardware?: {
    serialNumber?: string | null;
    manufacturer?: string | null;
    model?: string | null;
    biosVersion?: string | null;
    gpuModel?: string | null;
    cpuModel?: string | null;
    cpuCores?: number | null;
    cpuThreads?: number | null;
    ramTotalMb?: number | null;
    diskTotalGb?: number | null;
  } | null;
};

function formatRam(valueMb: number | null | undefined): string {
  if (valueMb === null || valueMb === undefined) return '—';
  const gb = valueMb / 1024;
  return gb >= 1 ? `${gb.toFixed(1)} GB` : `${valueMb} MB`;
}

function formatDisk(valueGb: number | null | undefined): string {
  if (valueGb === null || valueGb === undefined) return '—';
  if (valueGb >= 1024) return `${(valueGb / 1024).toFixed(1)} TB`;
  return `${valueGb.toFixed(1)} GB`;
}

function formatDate(dateString: string | null | undefined): string {
  if (!dateString) return '—';
  const date = new Date(dateString);
  if (Number.isNaN(date.getTime())) return dateString;
  return date.toLocaleString([], {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function InfoRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between py-2">
      <dt className="text-sm text-muted-foreground">{label}</dt>
      <dd className="text-sm font-medium text-right">{value || '—'}</dd>
    </div>
  );
}

function Section({ title, icon, children }: { title: string; icon: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="rounded-lg border bg-card p-6 shadow-sm">
      <div className="flex items-center gap-2 mb-4">
        {icon}
        <h3 className="font-semibold">{title}</h3>
      </div>
      <dl className="divide-y">{children}</dl>
    </div>
  );
}

const statusColors: Record<string, string> = {
  online: 'bg-green-500/20 text-green-700 border-green-500/40',
  offline: 'bg-red-500/20 text-red-700 border-red-500/40',
  maintenance: 'bg-yellow-500/20 text-yellow-700 border-yellow-500/40',
};

export default function DeviceInfoTab({ deviceId }: DeviceInfoTabProps) {
  const [info, setInfo] = useState<DeviceInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const [fieldDefs, setFieldDefs] = useState<CustomFieldDef[]>([]);
  const [editingField, setEditingField] = useState<string | null>(null);
  const [editValue, setEditValue] = useState<unknown>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  const fetchInfo = useCallback(async () => {
    setLoading(true);
    setError(undefined);
    try {
      const response = await fetchWithAuth(`/devices/${deviceId}`);
      if (!response.ok) {
        let detail = `Failed to fetch device details (HTTP ${response.status})`;
        try {
          const body = await response.json();
          if (body.error) detail = body.error;
        } catch { /* failed to parse error details, using HTTP status */ }
        throw new Error(detail);
      }
      const data = await response.json();
      setInfo(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to fetch device details');
    } finally {
      setLoading(false);
    }
  }, [deviceId]);

  useEffect(() => {
    fetchInfo();
  }, [fetchInfo]);

  useEffect(() => {
    fetchWithAuth('/custom-fields')
      .then(r => {
        if (!r.ok) {
          console.error(`Failed to fetch custom field definitions (HTTP ${r.status})`);
          return null;
        }
        return r.json();
      })
      .then(data => {
        if (data) setFieldDefs(data.data ?? data ?? []);
      })
      .catch(err => {
        console.error('Failed to load custom field definitions:', err);
      });
  }, []);

  // Filter field definitions to those applicable to this device's OS type
  const applicableFields = fieldDefs.filter(def => {
    if (!def.deviceTypes || def.deviceTypes.length === 0) return true;
    return info?.osType ? def.deviceTypes.includes(info.osType) : true;
  });

  const handleSaveField = async (fieldKey: string) => {
    setSaving(true);
    setSaveError(null);
    try {
      const response = await fetchWithAuth(`/devices/${deviceId}`, {
        method: 'PATCH',
        body: JSON.stringify({ customFields: { [fieldKey]: editValue } }),
      });
      if (response.ok) {
        setInfo(prev => prev ? {
          ...prev,
          customFields: { ...(prev.customFields ?? {}), [fieldKey]: editValue }
        } : prev);
        setEditingField(null);
      } else {
        let detail = `Failed to save (HTTP ${response.status})`;
        try {
          const body = await response.json();
          if (body.error) detail = body.error;
        } catch { /* non-JSON response */ }
        setSaveError(detail);
      }
    } catch (err) {
      console.error(`Failed to save custom field "${fieldKey}":`, err);
      setSaveError('Network error. Please check your connection and try again.');
    } finally {
      setSaving(false);
    }
  };

  const renderFieldValue = (def: CustomFieldDef, value: unknown): string => {
    if (value === null || value === undefined || value === '') return '—';
    if (def.type === 'boolean') return value ? 'Yes' : 'No';
    if (def.type === 'dropdown' && def.options?.choices) {
      const choice = def.options.choices.find(c => c.value === value);
      return choice?.label ?? String(value);
    }
    if (def.type === 'date' && typeof value === 'string') return formatDate(value);
    return String(value);
  };

  const renderFieldEditor = (def: CustomFieldDef) => {
    const inputClass = 'h-8 w-full rounded-md border bg-background px-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring';
    switch (def.type) {
      case 'text':
        return (
          <input
            type="text"
            value={String(editValue ?? '')}
            onChange={e => setEditValue(e.target.value)}
            maxLength={def.options?.maxLength}
            className={inputClass}
            autoFocus
          />
        );
      case 'number':
        return (
          <input
            type="number"
            value={editValue === null || editValue === undefined ? '' : String(editValue)}
            onChange={e => setEditValue(e.target.value ? Number(e.target.value) : null)}
            min={def.options?.min}
            max={def.options?.max}
            className={inputClass}
            autoFocus
          />
        );
      case 'boolean':
        return (
          <button
            type="button"
            onClick={() => setEditValue(!editValue)}
            className={`inline-flex h-8 items-center rounded-full border px-3 text-sm transition ${
              editValue ? 'border-primary bg-primary/10 text-primary' : 'bg-muted text-muted-foreground'
            }`}
          >
            {editValue ? 'Yes' : 'No'}
          </button>
        );
      case 'dropdown':
        return (
          <select
            value={String(editValue ?? '')}
            onChange={e => setEditValue(e.target.value)}
            className={inputClass}
            autoFocus
          >
            <option value="">Select...</option>
            {def.options?.choices?.map(c => (
              <option key={c.value} value={c.value}>{c.label}</option>
            ))}
          </select>
        );
      case 'date':
        return (
          <input
            type="date"
            value={String(editValue ?? '')}
            onChange={e => setEditValue(e.target.value)}
            className={inputClass}
            autoFocus
          />
        );
      default:
        return null;
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center rounded-lg border bg-card py-12 shadow-sm">
        <div className="text-center">
          <div className="mx-auto h-8 w-8 animate-spin rounded-full border-4 border-primary border-t-transparent" />
          <p className="mt-3 text-sm text-muted-foreground">Loading device details...</p>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="rounded-lg border border-destructive/40 bg-destructive/10 p-6 text-center">
        <p className="text-sm text-destructive">{error}</p>
        <button
          type="button"
          onClick={fetchInfo}
          className="mt-4 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:opacity-90"
        >
          Retry
        </button>
      </div>
    );
  }

  const hw = info?.hardware;
  const status = info?.status ?? 'offline';
  const tags = info?.tags ?? [];

  return (
    <div className="grid gap-6 lg:grid-cols-2">
      <Section title="System" icon={<Monitor className="h-4 w-4 text-muted-foreground" />}>
        <InfoRow label="Hostname" value={info?.hostname ?? '—'} />
        <InfoRow label="Display Name" value={info?.displayName ?? '—'} />
        <InfoRow label="Serial Number" value={hw?.serialNumber ?? '—'} />
        <InfoRow label="Manufacturer" value={hw?.manufacturer ?? '—'} />
        <InfoRow label="Model" value={hw?.model ?? '—'} />
      </Section>

      <Section title="Operating System" icon={<Info className="h-4 w-4 text-muted-foreground" />}>
        <InfoRow label="OS Type" value={info?.osType ?? '—'} />
        <InfoRow label="OS Version" value={info?.osVersion ?? '—'} />
        <InfoRow label="OS Build" value={info?.osBuild ?? '—'} />
        <InfoRow label="Architecture" value={info?.architecture ?? '—'} />
      </Section>

      <Section title="Hardware Summary" icon={<Cpu className="h-4 w-4 text-muted-foreground" />}>
        <InfoRow label="CPU Model" value={hw?.cpuModel ?? '—'} />
        <InfoRow label="Cores / Threads" value={
          hw?.cpuCores
            ? `${hw.cpuCores} cores${hw.cpuThreads ? ` / ${hw.cpuThreads} threads` : ''}`
            : '—'
        } />
        <InfoRow label="RAM Total" value={formatRam(hw?.ramTotalMb)} />
        <InfoRow label="Disk Total" value={formatDisk(hw?.diskTotalGb)} />
        <InfoRow label="GPU" value={hw?.gpuModel ?? '—'} />
        <InfoRow label="BIOS Version" value={hw?.biosVersion ?? '—'} />
      </Section>

      <div className="space-y-6">
        <Section title="Agent" icon={<Shield className="h-4 w-4 text-muted-foreground" />}>
          <InfoRow label="Agent Version" value={info?.agentVersion ?? '—'} />
          <div className="flex justify-between py-2">
            <dt className="text-sm text-muted-foreground">Status</dt>
            <dd>
              <span className={`inline-flex items-center rounded-full border px-2.5 py-1 text-xs font-medium ${statusColors[status] ?? 'bg-muted/40 text-muted-foreground border-muted'}`}>
                {status.charAt(0).toUpperCase() + status.slice(1)}
              </span>
            </dd>
          </div>
          <InfoRow label="Last Seen" value={formatDate(info?.lastSeenAt)} />
          <InfoRow label="Enrolled" value={formatDate(info?.enrolledAt)} />
        </Section>

        {tags.length > 0 && (
          <div className="rounded-lg border bg-card p-6 shadow-sm">
            <div className="flex items-center gap-2 mb-4">
              <Tag className="h-4 w-4 text-muted-foreground" />
              <h3 className="font-semibold">Tags</h3>
            </div>
            <div className="flex flex-wrap gap-2">
              {tags.map(tag => (
                <span
                  key={tag}
                  className="inline-flex items-center rounded-full border bg-muted/40 px-3 py-1 text-xs font-medium text-muted-foreground"
                >
                  {tag}
                </span>
              ))}
            </div>
          </div>
        )}
      </div>

      {applicableFields.length > 0 && (
        <div className="rounded-lg border bg-card p-6 shadow-sm lg:col-span-2">
          <div className="flex items-center gap-2 mb-4">
            <ListChecks className="h-4 w-4 text-muted-foreground" />
            <h3 className="font-semibold">Custom Fields</h3>
          </div>
          {saveError && (
            <div className="mb-4 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
              {saveError}
            </div>
          )}
          <dl className="divide-y">
            {applicableFields.map(def => {
              const currentValue = info?.customFields?.[def.fieldKey] ?? def.defaultValue ?? null;
              const isEditing = editingField === def.fieldKey;

              return (
                <div key={def.fieldKey} className="flex items-center justify-between gap-4 py-2">
                  <dt className="text-sm text-muted-foreground shrink-0">
                    {def.name}
                    {def.required && <span className="ml-1 text-amber-500">*</span>}
                  </dt>
                  <dd className="text-sm font-medium text-right flex items-center gap-2">
                    {isEditing ? (
                      <>
                        <div className="w-48">{renderFieldEditor(def)}</div>
                        <button
                          type="button"
                          onClick={() => handleSaveField(def.fieldKey)}
                          disabled={saving}
                          className="inline-flex h-7 w-7 items-center justify-center rounded text-primary hover:bg-primary/10"
                          title="Save"
                        >
                          <Check className="h-4 w-4" />
                        </button>
                        <button
                          type="button"
                          onClick={() => setEditingField(null)}
                          className="inline-flex h-7 w-7 items-center justify-center rounded text-muted-foreground hover:bg-muted"
                          title="Cancel"
                        >
                          <X className="h-4 w-4" />
                        </button>
                      </>
                    ) : (
                      <>
                        <span>{renderFieldValue(def, currentValue)}</span>
                        <button
                          type="button"
                          onClick={() => {
                            setEditingField(def.fieldKey);
                            setEditValue(currentValue);
                            setSaveError(null);
                          }}
                          className="inline-flex h-7 w-7 items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-foreground"
                          title="Edit"
                        >
                          <Pencil className="h-3.5 w-3.5" />
                        </button>
                      </>
                    )}
                  </dd>
                </div>
              );
            })}
          </dl>
        </div>
      )}
    </div>
  );
}
