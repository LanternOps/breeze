import { useState, useEffect } from 'react';
import { ScanSearch, Plus, Trash2 } from 'lucide-react';
import type { FeatureTabProps } from './types';
import { FEATURE_META } from './types';
import { useFeatureLink } from './useFeatureLink';
import FeatureTabShell from './FeatureTabShell';

const DETECTION_CLASSES = [
  { value: 'credential', label: 'Credentials', description: 'API keys, passwords, tokens' },
  { value: 'pci', label: 'PCI', description: 'Credit card numbers, CVVs' },
  { value: 'phi', label: 'PHI', description: 'Protected health information' },
  { value: 'pii', label: 'PII', description: 'SSNs, addresses, phone numbers' },
  { value: 'financial', label: 'Financial', description: 'Bank accounts, routing numbers' },
] as const;

type SensitiveDataSettings = {
  detectionClasses: string[];
  includePaths: string[];
  excludePaths: string[];
  fileTypes: string[];
  maxFileSizeBytes: number;
  workers: number;
  timeoutSeconds: number;
  suppressPatternIds: string[];
  scheduleType: 'manual' | 'interval' | 'cron';
  intervalMinutes?: number;
  cron?: string;
  timezone: string;
};

const defaults: SensitiveDataSettings = {
  detectionClasses: ['credential'],
  includePaths: [],
  excludePaths: [],
  fileTypes: [],
  maxFileSizeBytes: 104857600,
  workers: 4,
  timeoutSeconds: 300,
  suppressPatternIds: [],
  scheduleType: 'manual',
  intervalMinutes: undefined,
  cron: undefined,
  timezone: 'UTC',
};

export default function SensitiveDataTab({ policyId, existingLink, onLinkChanged, linkedPolicyId }: FeatureTabProps) {
  const { save, remove, saving, error, clearError } = useFeatureLink(policyId);
  const [settings, setSettings] = useState<SensitiveDataSettings>(() => ({
    ...defaults,
    ...(existingLink?.inlineSettings as Partial<SensitiveDataSettings> | undefined),
  }));
  const [newIncludePath, setNewIncludePath] = useState('');
  const [newExcludePath, setNewExcludePath] = useState('');
  const [newFileType, setNewFileType] = useState('');
  const [newSuppressId, setNewSuppressId] = useState('');

  useEffect(() => {
    if (existingLink?.inlineSettings) {
      setSettings((prev) => ({ ...prev, ...(existingLink.inlineSettings as Partial<SensitiveDataSettings>) }));
    }
  }, [existingLink]);

  const meta = FEATURE_META.sensitive_data;

  const update = <K extends keyof SensitiveDataSettings>(key: K, value: SensitiveDataSettings[K]) =>
    setSettings((prev) => ({ ...prev, [key]: value }));

  const toggleClass = (cls: string) => {
    const current = settings.detectionClasses;
    if (current.includes(cls)) {
      if (current.length <= 1) return;
      update('detectionClasses', current.filter((c) => c !== cls));
    } else {
      update('detectionClasses', [...current, cls]);
    }
  };

  const addToList = (key: 'includePaths' | 'excludePaths' | 'fileTypes' | 'suppressPatternIds', value: string, setter: (v: string) => void) => {
    const trimmed = value.trim();
    if (!trimmed || settings[key].includes(trimmed)) return;
    update(key, [...settings[key], trimmed]);
    setter('');
  };

  const removeFromList = (key: 'includePaths' | 'excludePaths' | 'fileTypes' | 'suppressPatternIds', value: string) => {
    update(key, settings[key].filter((item) => item !== value));
  };

  const handleSave = async () => {
    clearError();
    const result = await save(existingLink?.id ?? null, {
      featureType: 'sensitive_data',
      featurePolicyId: linkedPolicyId,
      inlineSettings: settings,
    });
    if (result) onLinkChanged(result, 'sensitive_data');
  };

  const handleRemove = async () => {
    if (!existingLink) return;
    const ok = await remove(existingLink.id);
    if (ok) onLinkChanged(null, 'sensitive_data');
  };

  return (
    <FeatureTabShell
      title={meta.label}
      description={meta.description}
      icon={<ScanSearch className="h-5 w-5" />}
      isConfigured={!!existingLink}
      saving={saving}
      error={error}
      onSave={handleSave}
      onRemove={existingLink ? handleRemove : undefined}
    >
      {/* Detection Classes */}
      <div>
        <h3 className="text-sm font-semibold">Detection Classes</h3>
        <p className="text-xs text-muted-foreground">Select which types of sensitive data to scan for.</p>
        <div className="mt-3 grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
          {DETECTION_CLASSES.map((cls) => (
            <button
              key={cls.value}
              type="button"
              onClick={() => toggleClass(cls.value)}
              className={`flex flex-col items-start rounded-md border px-4 py-3 text-left transition ${
                settings.detectionClasses.includes(cls.value)
                  ? 'border-primary bg-primary/5'
                  : 'hover:bg-muted/50'
              }`}
            >
              <span className="text-sm font-medium">{cls.label}</span>
              <span className="text-xs text-muted-foreground">{cls.description}</span>
            </button>
          ))}
        </div>
      </div>

      {/* Scan Scope */}
      <div className="mt-6 grid gap-6 lg:grid-cols-2">
        <ListEditor
          label="Include Paths"
          description="Directories to include in scan. Empty means scan all."
          items={settings.includePaths}
          value={newIncludePath}
          onChange={setNewIncludePath}
          onAdd={() => addToList('includePaths', newIncludePath, setNewIncludePath)}
          onRemove={(v) => removeFromList('includePaths', v)}
          placeholder="/home, /var/data"
        />
        <ListEditor
          label="Exclude Paths"
          description="Directories to skip during scan."
          items={settings.excludePaths}
          value={newExcludePath}
          onChange={setNewExcludePath}
          onAdd={() => addToList('excludePaths', newExcludePath, setNewExcludePath)}
          onRemove={(v) => removeFromList('excludePaths', v)}
          placeholder="/tmp, /proc"
        />
      </div>

      <div className="mt-6 grid gap-6 lg:grid-cols-2">
        <ListEditor
          label="File Types"
          description="File extensions to scan. Empty means all types."
          items={settings.fileTypes}
          value={newFileType}
          onChange={setNewFileType}
          onAdd={() => addToList('fileTypes', newFileType, setNewFileType)}
          onRemove={(v) => removeFromList('fileTypes', v)}
          placeholder=".txt, .csv, .log"
        />
        <div>
          <label className="text-sm font-semibold">Max File Size</label>
          <p className="text-xs text-muted-foreground">Maximum file size to scan (MB).</p>
          <input
            type="number"
            min={1}
            max={1024}
            value={Math.round(settings.maxFileSizeBytes / (1024 * 1024))}
            onChange={(e) => update('maxFileSizeBytes', Number(e.target.value) * 1024 * 1024)}
            className="mt-2 h-10 w-full rounded-md border bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring sm:w-32"
          />
        </div>
      </div>

      {/* Performance */}
      <div className="mt-6">
        <h3 className="text-sm font-semibold">Performance</h3>
        <div className="mt-3 grid gap-4 sm:grid-cols-2">
          <div>
            <label className="text-xs uppercase text-muted-foreground">Workers (1-32)</label>
            <input
              type="range"
              min={1}
              max={32}
              value={settings.workers}
              onChange={(e) => update('workers', Number(e.target.value))}
              className="mt-2 w-full"
            />
            <span className="text-sm text-muted-foreground">{settings.workers} workers</span>
          </div>
          <div>
            <label className="text-xs uppercase text-muted-foreground">Timeout (5-1800s)</label>
            <input
              type="range"
              min={5}
              max={1800}
              step={5}
              value={settings.timeoutSeconds}
              onChange={(e) => update('timeoutSeconds', Number(e.target.value))}
              className="mt-2 w-full"
            />
            <span className="text-sm text-muted-foreground">{settings.timeoutSeconds}s</span>
          </div>
        </div>
      </div>

      {/* Suppressions */}
      <div className="mt-6">
        <ListEditor
          label="Suppress Pattern IDs"
          description="Pattern IDs to suppress from results."
          items={settings.suppressPatternIds}
          value={newSuppressId}
          onChange={setNewSuppressId}
          onAdd={() => addToList('suppressPatternIds', newSuppressId, setNewSuppressId)}
          onRemove={(v) => removeFromList('suppressPatternIds', v)}
          placeholder="pattern-id"
        />
      </div>

      {/* Schedule */}
      <div className="mt-6">
        <h3 className="text-sm font-semibold">Schedule</h3>
        <div className="mt-3 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <div>
            <label className="text-xs uppercase text-muted-foreground">Type</label>
            <select
              value={settings.scheduleType}
              onChange={(e) => update('scheduleType', e.target.value as SensitiveDataSettings['scheduleType'])}
              className="mt-1 h-10 w-full rounded-md border bg-background px-3 text-sm"
            >
              <option value="manual">Manual</option>
              <option value="interval">Interval</option>
              <option value="cron">Cron</option>
            </select>
          </div>
          {settings.scheduleType === 'interval' && (
            <div>
              <label className="text-xs uppercase text-muted-foreground">Interval (minutes)</label>
              <input
                type="number"
                min={5}
                max={10080}
                value={settings.intervalMinutes ?? 60}
                onChange={(e) => update('intervalMinutes', Number(e.target.value))}
                className="mt-1 h-10 w-full rounded-md border bg-background px-3 text-sm"
              />
            </div>
          )}
          {settings.scheduleType === 'cron' && (
            <div>
              <label className="text-xs uppercase text-muted-foreground">Cron Expression</label>
              <input
                value={settings.cron ?? ''}
                onChange={(e) => update('cron', e.target.value)}
                placeholder="0 2 * * *"
                className="mt-1 h-10 w-full rounded-md border bg-background px-3 text-sm"
              />
            </div>
          )}
          {settings.scheduleType !== 'manual' && (
            <div>
              <label className="text-xs uppercase text-muted-foreground">Timezone</label>
              <input
                value={settings.timezone}
                onChange={(e) => update('timezone', e.target.value)}
                placeholder="UTC"
                className="mt-1 h-10 w-full rounded-md border bg-background px-3 text-sm"
              />
            </div>
          )}
        </div>
      </div>
    </FeatureTabShell>
  );
}

function ListEditor({ label, description, items, value, onChange, onAdd, onRemove, placeholder }: {
  label: string;
  description: string;
  items: string[];
  value: string;
  onChange: (v: string) => void;
  onAdd: () => void;
  onRemove: (v: string) => void;
  placeholder: string;
}) {
  return (
    <div>
      <h3 className="text-sm font-semibold">{label}</h3>
      <p className="text-xs text-muted-foreground">{description}</p>
      <div className="mt-2 flex gap-2">
        <input
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && (e.preventDefault(), onAdd())}
          placeholder={placeholder}
          className="h-10 flex-1 rounded-md border bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
        />
        <button type="button" onClick={onAdd} className="inline-flex items-center gap-1 rounded-md border px-3 py-2 text-sm font-medium hover:bg-muted">
          <Plus className="h-4 w-4" /> Add
        </button>
      </div>
      <div className="mt-2 space-y-1">
        {items.map((item) => (
          <div key={item} className="flex items-center justify-between rounded-md border bg-muted/30 px-3 py-1.5 text-sm">
            <span className="truncate">{item}</span>
            <button type="button" onClick={() => onRemove(item)} className="rounded-md border p-1 hover:bg-muted">
              <Trash2 className="h-3.5 w-3.5" />
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}
