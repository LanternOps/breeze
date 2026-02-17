import { useState, useEffect } from 'react';
import { PackageCheck } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { FeatureTabProps } from './types';
import { FEATURE_META } from './types';
import { useFeatureLink } from './useFeatureLink';
import FeatureTabShell from './FeatureTabShell';

type SourceType = 'os' | 'third_party' | 'firmware' | 'drivers';
type Severity = 'critical' | 'important' | 'moderate' | 'low';
type ScheduleFrequency = 'daily' | 'weekly' | 'monthly';
type RebootPolicy = 'never' | 'if_required' | 'always';

type PatchSettings = {
  sources: SourceType[];
  autoApprove: boolean;
  autoApproveSeverities: Severity[];
  scheduleFrequency: ScheduleFrequency;
  scheduleTime: string;
  scheduleDayOfWeek: string;
  scheduleDayOfMonth: number;
  rebootPolicy: RebootPolicy;
};

const defaults: PatchSettings = {
  sources: ['os'],
  autoApprove: false,
  autoApproveSeverities: [],
  scheduleFrequency: 'weekly',
  scheduleTime: '02:00',
  scheduleDayOfWeek: 'sun',
  scheduleDayOfMonth: 1,
  rebootPolicy: 'if_required',
};

const sourceOptions: { value: SourceType; label: string }[] = [
  { value: 'os', label: 'OS Updates' },
  { value: 'third_party', label: 'Third-Party Apps' },
  { value: 'firmware', label: 'Firmware' },
  { value: 'drivers', label: 'Drivers' },
];

const severityOptions: { value: Severity; label: string; color: string }[] = [
  { value: 'critical', label: 'Critical', color: 'border-red-500/40 bg-red-500/10 text-red-700' },
  { value: 'important', label: 'Important', color: 'border-orange-500/40 bg-orange-500/10 text-orange-700' },
  { value: 'moderate', label: 'Moderate', color: 'border-yellow-500/40 bg-yellow-500/10 text-yellow-700' },
  { value: 'low', label: 'Low', color: 'border-blue-500/40 bg-blue-500/10 text-blue-700' },
];

const scheduleOptions: { value: ScheduleFrequency; label: string }[] = [
  { value: 'daily', label: 'Daily' },
  { value: 'weekly', label: 'Weekly' },
  { value: 'monthly', label: 'Monthly' },
];

const rebootOptions: { value: RebootPolicy; label: string; description: string }[] = [
  { value: 'never', label: 'Never reboot', description: 'Do not reboot devices automatically.' },
  { value: 'if_required', label: 'If required', description: 'Reboot only when the patch requires it.' },
  { value: 'always', label: 'Always reboot', description: 'Always reboot after patching.' },
];

const dayOfWeekOptions = [
  { value: 'mon', label: 'Monday' },
  { value: 'tue', label: 'Tuesday' },
  { value: 'wed', label: 'Wednesday' },
  { value: 'thu', label: 'Thursday' },
  { value: 'fri', label: 'Friday' },
  { value: 'sat', label: 'Saturday' },
  { value: 'sun', label: 'Sunday' },
];

export default function PatchTab({ policyId, existingLink, onLinkChanged, linkedPolicyId, parentLink }: FeatureTabProps) {
  const { save, remove, saving, error, clearError } = useFeatureLink(policyId);
  const isInherited = !!parentLink && !existingLink;
  const effectiveLink = existingLink ?? parentLink;
  const [settings, setSettings] = useState<PatchSettings>(() => ({
    ...defaults,
    ...(effectiveLink?.inlineSettings as Partial<PatchSettings> | undefined),
  }));

  useEffect(() => {
    const link = existingLink ?? parentLink;
    if (link?.inlineSettings) {
      setSettings((prev) => ({ ...prev, ...(link.inlineSettings as Partial<PatchSettings>) }));
    }
  }, [existingLink, parentLink]);

  const update = <K extends keyof PatchSettings>(key: K, value: PatchSettings[K]) =>
    setSettings((prev) => ({ ...prev, [key]: value }));

  const toggleSource = (source: SourceType) => {
    const current = settings.sources;
    update('sources', current.includes(source) ? current.filter((s) => s !== source) : [...current, source]);
  };

  const toggleSeverity = (sev: Severity) => {
    const current = settings.autoApproveSeverities ?? [];
    update('autoApproveSeverities', current.includes(sev) ? current.filter((s) => s !== sev) : [...current, sev]);
  };

  const handleSave = async () => {
    clearError();
    const result = await save(existingLink?.id ?? null, {
      featureType: 'patch',
      featurePolicyId: linkedPolicyId,
      inlineSettings: settings,
    });
    if (result) onLinkChanged(result, 'patch');
  };

  const handleRemove = async () => {
    if (!existingLink) return;
    const ok = await remove(existingLink.id);
    if (ok) onLinkChanged(null, 'patch');
  };

  const handleOverride = async () => {
    clearError();
    const result = await save(null, {
      featureType: 'patch',
      featurePolicyId: linkedPolicyId,
      inlineSettings: settings,
    });
    if (result) onLinkChanged(result, 'patch');
  };

  const handleRevert = async () => {
    if (!existingLink) return;
    const ok = await remove(existingLink.id);
    if (ok) onLinkChanged(null, 'patch');
  };

  const meta = FEATURE_META.patch;

  return (
    <FeatureTabShell
      title={meta.label}
      description={meta.description}
      icon={<PackageCheck className="h-5 w-5" />}
      isConfigured={!!existingLink || isInherited}
      saving={saving}
      error={error}
      onSave={handleSave}
      onRemove={existingLink && !linkedPolicyId ? handleRemove : undefined}
      isInherited={isInherited}
      onOverride={isInherited ? handleOverride : undefined}
      onRevert={!isInherited && !!linkedPolicyId && !!existingLink ? handleRevert : undefined}
    >
      {/* Sources */}
      <div>
        <h3 className="text-sm font-semibold">Patch Sources</h3>
        <div className="mt-2 space-y-2">
          {sourceOptions.map((source) => (
            <label key={source.value} className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={settings.sources.includes(source.value)}
                onChange={() => toggleSource(source.value)}
                className="h-4 w-4 rounded border-muted"
              />
              {source.label}
            </label>
          ))}
        </div>
      </div>

      {/* Auto-approve */}
      <div className="mt-6">
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={settings.autoApprove}
            onChange={(e) => update('autoApprove', e.target.checked)}
            className="h-4 w-4 rounded border-muted"
          />
          <span className="font-medium">Automatically approve patches</span>
        </label>
        {settings.autoApprove && (
          <div className="mt-3">
            <p className="text-sm text-muted-foreground">Auto-approve severities:</p>
            <div className="mt-2 flex flex-wrap gap-2">
              {severityOptions.map((sev) => (
                <button
                  key={sev.value}
                  type="button"
                  onClick={() => toggleSeverity(sev.value)}
                  className={cn(
                    'rounded-full border px-3 py-1 text-xs font-medium transition',
                    (settings.autoApproveSeverities ?? []).includes(sev.value)
                      ? sev.color
                      : 'border-muted text-muted-foreground hover:text-foreground'
                  )}
                >
                  {sev.label}
                </button>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* Schedule */}
      <div className="mt-6">
        <h3 className="text-sm font-semibold">Schedule</h3>
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
                onChange={(e) => update('scheduleDayOfWeek', e.target.value)}
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

      {/* Reboot policy */}
      <div className="mt-6">
        <h3 className="text-sm font-semibold">Reboot Policy</h3>
        <div className="mt-2 grid gap-3 sm:grid-cols-3">
          {rebootOptions.map((option) => (
            <label
              key={option.value}
              className={cn(
                'flex cursor-pointer flex-col gap-1 rounded-md border p-3 text-sm transition',
                settings.rebootPolicy === option.value
                  ? 'border-primary/40 bg-primary/10 text-primary'
                  : 'border-muted text-muted-foreground hover:text-foreground'
              )}
            >
              <input
                type="radio"
                name="rebootPolicy"
                value={option.value}
                checked={settings.rebootPolicy === option.value}
                onChange={() => update('rebootPolicy', option.value)}
                className="hidden"
              />
              <span className="font-medium text-foreground">{option.label}</span>
              <span className="text-xs text-muted-foreground">{option.description}</span>
            </label>
          ))}
        </div>
      </div>
    </FeatureTabShell>
  );
}
