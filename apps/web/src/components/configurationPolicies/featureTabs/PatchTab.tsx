import { useState, useEffect, useCallback } from 'react';
import { PackageCheck, Loader2 } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { FeatureTabProps } from './types';
import { FEATURE_META } from './types';
import { useFeatureLink } from './useFeatureLink';
import FeatureTabShell from './FeatureTabShell';
import { fetchWithAuth } from '../../../stores/auth';

type ScheduleFrequency = 'daily' | 'weekly' | 'monthly';
type RebootPolicy = 'never' | 'if_required' | 'always' | 'maintenance_window';

type PatchDeploymentSettings = {
  scheduleFrequency: ScheduleFrequency;
  scheduleTime: string;
  scheduleDayOfWeek: string;
  scheduleDayOfMonth: number;
  rebootPolicy: RebootPolicy;
};

type UpdateRing = {
  id: string;
  name: string;
  description?: string | null;
  ringOrder: number;
  deferralDays: number;
  deadlineDays?: number | null;
  gracePeriodHours: number;
};

const defaults: PatchDeploymentSettings = {
  scheduleFrequency: 'weekly',
  scheduleTime: '02:00',
  scheduleDayOfWeek: 'sun',
  scheduleDayOfMonth: 1,
  rebootPolicy: 'if_required',
};

const scheduleOptions: { value: ScheduleFrequency; label: string }[] = [
  { value: 'daily', label: 'Daily' },
  { value: 'weekly', label: 'Weekly' },
  { value: 'monthly', label: 'Monthly' },
];

const rebootOptions: { value: RebootPolicy; label: string; description: string }[] = [
  { value: 'never', label: 'Never reboot', description: 'Do not reboot devices automatically.' },
  { value: 'if_required', label: 'If required', description: 'Reboot only when the patch requires it.' },
  { value: 'always', label: 'Always reboot', description: 'Always reboot after patching.' },
  { value: 'maintenance_window', label: 'During maintenance window', description: 'Only reboot during a scheduled maintenance window.' },
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

  const [selectedRingId, setSelectedRingId] = useState<string>(
    () => effectiveLink?.featurePolicyId ?? ''
  );
  const [rings, setRings] = useState<UpdateRing[]>([]);
  const [ringsLoading, setRingsLoading] = useState(false);

  const [settings, setSettings] = useState<PatchDeploymentSettings>(() => ({
    ...defaults,
    ...(effectiveLink?.inlineSettings as Partial<PatchDeploymentSettings> | undefined),
  }));

  const fetchRings = useCallback(async () => {
    setRingsLoading(true);
    try {
      const response = await fetchWithAuth('/update-rings');
      if (response.ok) {
        const payload = await response.json();
        setRings(Array.isArray(payload.data) ? payload.data : Array.isArray(payload) ? payload : []);
      }
    } catch {
      // Silently fail
    } finally {
      setRingsLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchRings();
  }, [fetchRings]);

  useEffect(() => {
    const link = existingLink ?? parentLink;
    if (link?.featurePolicyId) {
      setSelectedRingId(link.featurePolicyId);
    }
    if (link?.inlineSettings) {
      setSettings((prev) => ({ ...prev, ...(link.inlineSettings as Partial<PatchDeploymentSettings>) }));
    }
  }, [existingLink, parentLink]);

  const update = <K extends keyof PatchDeploymentSettings>(key: K, value: PatchDeploymentSettings[K]) =>
    setSettings((prev) => ({ ...prev, [key]: value }));

  const handleSave = async () => {
    clearError();
    const result = await save(existingLink?.id ?? null, {
      featureType: 'patch',
      featurePolicyId: selectedRingId || null,
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
      featurePolicyId: selectedRingId || null,
      inlineSettings: settings,
    });
    if (result) onLinkChanged(result, 'patch');
  };

  const handleRevert = async () => {
    if (!existingLink) return;
    const ok = await remove(existingLink.id);
    if (ok) onLinkChanged(null, 'patch');
  };

  const selectedRing = rings.find((r) => r.id === selectedRingId);
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
      {/* Approval Ring */}
      <div>
        <h3 className="text-sm font-semibold">Approval Ring</h3>
        <p className="mt-1 text-xs text-muted-foreground">
          Select which update ring governs patch approvals for this policy. Leave empty for manual-only approvals.
        </p>
        {ringsLoading ? (
          <div className="mt-2 flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />
            Loading rings...
          </div>
        ) : (
          <select
            value={selectedRingId}
            onChange={(e) => setSelectedRingId(e.target.value)}
            className="mt-2 h-10 w-full rounded-md border bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
          >
            <option value="">No ring (manual approvals only)</option>
            {rings.map((ring) => (
              <option key={ring.id} value={ring.id}>
                [{ring.ringOrder}] {ring.name}
                {ring.deferralDays > 0 ? ` (${ring.deferralDays}d deferral)` : ''}
              </option>
            ))}
          </select>
        )}
        {selectedRing && (
          <div className="mt-2 flex gap-4 text-xs text-muted-foreground">
            <span>Deferral: {selectedRing.deferralDays === 0 ? 'None' : `${selectedRing.deferralDays}d`}</span>
            <span>Deadline: {selectedRing.deadlineDays == null ? 'None' : `${selectedRing.deadlineDays}d`}</span>
            <span>Grace: {selectedRing.gracePeriodHours}h</span>
          </div>
        )}
      </div>

      {/* Schedule */}
      <div className="mt-6">
        <h3 className="text-sm font-semibold">Installation Schedule</h3>
        <p className="mt-1 text-xs text-muted-foreground">
          When approved patches are installed on devices.
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

      {/* Reboot Policy */}
      <div className="mt-6">
        <h3 className="text-sm font-semibold">Reboot Policy</h3>
        <div className="mt-2 grid gap-3 sm:grid-cols-2">
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
