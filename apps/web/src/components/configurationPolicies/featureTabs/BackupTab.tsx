import { useState, useEffect, useCallback } from 'react';
import { HardDrive, Loader2, Plus } from 'lucide-react';
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
};

const scheduleOptions: { value: ScheduleFrequency; label: string }[] = [
  { value: 'daily', label: 'Daily' },
  { value: 'weekly', label: 'Weekly' },
  { value: 'monthly', label: 'Monthly' },
];

const retentionPresets: { value: RetentionPreset; label: string; description: string }[] = [
  { value: 'standard', label: 'Standard', description: '30 days, 5 versions' },
  { value: 'extended', label: 'Extended', description: '90 days, 10 versions' },
  { value: 'compliance', label: 'Compliance', description: '365 days, 20 versions' },
  { value: 'custom', label: 'Custom', description: 'Set your own values' },
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

const providerOptions: { value: BackupProvider; label: string; description: string }[] = [
  { value: 's3', label: 'Amazon S3 / S3-Compatible', description: 'AWS S3, MinIO, Wasabi, Backblaze B2' },
  { value: 'local', label: 'Local / Network Path', description: 'Local disk, NAS, or UNC share' },
];

const providerLabels: Record<string, string> = {
  s3: 'Amazon S3',
  local: 'Local / NAS',
};

// ── Component ──────────────────────────────────────────────────────────────────

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

  // If there are existing configs, default to select mode. Otherwise create.
  useEffect(() => {
    if (!configsLoading && configs.length === 0 && !selectedConfigId) {
      setMode('create');
    }
  }, [configsLoading, configs.length, selectedConfigId]);

  // ── Helpers ────────────────────────────────────────────────────────────────

  const update = <K extends keyof BackupScheduleSettings>(key: K, value: BackupScheduleSettings[K]) =>
    setSettings((prev) => ({ ...prev, [key]: value }));

  const handleRetentionPreset = (preset: RetentionPreset) => {
    update('retentionPreset', preset);
    if (preset === 'standard') { update('retentionDays', 30); update('retentionVersions', 5); }
    else if (preset === 'extended') { update('retentionDays', 90); update('retentionVersions', 10); }
    else if (preset === 'compliance') { update('retentionDays', 365); update('retentionVersions', 20); }
  };

  // ── Create config via API ──────────────────────────────────────────────────

  const createConfig = async (): Promise<string | null> => {
    setConfigError(undefined);
    setConfigSaving(true);
    try {
      const details: Record<string, unknown> = newProvider === 's3'
        ? { bucket: s3Bucket, region: s3Region, accessKey: s3AccessKey, secretKey: s3SecretKey, ...(s3Endpoint ? { endpoint: s3Endpoint } : {}) }
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
      // Add to local list and select it
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

    // If creating a new config, create it first
    if (mode === 'create') {
      if (!newConfigName.trim()) {
        setConfigError('Config name is required');
        return;
      }
      if (newProvider === 's3' && !s3Bucket.trim()) {
        setConfigError('S3 bucket name is required');
        return;
      }
      if (newProvider === 'local' && !localPath.trim()) {
        setConfigError('Backup path is required');
        return;
      }
      const created = await createConfig();
      if (!created) return;
      configId = created;
    }

    if (!configId) {
      setConfigError('Please select or create a backup configuration');
      return;
    }

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
      {/* ── Storage Configuration ─────────────────────────────────────────── */}
      <div>
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-semibold">Storage Configuration</h3>
          {configs.length > 0 && (
            <button
              type="button"
              onClick={() => setMode(mode === 'create' ? 'select' : 'create')}
              className="inline-flex items-center gap-1.5 text-xs text-primary hover:underline"
            >
              {mode === 'create' ? (
                'Use existing config'
              ) : (
                <>
                  <Plus className="h-3.5 w-3.5" />
                  Create new
                </>
              )}
            </button>
          )}
        </div>

        {mode === 'select' ? (
          /* ── Select existing config ──────────────────────────────────── */
          <div className="mt-2">
            {configsLoading ? (
              <div className="flex items-center gap-2 text-sm text-muted-foreground">
                <Loader2 className="h-4 w-4 animate-spin" />
                Loading backup configs...
              </div>
            ) : configs.length === 0 ? (
              <div className="rounded-md border border-dashed p-4 text-center text-sm text-muted-foreground">
                No backup configurations yet.{' '}
                <button
                  type="button"
                  onClick={() => setMode('create')}
                  className="text-primary underline underline-offset-2"
                >
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
                {selectedConfig && (
                  <div className="mt-2 rounded-md border bg-muted/20 p-3">
                    <div className="flex items-center gap-3 text-xs text-muted-foreground">
                      <span>
                        Provider: <span className="font-medium text-foreground">{providerLabels[selectedConfig.provider] ?? selectedConfig.provider}</span>
                      </span>
                      <span>
                        Status:{' '}
                        <span className={selectedConfig.enabled ? 'font-medium text-green-600' : 'font-medium text-yellow-600'}>
                          {selectedConfig.enabled ? 'Active' : 'Disabled'}
                        </span>
                      </span>
                    </div>
                  </div>
                )}
              </>
            )}
          </div>
        ) : (
          /* ── Create new config ───────────────────────────────────────── */
          <div className="mt-2 space-y-4 rounded-md border bg-muted/10 p-4">
            {/* Config name */}
            <div>
              <label className="text-xs font-medium text-muted-foreground">Configuration Name</label>
              <input
                value={newConfigName}
                onChange={(e) => setNewConfigName(e.target.value)}
                placeholder="e.g. Production S3 Backups"
                className="mt-1 h-10 w-full rounded-md border bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
              />
            </div>

            {/* Provider selection */}
            <div>
              <label className="text-xs font-medium text-muted-foreground">Provider</label>
              <div className="mt-2 grid gap-3 sm:grid-cols-2">
                {providerOptions.map((opt) => (
                  <label
                    key={opt.value}
                    className={`flex cursor-pointer flex-col gap-1 rounded-md border p-3 text-sm transition ${
                      newProvider === opt.value
                        ? 'border-primary/40 bg-primary/10 text-primary'
                        : 'border-muted text-muted-foreground hover:text-foreground'
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
                    <span className="font-medium text-foreground">{opt.label}</span>
                    <span className="text-xs text-muted-foreground">{opt.description}</span>
                  </label>
                ))}
              </div>
            </div>

            {/* Provider-specific fields */}
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
                      className="mt-1 h-10 w-full rounded-md border bg-background px-3 font-mono text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                    />
                  </div>
                </div>
                <div>
                  <label className="text-xs text-muted-foreground">
                    Custom Endpoint <span className="text-muted-foreground/60">(optional, for S3-compatible storage)</span>
                  </label>
                  <input
                    value={s3Endpoint}
                    onChange={(e) => setS3Endpoint(e.target.value)}
                    placeholder="https://s3.us-west-002.backblazeb2.com"
                    className="mt-1 h-10 w-full rounded-md border bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                  />
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
                <p className="mt-1 text-xs text-muted-foreground">
                  Local disk path, mounted NAS, or UNC network share.
                </p>
              </div>
            )}
          </div>
        )}
      </div>

      {/* ── Backup Schedule ───────────────────────────────────────────────── */}
      <div className="mt-6">
        <h3 className="text-sm font-semibold">Backup Schedule</h3>
        <p className="mt-1 text-xs text-muted-foreground">
          When backups run on assigned devices.
        </p>
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
            <label className="text-xs text-muted-foreground">Time</label>
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
      </div>

      {/* ── Retention ─────────────────────────────────────────────────────── */}
      <div className="mt-6">
        <h3 className="text-sm font-semibold">Retention</h3>
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
              <span className="text-xs text-muted-foreground">{preset.description}</span>
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
      </div>

      {/* ── Options ───────────────────────────────────────────────────────── */}
      <div className="mt-6 flex gap-6">
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={settings.compression}
            onChange={(e) => update('compression', e.target.checked)}
            className="h-4 w-4 rounded border-muted"
          />
          Enable compression
        </label>
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={settings.encryption}
            onChange={(e) => update('encryption', e.target.checked)}
            className="h-4 w-4 rounded border-muted"
          />
          Enable encryption
        </label>
      </div>
    </FeatureTabShell>
  );
}
