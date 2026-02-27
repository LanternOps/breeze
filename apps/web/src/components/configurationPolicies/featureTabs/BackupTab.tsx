import { useState, useEffect, useCallback } from 'react';
import {
  HardDrive,
  Loader2,
  Plus,
  Trash2,
  CheckCircle2,
  XCircle,
  Cloud,
  FolderOpen,
  Server,
  Clock,
  Shield,
} from 'lucide-react';
import type { FeatureTabProps } from './types';
import { FEATURE_META } from './types';
import { useFeatureLink } from './useFeatureLink';
import FeatureTabShell from './FeatureTabShell';
import { fetchWithAuth } from '../../../stores/auth';

// ── Types ──────────────────────────────────────────────────────────────────────

type ScheduleFrequency = 'daily' | 'weekly' | 'monthly';
type RetentionPreset = 'standard' | 'extended' | 'compliance' | 'custom';
type BackupProvider = 's3' | 'local';

type BackupScheduleSettings = {
  scheduleFrequency: ScheduleFrequency;
  scheduleTime: string;
  scheduleDayOfWeek: number;
  scheduleDayOfMonth: number;
  retentionPreset: RetentionPreset;
  retentionDays: number;
  retentionVersions: number;
  compression: boolean;
  encryption: boolean;
  paths: string[];
  excludePatterns: string[];
  notifyOnFailure: boolean;
  notifyOnSuccess: boolean;
  notifyOnMissed: boolean;
  s3Prefix: string;
};

type BackupConfig = {
  id: string;
  name: string;
  provider: string;
  enabled: boolean;
  details: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
};

// ── Constants ──────────────────────────────────────────────────────────────────

const scheduleDefaults: BackupScheduleSettings = {
  scheduleFrequency: 'daily',
  scheduleTime: '03:00',
  scheduleDayOfWeek: 0,
  scheduleDayOfMonth: 1,
  retentionPreset: 'standard',
  retentionDays: 30,
  retentionVersions: 5,
  compression: true,
  encryption: true,
  paths: [],
  excludePatterns: [],
  notifyOnFailure: true,
  notifyOnSuccess: false,
  notifyOnMissed: true,
  s3Prefix: '',
};

const scheduleOptions: { value: ScheduleFrequency; label: string }[] = [
  { value: 'daily', label: 'Daily' },
  { value: 'weekly', label: 'Weekly' },
  { value: 'monthly', label: 'Monthly' },
];

const retentionPresets: { value: RetentionPreset; label: string; days: number; versions: number }[] = [
  { value: 'standard', label: 'Standard', days: 30, versions: 5 },
  { value: 'extended', label: 'Extended', days: 90, versions: 10 },
  { value: 'compliance', label: 'Compliance', days: 365, versions: 20 },
  { value: 'custom', label: 'Custom', days: 0, versions: 0 },
];

const dayOfWeekOptions = [
  { value: 0, label: 'Sunday' },
  { value: 1, label: 'Monday' },
  { value: 2, label: 'Tuesday' },
  { value: 3, label: 'Wednesday' },
  { value: 4, label: 'Thursday' },
  { value: 5, label: 'Friday' },
  { value: 6, label: 'Saturday' },
];

const providerOptions: { value: BackupProvider; label: string; description: string; icon: typeof Cloud }[] = [
  { value: 's3', label: 'Amazon S3 / S3-Compatible', description: 'AWS S3, MinIO, Wasabi, Backblaze B2', icon: Cloud },
  { value: 'local', label: 'Local / Network Path', description: 'Local disk, NAS, or UNC share', icon: Server },
];

const providerLabels: Record<string, string> = {
  s3: 'Amazon S3',
  local: 'Local / NAS',
};

const commonExclusions = [
  { pattern: '*.tmp', label: 'Temp files' },
  { pattern: '*.log', label: 'Log files' },
  { pattern: 'node_modules/**', label: 'Node modules' },
  { pattern: '$RECYCLE.BIN/**', label: 'Recycle bin' },
  { pattern: '*.swp', label: 'Swap files' },
  { pattern: 'Thumbs.db', label: 'Thumbs.db' },
];

// ── Subcomponents ──────────────────────────────────────────────────────────────

function ToggleRow({ label, description, checked, onChange }: {
  label: string; description: string; checked: boolean; onChange: (v: boolean) => void;
}) {
  return (
    <div className="flex items-center justify-between rounded-md border bg-background px-4 py-3">
      <div>
        <p className="text-sm font-medium">{label}</p>
        <p className="text-xs text-muted-foreground">{description}</p>
      </div>
      <button
        type="button"
        onClick={() => onChange(!checked)}
        className={`relative inline-flex h-6 w-11 items-center rounded-full border transition ${checked ? 'bg-emerald-500/80' : 'bg-muted'}`}
      >
        <span className={`inline-block h-5 w-5 rounded-full bg-white transition ${checked ? 'translate-x-5' : 'translate-x-1'}`} />
      </button>
    </div>
  );
}

function PathList({ items, onAdd, onRemove, placeholder, label }: {
  items: string[];
  onAdd: (value: string) => void;
  onRemove: (value: string) => void;
  placeholder: string;
  label: string;
}) {
  const [input, setInput] = useState('');
  const handleAdd = () => {
    const trimmed = input.trim();
    if (!trimmed || items.includes(trimmed)) return;
    onAdd(trimmed);
    setInput('');
  };
  return (
    <div>
      <div className="flex gap-2">
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && (e.preventDefault(), handleAdd())}
          placeholder={placeholder}
          className="h-9 flex-1 rounded-md border bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
        />
        <button
          type="button"
          onClick={handleAdd}
          className="inline-flex items-center gap-1 rounded-md border px-3 py-1.5 text-xs font-medium hover:bg-muted"
        >
          <Plus className="h-3.5 w-3.5" /> Add
        </button>
      </div>
      {items.length > 0 && (
        <div className="mt-2 space-y-1.5">
          {items.map((item) => (
            <div key={item} className="flex items-center justify-between rounded-md border bg-muted/30 px-3 py-1.5 text-sm">
              <span className="truncate font-mono text-xs">{item}</span>
              <button
                type="button"
                onClick={() => onRemove(item)}
                className="ml-2 rounded p-1 hover:bg-muted"
              >
                <Trash2 className="h-3.5 w-3.5 text-muted-foreground" />
              </button>
            </div>
          ))}
        </div>
      )}
      {items.length === 0 && (
        <p className="mt-2 text-xs text-muted-foreground">No {label} configured.</p>
      )}
    </div>
  );
}

function scheduleDescription(s: BackupScheduleSettings): string {
  const time = s.scheduleTime || '03:00';
  const dayName = dayOfWeekOptions.find((d) => d.value === s.scheduleDayOfWeek)?.label ?? 'Sunday';
  switch (s.scheduleFrequency) {
    case 'daily':
      return `Every day at ${time} UTC`;
    case 'weekly':
      return `Every ${dayName} at ${time} UTC`;
    case 'monthly':
      return `Day ${s.scheduleDayOfMonth} of each month at ${time} UTC`;
    default:
      return '';
  }
}

// ── Main Component ─────────────────────────────────────────────────────────────

export default function BackupTab({ policyId, existingLink, onLinkChanged, linkedPolicyId, parentLink }: FeatureTabProps) {
  const { save, remove, saving, error, clearError } = useFeatureLink(policyId);
  const isInherited = !!parentLink && !existingLink;
  const effectiveLink = existingLink ?? parentLink;
  const meta = FEATURE_META.backup;

  // Config selection / creation
  const [configs, setConfigs] = useState<BackupConfig[]>([]);
  const [configsLoading, setConfigsLoading] = useState(false);
  const [selectedConfigId, setSelectedConfigId] = useState<string>(
    () => effectiveLink?.featurePolicyId ?? '',
  );
  const [mode, setMode] = useState<'select' | 'create'>('select');

  // New config fields
  const [newConfigName, setNewConfigName] = useState('');
  const [newProvider, setNewProvider] = useState<BackupProvider>('s3');
  const [s3Bucket, setS3Bucket] = useState('');
  const [s3Region, setS3Region] = useState('us-east-1');
  const [s3AccessKey, setS3AccessKey] = useState('');
  const [s3SecretKey, setS3SecretKey] = useState('');
  const [s3Endpoint, setS3Endpoint] = useState('');
  const [localPath, setLocalPath] = useState('/var/backups/breeze');
  const [configSaving, setConfigSaving] = useState(false);
  const [configError, setConfigError] = useState<string>();

  // Connection test
  const [testStatus, setTestStatus] = useState<'idle' | 'testing' | 'success' | 'failed'>('idle');

  // Schedule/retention inline settings
  const [settings, setSettings] = useState<BackupScheduleSettings>(() => ({
    ...scheduleDefaults,
    ...(effectiveLink?.inlineSettings as Partial<BackupScheduleSettings> | undefined),
  }));

  // ── Fetch existing configs ─────────────────────────────────────────────────

  const fetchConfigs = useCallback(async () => {
    if (!meta.fetchUrl) return;
    setConfigsLoading(true);
    try {
      const response = await fetchWithAuth(meta.fetchUrl);
      if (response.ok) {
        const payload = await response.json();
        setConfigs(Array.isArray(payload.data) ? payload.data : Array.isArray(payload) ? payload : []);
      }
    } catch {
      // Silently fail
    } finally {
      setConfigsLoading(false);
    }
  }, [meta.fetchUrl]);

  useEffect(() => { fetchConfigs(); }, [fetchConfigs]);

  useEffect(() => {
    const link = existingLink ?? parentLink;
    if (link?.featurePolicyId) setSelectedConfigId(link.featurePolicyId);
    if (link?.inlineSettings) {
      setSettings((prev) => ({ ...prev, ...(link.inlineSettings as Partial<BackupScheduleSettings>) }));
    }
  }, [existingLink, parentLink]);

  useEffect(() => {
    if (!configsLoading && configs.length === 0 && !selectedConfigId) {
      setMode('create');
    }
  }, [configsLoading, configs.length, selectedConfigId]);

  // Reset test status when config changes
  useEffect(() => { setTestStatus('idle'); }, [selectedConfigId]);

  // ── Helpers ────────────────────────────────────────────────────────────────

  const update = <K extends keyof BackupScheduleSettings>(key: K, value: BackupScheduleSettings[K]) =>
    setSettings((prev) => ({ ...prev, [key]: value }));

  const handleRetentionPreset = (preset: RetentionPreset) => {
    update('retentionPreset', preset);
    const p = retentionPresets.find((r) => r.value === preset);
    if (p && preset !== 'custom') {
      update('retentionDays', p.days);
      update('retentionVersions', p.versions);
    }
  };

  // ── Test connection ────────────────────────────────────────────────────────

  const handleTestConnection = async () => {
    if (!selectedConfigId) return;
    setTestStatus('testing');
    try {
      const response = await fetchWithAuth(`/backup/configs/${selectedConfigId}/test`, {
        method: 'POST',
      });
      const data = await response.json();
      setTestStatus(data.status === 'success' ? 'success' : 'failed');
    } catch {
      setTestStatus('failed');
    }
  };

  // ── Create config via API ──────────────────────────────────────────────────

  const createConfig = async (): Promise<string | null> => {
    setConfigError(undefined);
    setConfigSaving(true);
    try {
      const details: Record<string, unknown> = newProvider === 's3'
        ? {
            bucket: s3Bucket,
            region: s3Region,
            accessKey: s3AccessKey,
            secretKey: s3SecretKey,
            ...(s3Endpoint ? { endpoint: s3Endpoint } : {}),
            ...(settings.s3Prefix ? { prefix: settings.s3Prefix } : {}),
          }
        : { path: localPath };

      const response = await fetchWithAuth('/backup/configs', {
        method: 'POST',
        body: JSON.stringify({
          name: newConfigName,
          provider: newProvider,
          enabled: true,
          details,
        }),
      });

      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        throw new Error(data.error || 'Failed to create backup config');
      }

      const created = await response.json();
      const cfg = created.data ?? created;
      setConfigs((prev) => [...prev, cfg]);
      setSelectedConfigId(cfg.id);
      setMode('select');
      return cfg.id;
    } catch (err) {
      setConfigError(err instanceof Error ? err.message : 'An error occurred');
      return null;
    } finally {
      setConfigSaving(false);
    }
  };

  // ── Save feature link ──────────────────────────────────────────────────────

  const handleSave = async () => {
    clearError();
    setConfigError(undefined);

    let configId = selectedConfigId;

    if (mode === 'create') {
      if (!newConfigName.trim()) { setConfigError('Config name is required'); return; }
      if (newProvider === 's3' && !s3Bucket.trim()) { setConfigError('S3 bucket name is required'); return; }
      if (newProvider === 'local' && !localPath.trim()) { setConfigError('Backup path is required'); return; }
      const created = await createConfig();
      if (!created) return;
      configId = created;
    }

    if (!configId) { setConfigError('Please select or create a backup configuration'); return; }

    const result = await save(existingLink?.id ?? null, {
      featureType: 'backup',
      featurePolicyId: configId,
      inlineSettings: settings,
    });
    if (result) onLinkChanged(result, 'backup');
  };

  const handleRemove = async () => {
    if (!existingLink) return;
    const ok = await remove(existingLink.id);
    if (ok) onLinkChanged(null, 'backup');
  };

  const handleOverride = async () => {
    clearError();
    const result = await save(null, {
      featureType: 'backup',
      featurePolicyId: selectedConfigId || null,
      inlineSettings: settings,
    });
    if (result) onLinkChanged(result, 'backup');
  };

  const handleRevert = async () => {
    if (!existingLink) return;
    const ok = await remove(existingLink.id);
    if (ok) onLinkChanged(null, 'backup');
  };

  const selectedConfig = configs.find((c) => c.id === selectedConfigId);
  const isSaving = saving || configSaving;
  const combinedError = configError || error;
  const retentionInfo = retentionPresets.find((p) => p.value === settings.retentionPreset);

  return (
    <FeatureTabShell
      title={meta.label}
      description={meta.description}
      icon={<HardDrive className="h-5 w-5" />}
      isConfigured={!!existingLink || isInherited}
      saving={isSaving}
      error={combinedError}
      onSave={handleSave}
      onRemove={existingLink && !linkedPolicyId ? handleRemove : undefined}
      isInherited={isInherited}
      onOverride={isInherited ? handleOverride : undefined}
      onRevert={!isInherited && !!linkedPolicyId && !!existingLink ? handleRevert : undefined}
    >
      {/* ══════════════════════════════════════════════════════════════════════
          SECTION 1: Storage Configuration
          ══════════════════════════════════════════════════════════════════════ */}
      <div>
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-semibold">Storage Configuration</h3>
          {configs.length > 0 && (
            <button
              type="button"
              onClick={() => setMode(mode === 'create' ? 'select' : 'create')}
              className="inline-flex items-center gap-1.5 text-xs text-primary hover:underline"
            >
              {mode === 'create' ? 'Use existing config' : (
                <><Plus className="h-3.5 w-3.5" /> Create new</>
              )}
            </button>
          )}
        </div>

        {mode === 'select' ? (
          <div className="mt-2">
            {configsLoading ? (
              <div className="flex items-center gap-2 text-sm text-muted-foreground">
                <Loader2 className="h-4 w-4 animate-spin" /> Loading backup configs...
              </div>
            ) : configs.length === 0 ? (
              <div className="rounded-md border border-dashed p-4 text-center text-sm text-muted-foreground">
                No backup configurations yet.{' '}
                <button type="button" onClick={() => setMode('create')} className="text-primary underline underline-offset-2">
                  Create one now
                </button>
              </div>
            ) : (
              <>
                <select
                  value={selectedConfigId}
                  onChange={(e) => setSelectedConfigId(e.target.value)}
                  className="h-10 w-full rounded-md border bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                >
                  <option value="">Select a backup config...</option>
                  {configs.map((cfg) => (
                    <option key={cfg.id} value={cfg.id}>
                      {cfg.name} ({providerLabels[cfg.provider] ?? cfg.provider})
                      {!cfg.enabled ? ' [disabled]' : ''}
                    </option>
                  ))}
                </select>

                {/* Config summary card */}
                {selectedConfig && (
                  <div className="mt-3 rounded-md border bg-muted/20 p-4">
                    <div className="flex items-start justify-between">
                      <div className="space-y-1.5">
                        <div className="flex items-center gap-2">
                          {selectedConfig.provider === 's3'
                            ? <Cloud className="h-4 w-4 text-blue-500" />
                            : <Server className="h-4 w-4 text-slate-500" />
                          }
                          <span className="text-sm font-medium">
                            {providerLabels[selectedConfig.provider] ?? selectedConfig.provider}
                          </span>
                          <span className={`rounded-full px-2 py-0.5 text-[10px] font-semibold ${
                            selectedConfig.enabled
                              ? 'bg-emerald-500/15 text-emerald-700'
                              : 'bg-yellow-500/15 text-yellow-700'
                          }`}>
                            {selectedConfig.enabled ? 'Active' : 'Disabled'}
                          </span>
                        </div>
                        {/* Show provider-specific details */}
                        <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
                          {selectedConfig.provider === 's3' && !!selectedConfig.details.bucket && (
                            <span>Bucket: <span className="font-mono text-foreground">{String(selectedConfig.details.bucket)}</span></span>
                          )}
                          {selectedConfig.provider === 's3' && !!selectedConfig.details.region && (
                            <span>Region: <span className="font-mono text-foreground">{String(selectedConfig.details.region)}</span></span>
                          )}
                          {selectedConfig.provider === 's3' && !!selectedConfig.details.endpoint && (
                            <span>Endpoint: <span className="font-mono text-foreground">{String(selectedConfig.details.endpoint)}</span></span>
                          )}
                          {selectedConfig.provider === 'local' && !!selectedConfig.details.path && (
                            <span>Path: <span className="font-mono text-foreground">{String(selectedConfig.details.path)}</span></span>
                          )}
                        </div>
                      </div>
                      {/* Test connection button */}
                      <button
                        type="button"
                        onClick={handleTestConnection}
                        disabled={testStatus === 'testing'}
                        className="inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1.5 text-xs font-medium transition hover:bg-muted disabled:opacity-50"
                      >
                        {testStatus === 'testing' && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                        {testStatus === 'success' && <CheckCircle2 className="h-3.5 w-3.5 text-emerald-600" />}
                        {testStatus === 'failed' && <XCircle className="h-3.5 w-3.5 text-destructive" />}
                        {testStatus === 'idle' && <Shield className="h-3.5 w-3.5" />}
                        {testStatus === 'testing' ? 'Testing...' : testStatus === 'success' ? 'Connected' : testStatus === 'failed' ? 'Failed' : 'Test'}
                      </button>
                    </div>
                  </div>
                )}
              </>
            )}
          </div>
        ) : (
          /* ── Create new config ────────────────────────────────────────── */
          <div className="mt-2 space-y-4 rounded-md border bg-muted/10 p-4">
            <div>
              <label className="text-xs font-medium text-muted-foreground">Configuration Name</label>
              <input
                value={newConfigName}
                onChange={(e) => setNewConfigName(e.target.value)}
                placeholder="e.g. Production S3 Backups"
                className="mt-1 h-10 w-full rounded-md border bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
              />
            </div>

            <div>
              <label className="text-xs font-medium text-muted-foreground">Provider</label>
              <div className="mt-2 grid gap-3 sm:grid-cols-2">
                {providerOptions.map((opt) => {
                  const Icon = opt.icon;
                  return (
                    <label
                      key={opt.value}
                      className={`flex cursor-pointer items-start gap-3 rounded-md border p-3 text-sm transition ${
                        newProvider === opt.value
                          ? 'border-primary/40 bg-primary/10'
                          : 'border-muted hover:border-muted-foreground/30'
                      }`}
                    >
                      <input
                        type="radio"
                        name="backupProvider"
                        value={opt.value}
                        checked={newProvider === opt.value}
                        onChange={() => setNewProvider(opt.value)}
                        className="hidden"
                      />
                      <Icon className={`mt-0.5 h-5 w-5 shrink-0 ${
                        newProvider === opt.value ? 'text-primary' : 'text-muted-foreground'
                      }`} />
                      <div>
                        <span className="font-medium text-foreground">{opt.label}</span>
                        <p className="text-xs text-muted-foreground">{opt.description}</p>
                      </div>
                    </label>
                  );
                })}
              </div>
            </div>

            {newProvider === 's3' && (
              <div className="space-y-3">
                <div className="grid gap-3 sm:grid-cols-2">
                  <div>
                    <label className="text-xs text-muted-foreground">Bucket Name</label>
                    <input
                      value={s3Bucket}
                      onChange={(e) => setS3Bucket(e.target.value)}
                      placeholder="my-backup-bucket"
                      className="mt-1 h-10 w-full rounded-md border bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                    />
                  </div>
                  <div>
                    <label className="text-xs text-muted-foreground">Region</label>
                    <input
                      value={s3Region}
                      onChange={(e) => setS3Region(e.target.value)}
                      placeholder="us-east-1"
                      className="mt-1 h-10 w-full rounded-md border bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                    />
                  </div>
                </div>
                <div className="grid gap-3 sm:grid-cols-2">
                  <div>
                    <label className="text-xs text-muted-foreground">Access Key ID</label>
                    <input
                      value={s3AccessKey}
                      onChange={(e) => setS3AccessKey(e.target.value)}
                      placeholder="AKIA..."
                      autoComplete="off"
                      className="mt-1 h-10 w-full rounded-md border bg-background px-3 font-mono text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                    />
                  </div>
                  <div>
                    <label className="text-xs text-muted-foreground">Secret Access Key</label>
                    <input
                      type="password"
                      value={s3SecretKey}
                      onChange={(e) => setS3SecretKey(e.target.value)}
                      placeholder="Secret key"
                      autoComplete="off"
                      className="mt-1 h-10 w-full rounded-md border bg-background px-3 font-mono text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                    />
                  </div>
                </div>
                <div className="grid gap-3 sm:grid-cols-2">
                  <div>
                    <label className="text-xs text-muted-foreground">
                      Path Prefix <span className="text-muted-foreground/60">(optional)</span>
                    </label>
                    <input
                      value={settings.s3Prefix}
                      onChange={(e) => update('s3Prefix', e.target.value)}
                      placeholder="backups/breeze/"
                      className="mt-1 h-10 w-full rounded-md border bg-background px-3 font-mono text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                    />
                    <p className="mt-1 text-[11px] text-muted-foreground">Key prefix for organizing objects in the bucket.</p>
                  </div>
                  <div>
                    <label className="text-xs text-muted-foreground">
                      Custom Endpoint <span className="text-muted-foreground/60">(optional)</span>
                    </label>
                    <input
                      value={s3Endpoint}
                      onChange={(e) => setS3Endpoint(e.target.value)}
                      placeholder="https://s3.us-west-002.backblazeb2.com"
                      className="mt-1 h-10 w-full rounded-md border bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                    />
                    <p className="mt-1 text-[11px] text-muted-foreground">For MinIO, Wasabi, Backblaze B2, etc.</p>
                  </div>
                </div>
              </div>
            )}
            {newProvider === 'local' && (
              <div>
                <label className="text-xs text-muted-foreground">Backup Path</label>
                <input
                  value={localPath}
                  onChange={(e) => setLocalPath(e.target.value)}
                  placeholder="/var/backups/breeze or \\\\nas\\backups"
                  className="mt-1 h-10 w-full rounded-md border bg-background px-3 font-mono text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                />
                <p className="mt-1 text-[11px] text-muted-foreground">
                  Local disk path, mounted NAS, or UNC network share. Path must be accessible by the agent.
                </p>
              </div>
            )}
          </div>
        )}
      </div>

      {/* ══════════════════════════════════════════════════════════════════════
          SECTION 2: What to Back Up
          ══════════════════════════════════════════════════════════════════════ */}
      <div className="mt-6">
        <h3 className="text-sm font-semibold flex items-center gap-2">
          <FolderOpen className="h-4 w-4" />
          Backup Paths
        </h3>
        <p className="mt-1 text-xs text-muted-foreground">
          Directories and files to include in backups. Agents back up these paths on each assigned device.
        </p>
        <div className="mt-3">
          <PathList
            items={settings.paths}
            onAdd={(v) => update('paths', [...settings.paths, v])}
            onRemove={(v) => update('paths', settings.paths.filter((p) => p !== v))}
            placeholder="C:\Users or /home or /etc"
            label="paths"
          />
        </div>
      </div>

      {/* ── Exclusion patterns ──────────────────────────────────────────── */}
      <div className="mt-6">
        <h3 className="text-sm font-semibold">Exclusion Patterns</h3>
        <p className="mt-1 text-xs text-muted-foreground">
          Glob patterns to skip during backup. Click a common pattern to add it.
        </p>
        <div className="mt-2 flex flex-wrap gap-1.5">
          {commonExclusions
            .filter((e) => !settings.excludePatterns.includes(e.pattern))
            .map((e) => (
              <button
                key={e.pattern}
                type="button"
                onClick={() => update('excludePatterns', [...settings.excludePatterns, e.pattern])}
                className="rounded-full border px-2.5 py-1 text-[11px] text-muted-foreground transition hover:border-primary/40 hover:text-primary"
              >
                + {e.label}
              </button>
            ))
          }
        </div>
        <div className="mt-3">
          <PathList
            items={settings.excludePatterns}
            onAdd={(v) => update('excludePatterns', [...settings.excludePatterns, v])}
            onRemove={(v) => update('excludePatterns', settings.excludePatterns.filter((p) => p !== v))}
            placeholder="*.tmp or logs/**"
            label="exclusions"
          />
        </div>
      </div>

      {/* ══════════════════════════════════════════════════════════════════════
          SECTION 3: Schedule
          ══════════════════════════════════════════════════════════════════════ */}
      <div className="mt-6">
        <h3 className="text-sm font-semibold flex items-center gap-2">
          <Clock className="h-4 w-4" />
          Backup Schedule
        </h3>
        <div className="mt-2 grid gap-4 sm:grid-cols-3">
          <div>
            <label className="text-xs text-muted-foreground">Frequency</label>
            <select
              value={settings.scheduleFrequency}
              onChange={(e) => update('scheduleFrequency', e.target.value as ScheduleFrequency)}
              className="mt-1 h-10 w-full rounded-md border bg-background px-3 text-sm"
            >
              {scheduleOptions.map((o) => (
                <option key={o.value} value={o.value}>{o.label}</option>
              ))}
            </select>
          </div>
          <div>
            <label className="text-xs text-muted-foreground">Time (UTC)</label>
            <input
              type="time"
              value={settings.scheduleTime}
              onChange={(e) => update('scheduleTime', e.target.value)}
              className="mt-1 h-10 w-full rounded-md border bg-background px-3 text-sm"
            />
          </div>
          {settings.scheduleFrequency === 'weekly' && (
            <div>
              <label className="text-xs text-muted-foreground">Day of week</label>
              <select
                value={settings.scheduleDayOfWeek}
                onChange={(e) => update('scheduleDayOfWeek', Number(e.target.value))}
                className="mt-1 h-10 w-full rounded-md border bg-background px-3 text-sm"
              >
                {dayOfWeekOptions.map((o) => (
                  <option key={o.value} value={o.value}>{o.label}</option>
                ))}
              </select>
            </div>
          )}
          {settings.scheduleFrequency === 'monthly' && (
            <div>
              <label className="text-xs text-muted-foreground">Day of month</label>
              <input
                type="number"
                min={1}
                max={28}
                value={settings.scheduleDayOfMonth}
                onChange={(e) => update('scheduleDayOfMonth', Number(e.target.value) || 1)}
                className="mt-1 h-10 w-full rounded-md border bg-background px-3 text-sm"
              />
            </div>
          )}
        </div>
        <p className="mt-2 text-xs text-muted-foreground">
          {scheduleDescription(settings)}
        </p>
      </div>

      {/* ══════════════════════════════════════════════════════════════════════
          SECTION 4: Retention
          ══════════════════════════════════════════════════════════════════════ */}
      <div className="mt-6">
        <h3 className="text-sm font-semibold">Retention Policy</h3>
        <div className="mt-2 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {retentionPresets.map((preset) => (
            <label
              key={preset.value}
              className={`flex cursor-pointer flex-col gap-1 rounded-md border p-3 text-sm transition ${
                settings.retentionPreset === preset.value
                  ? 'border-primary/40 bg-primary/10 text-primary'
                  : 'border-muted text-muted-foreground hover:text-foreground'
              }`}
            >
              <input
                type="radio"
                name="retentionPreset"
                value={preset.value}
                checked={settings.retentionPreset === preset.value}
                onChange={() => handleRetentionPreset(preset.value)}
                className="hidden"
              />
              <span className="font-medium text-foreground">{preset.label}</span>
              <span className="text-xs text-muted-foreground">
                {preset.value === 'custom'
                  ? 'Set your own values'
                  : `${preset.days}d, ${preset.versions} versions`
                }
              </span>
            </label>
          ))}
        </div>
        {settings.retentionPreset === 'custom' && (
          <div className="mt-4 grid gap-4 sm:grid-cols-2">
            <div>
              <label className="text-xs text-muted-foreground">Retention Days</label>
              <input
                type="number"
                min={1}
                max={3650}
                value={settings.retentionDays}
                onChange={(e) => update('retentionDays', Number(e.target.value) || 30)}
                className="mt-1 h-10 w-full rounded-md border bg-background px-3 text-sm"
              />
            </div>
            <div>
              <label className="text-xs text-muted-foreground">Max Versions</label>
              <input
                type="number"
                min={1}
                max={100}
                value={settings.retentionVersions}
                onChange={(e) => update('retentionVersions', Number(e.target.value) || 5)}
                className="mt-1 h-10 w-full rounded-md border bg-background px-3 text-sm"
              />
            </div>
          </div>
        )}
        {settings.retentionPreset !== 'custom' && retentionInfo && (
          <p className="mt-2 text-xs text-muted-foreground">
            Keep backups for {retentionInfo.days} days with up to {retentionInfo.versions} versions per device.
          </p>
        )}
      </div>

      {/* ══════════════════════════════════════════════════════════════════════
          SECTION 5: Options & Notifications
          ══════════════════════════════════════════════════════════════════════ */}
      <div className="mt-6 space-y-3">
        <h3 className="text-sm font-semibold">Options</h3>
        <div className="grid gap-3 lg:grid-cols-2">
          <ToggleRow
            label="Compression"
            description="Compress backup data to reduce storage usage."
            checked={settings.compression}
            onChange={(v) => update('compression', v)}
          />
          <ToggleRow
            label="Encryption"
            description="Encrypt backups at rest with AES-256."
            checked={settings.encryption}
            onChange={(v) => update('encryption', v)}
          />
        </div>
      </div>

      <div className="mt-4 space-y-3">
        <h3 className="text-sm font-semibold">Notifications</h3>
        <div className="grid gap-3 lg:grid-cols-2">
          <ToggleRow
            label="Notify on failure"
            description="Send an alert when a backup job fails."
            checked={settings.notifyOnFailure}
            onChange={(v) => update('notifyOnFailure', v)}
          />
          <ToggleRow
            label="Notify on success"
            description="Send a confirmation after each successful backup."
            checked={settings.notifyOnSuccess}
            onChange={(v) => update('notifyOnSuccess', v)}
          />
          <ToggleRow
            label="Notify on missed"
            description="Alert when a scheduled backup didn't run (device offline, agent unreachable)."
            checked={settings.notifyOnMissed}
            onChange={(v) => update('notifyOnMissed', v)}
          />
        </div>
      </div>
    </FeatureTabShell>
  );
}
