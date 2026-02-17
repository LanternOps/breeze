import { useState, useEffect } from 'react';
import { HardDrive } from 'lucide-react';
import type { FeatureTabProps } from './types';
import { FEATURE_META } from './types';
import { useFeatureLink } from './useFeatureLink';
import FeatureTabShell from './FeatureTabShell';

type BackupProvider = 's3' | 'azure' | 'gcs' | 'local';
type ScheduleType = 'daily' | 'weekly' | 'cron';
type RetentionPreset = 'standard' | 'extended' | 'compliance' | 'custom';

type BackupSettings = {
  provider: BackupProvider;
  scheduleType: ScheduleType;
  scheduleTime: string;
  scheduleDayOfWeek: string;
  cronExpression: string;
  retentionPreset: RetentionPreset;
  retentionDays: number;
  retentionVersions: number;
  compression: boolean;
  encryption: boolean;
};

const defaults: BackupSettings = {
  provider: 's3',
  scheduleType: 'daily',
  scheduleTime: '03:00',
  scheduleDayOfWeek: 'sun',
  cronExpression: '0 3 * * *',
  retentionPreset: 'standard',
  retentionDays: 30,
  retentionVersions: 5,
  compression: true,
  encryption: true,
};

const providerOptions: { value: BackupProvider; label: string; description: string }[] = [
  { value: 's3', label: 'Amazon S3', description: 'AWS S3 or compatible storage' },
  { value: 'azure', label: 'Azure Blob', description: 'Azure Blob Storage' },
  { value: 'gcs', label: 'Google Cloud', description: 'Google Cloud Storage' },
  { value: 'local', label: 'Local', description: 'Local disk or NAS' },
];

const scheduleTypeOptions: { value: ScheduleType; label: string }[] = [
  { value: 'daily', label: 'Daily' },
  { value: 'weekly', label: 'Weekly' },
  { value: 'cron', label: 'Custom Cron' },
];

const retentionPresets: { value: RetentionPreset; label: string; description: string }[] = [
  { value: 'standard', label: 'Standard', description: '30 days, 5 versions' },
  { value: 'extended', label: 'Extended', description: '90 days, 10 versions' },
  { value: 'compliance', label: 'Compliance', description: '365 days, 20 versions' },
  { value: 'custom', label: 'Custom', description: 'Set your own values' },
];

const dayOfWeekOptions = [
  { value: 'sun', label: 'Sunday' },
  { value: 'mon', label: 'Monday' },
  { value: 'tue', label: 'Tuesday' },
  { value: 'wed', label: 'Wednesday' },
  { value: 'thu', label: 'Thursday' },
  { value: 'fri', label: 'Friday' },
  { value: 'sat', label: 'Saturday' },
];

export default function BackupTab({ policyId, existingLink, onLinkChanged, linkedPolicyId }: FeatureTabProps) {
  const { save, remove, saving, error, clearError } = useFeatureLink(policyId);
  const [settings, setSettings] = useState<BackupSettings>(() => ({
    ...defaults,
    ...(existingLink?.inlineSettings as Partial<BackupSettings> | undefined),
  }));

  useEffect(() => {
    if (existingLink?.inlineSettings) {
      setSettings((prev) => ({ ...prev, ...(existingLink.inlineSettings as Partial<BackupSettings>) }));
    }
  }, [existingLink]);

  const update = <K extends keyof BackupSettings>(key: K, value: BackupSettings[K]) =>
    setSettings((prev) => ({ ...prev, [key]: value }));

  const handleRetentionPreset = (preset: RetentionPreset) => {
    update('retentionPreset', preset);
    if (preset === 'standard') { update('retentionDays', 30); update('retentionVersions', 5); }
    else if (preset === 'extended') { update('retentionDays', 90); update('retentionVersions', 10); }
    else if (preset === 'compliance') { update('retentionDays', 365); update('retentionVersions', 20); }
  };

  const handleSave = async () => {
    clearError();
    const result = await save(existingLink?.id ?? null, {
      featureType: 'backup',
      featurePolicyId: linkedPolicyId,
      inlineSettings: settings,
    });
    if (result) onLinkChanged(result, 'backup');
  };

  const handleRemove = async () => {
    if (!existingLink) return;
    const ok = await remove(existingLink.id);
    if (ok) onLinkChanged(null, 'backup');
  };

  const meta = FEATURE_META.backup;

  return (
    <FeatureTabShell
      title={meta.label}
      description={meta.description}
      icon={<HardDrive className="h-5 w-5" />}
      isConfigured={!!existingLink}
      saving={saving}
      error={error}
      onSave={handleSave}
      onRemove={existingLink ? handleRemove : undefined}
    >
      {/* Provider */}
      <div>
        <h3 className="text-sm font-semibold">Backup Provider</h3>
        <div className="mt-2 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {providerOptions.map((opt) => (
            <label
              key={opt.value}
              className={`flex cursor-pointer flex-col gap-1 rounded-md border p-3 text-sm transition ${
                settings.provider === opt.value
                  ? 'border-primary/40 bg-primary/10 text-primary'
                  : 'border-muted text-muted-foreground hover:text-foreground'
              }`}
            >
              <input
                type="radio"
                name="backupProvider"
                value={opt.value}
                checked={settings.provider === opt.value}
                onChange={() => update('provider', opt.value)}
                className="hidden"
              />
              <span className="font-medium text-foreground">{opt.label}</span>
              <span className="text-xs text-muted-foreground">{opt.description}</span>
            </label>
          ))}
        </div>
      </div>

      {/* Schedule */}
      <div className="mt-6">
        <h3 className="text-sm font-semibold">Schedule</h3>
        <div className="mt-2 grid gap-4 sm:grid-cols-3">
          <div>
            <label className="text-xs text-muted-foreground">Type</label>
            <select
              value={settings.scheduleType}
              onChange={(e) => update('scheduleType', e.target.value as ScheduleType)}
              className="mt-1 h-10 w-full rounded-md border bg-background px-3 text-sm"
            >
              {scheduleTypeOptions.map((o) => (
                <option key={o.value} value={o.value}>{o.label}</option>
              ))}
            </select>
          </div>
          {settings.scheduleType !== 'cron' && (
            <div>
              <label className="text-xs text-muted-foreground">Time</label>
              <input
                type="time"
                value={settings.scheduleTime}
                onChange={(e) => update('scheduleTime', e.target.value)}
                className="mt-1 h-10 w-full rounded-md border bg-background px-3 text-sm"
              />
            </div>
          )}
          {settings.scheduleType === 'weekly' && (
            <div>
              <label className="text-xs text-muted-foreground">Day</label>
              <select
                value={settings.scheduleDayOfWeek}
                onChange={(e) => update('scheduleDayOfWeek', e.target.value)}
                className="mt-1 h-10 w-full rounded-md border bg-background px-3 text-sm"
              >
                {dayOfWeekOptions.map((o) => (
                  <option key={o.value} value={o.value}>{o.label}</option>
                ))}
              </select>
            </div>
          )}
          {settings.scheduleType === 'cron' && (
            <div className="sm:col-span-2">
              <label className="text-xs text-muted-foreground">Cron Expression</label>
              <input
                value={settings.cronExpression}
                onChange={(e) => update('cronExpression', e.target.value)}
                placeholder="0 3 * * *"
                className="mt-1 h-10 w-full rounded-md border bg-background px-3 font-mono text-sm focus:outline-none focus:ring-2 focus:ring-ring"
              />
            </div>
          )}
        </div>
      </div>

      {/* Retention */}
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

      {/* Options */}
      <div className="mt-6 flex gap-6">
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={settings.compression} onChange={(e) => update('compression', e.target.checked)} className="h-4 w-4 rounded border-muted" />
          Enable compression
        </label>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={settings.encryption} onChange={(e) => update('encryption', e.target.checked)} className="h-4 w-4 rounded border-muted" />
          Enable encryption
        </label>
      </div>
    </FeatureTabShell>
  );
}
