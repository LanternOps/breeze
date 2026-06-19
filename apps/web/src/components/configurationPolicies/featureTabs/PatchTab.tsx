import { useState, useEffect, useCallback } from 'react';
import { PackageCheck, Loader2, Plus, Pencil } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { FeatureTabProps } from './types';
import { FEATURE_META } from './types';
import { useFeatureLink } from './useFeatureLink';
import FeatureTabShell from './FeatureTabShell';
import { fetchWithAuth } from '../../../stores/auth';
import PatchAppRulesSection, { type PolicyAppRule } from './PatchAppRulesSection';
import { Dialog } from '../../shared/Dialog';
import UpdateRingForm, { type UpdateRingFormValues } from '../../patches/UpdateRingForm';
import type { UpdateRingItem as UpdateRing } from '../../patches/UpdateRingList';
import { normalizeRing } from '../../patches/patchHelpers';
import { showToast } from '../../shared/Toast';

type ScheduleFrequency = 'daily' | 'weekly' | 'monthly';
type RebootPolicy = 'never' | 'if_required' | 'always' | 'maintenance_window';
type PatchSourceOption = 'os' | 'third_party';
type PatchSeverity = 'critical' | 'important' | 'moderate' | 'low';

type PatchDeploymentSettings = {
  sources: PatchSourceOption[];
  autoApprove: boolean;
  autoApproveSeverities: PatchSeverity[];
  autoApproveDeferralDays: number;
  apps: PolicyAppRule[];
  scheduleFrequency: ScheduleFrequency;
  scheduleTime: string;
  scheduleDayOfWeek: string;
  scheduleDayOfMonth: number;
  rebootPolicy: RebootPolicy;
};

const defaults: PatchDeploymentSettings = {
  sources: ['os'],
  autoApprove: false,
  autoApproveSeverities: [],
  autoApproveDeferralDays: 0,
  apps: [],
  scheduleFrequency: 'weekly',
  scheduleTime: '02:00',
  scheduleDayOfWeek: 'sun',
  scheduleDayOfMonth: 1,
  rebootPolicy: 'if_required',
};

const OS_VALUE_ALIASES = new Set(['os', 'microsoft', 'apple', 'linux']);
const THIRD_PARTY_VALUE_ALIASES = new Set(['third_party', 'custom']);

function normalizeSources(raw: unknown): PatchSourceOption[] {
  if (!Array.isArray(raw)) return ['os'];
  const result: PatchSourceOption[] = [];
  if (raw.some((s) => typeof s === 'string' && OS_VALUE_ALIASES.has(s))) result.push('os');
  if (raw.some((s) => typeof s === 'string' && THIRD_PARTY_VALUE_ALIASES.has(s))) result.push('third_party');
  return result.length > 0 ? result : ['os'];
}

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
  const [ringsError, setRingsError] = useState<string>();

  const [settings, setSettings] = useState<PatchDeploymentSettings>(() => {
    const inline = effectiveLink?.inlineSettings as Partial<PatchDeploymentSettings> | undefined;
    return { ...defaults, ...inline, sources: normalizeSources(inline?.sources) };
  });
  const [validationError, setValidationError] = useState<string>();

  // Inline ring create/edit — the same editor as /patches, so an admin never
  // has to leave the policy to author the ring it links to.
  const [ringEditorOpen, setRingEditorOpen] = useState(false);
  const [ringEditorMode, setRingEditorMode] = useState<'create' | 'edit'>('create');
  const [ringSubmitting, setRingSubmitting] = useState(false);
  const [ringEditorError, setRingEditorError] = useState<string>();

  const fetchRings = useCallback(async () => {
    setRingsLoading(true);
    setRingsError(undefined);
    try {
      const response = await fetchWithAuth('/update-rings');
      // fetchWithAuth doesn't throw on 4xx/5xx — without this the picker would
      // silently show an empty list (indistinguishable from "no rings") and a
      // linked ring would blank out.
      if (!response.ok) throw new Error('Failed to load update rings');
      const payload = await response.json();
      const raw = Array.isArray(payload.data) ? payload.data : Array.isArray(payload) ? payload : [];
      // Normalize so the form hydrates with typed defaults (a ring whose
      // auto_approve JSONB is `{}` — the DB default / pre-#1317 rows — would
      // otherwise fail the editor's zod validation and silently refuse to save).
      setRings(raw.map((r: Record<string, unknown>) => normalizeRing(r)));
    } catch (err) {
      setRingsError(err instanceof Error ? err.message : 'Failed to load update rings');
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
      const inline = link.inlineSettings as Partial<PatchDeploymentSettings>;
      setSettings((prev) => ({ ...prev, ...inline, sources: normalizeSources(inline.sources) }));
    }
  }, [existingLink, parentLink]);

  const update = <K extends keyof PatchDeploymentSettings>(key: K, value: PatchDeploymentSettings[K]) =>
    setSettings((prev) => ({ ...prev, [key]: value }));

  // Client-side mirror of the server-side Zod checks so users get inline
  // feedback instead of a round-trip rejection.
  const validateSettings = (): string | null => {
    if (settings.apps.some((app) => app.action === 'pin' && !app.pinnedVersion?.trim())) {
      return 'Pinned applications need a version.';
    }
    return null;
  };

  const handleSave = async () => {
    clearError();
    const validation = validateSettings();
    setValidationError(validation ?? undefined);
    if (validation) return;
    const result = await save(existingLink?.id ?? null, {
      featureType: 'patch',
      featurePolicyId: selectedRingId || null,
      inlineSettings: settings,
    });
    // The save POST returned 201 with no UI feedback before — confirm success
    // (the hook surfaces failures via `error` → FeatureTabShell).
    if (result) {
      showToast({ message: 'Patch settings saved', type: 'success' });
      onLinkChanged(result, 'patch');
    }
  };

  const handleRemove = async () => {
    if (!existingLink) return;
    const ok = await remove(existingLink.id);
    if (ok) {
      showToast({ message: 'Patch settings removed', type: 'success' });
      onLinkChanged(null, 'patch');
    }
  };

  const handleOverride = async () => {
    clearError();
    const validation = validateSettings();
    setValidationError(validation ?? undefined);
    if (validation) return;
    const result = await save(null, {
      featureType: 'patch',
      featurePolicyId: selectedRingId || null,
      inlineSettings: settings,
    });
    if (result) {
      showToast({ message: 'Patch settings overridden', type: 'success' });
      onLinkChanged(result, 'patch');
    }
  };

  const handleRevert = async () => {
    if (!existingLink) return;
    const ok = await remove(existingLink.id);
    if (ok) {
      showToast({ message: 'Reverted to inherited patch settings', type: 'success' });
      onLinkChanged(null, 'patch');
    }
  };

  const selectedRing = rings.find((r) => r.id === selectedRingId);
  const meta = FEATURE_META.patch;

  const openCreateRing = () => {
    setRingEditorError(undefined);
    setRingEditorMode('create');
    setRingEditorOpen(true);
  };

  const openEditRing = () => {
    if (!selectedRing) return;
    setRingEditorError(undefined);
    setRingEditorMode('edit');
    setRingEditorOpen(true);
  };

  const handleRingEditorSubmit = async (values: UpdateRingFormValues) => {
    const editing = ringEditorMode === 'edit' && !!selectedRing;
    setRingSubmitting(true);
    setRingEditorError(undefined);
    try {
      const url = editing ? `/update-rings/${selectedRing!.id}` : '/update-rings';
      // runaction-exempt: inline ringEditorError UI (banner in the ring editor dialog)
      const response = await fetchWithAuth(url, {
        method: editing ? 'PATCH' : 'POST',
        body: JSON.stringify({
          name: values.name,
          description: values.description,
          ringOrder: values.ringOrder,
          deferralDays: values.deferralDays,
          deadlineDays: values.deadlineDays,
          gracePeriodHours: values.gracePeriodHours,
          autoApprove: values.autoApprove,
          categoryRules: values.categoryRules,
        }),
      });
      if (!response.ok) {
        throw new Error(editing ? 'Failed to update ring' : 'Failed to create update ring');
      }
      let createdId: string | undefined;
      try {
        const payload = await response.json();
        createdId = payload?.data?.id ?? payload?.id;
      } catch {
        // response body is optional for our purposes
      }
      await fetchRings();
      if (!editing && createdId) setSelectedRingId(createdId);
      setRingEditorOpen(false);
    } catch (err) {
      setRingEditorError(err instanceof Error ? err.message : 'Failed to save ring');
    } finally {
      setRingSubmitting(false);
    }
  };

  return (
    <FeatureTabShell
      title={meta.label}
      description={meta.description}
      icon={<PackageCheck className="h-5 w-5" />}
      isConfigured={!!existingLink || isInherited}
      saving={saving}
      error={validationError ?? error}
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
          <div className="mt-2 flex items-center gap-2">
            <select
              data-testid="approval-ring-select"
              value={selectedRingId}
              onChange={(e) => setSelectedRingId(e.target.value)}
              className="h-10 flex-1 rounded-md border bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
            >
              <option value="">No ring (manual approvals only)</option>
              {rings.map((ring) => (
                <option key={ring.id} value={ring.id}>
                  [{ring.ringOrder}] {ring.name}
                  {ring.deferralDays > 0 ? ` (${ring.deferralDays}d hold)` : ''}
                </option>
              ))}
            </select>
            {selectedRing && (
              <button
                type="button"
                onClick={openEditRing}
                className="inline-flex h-10 shrink-0 items-center gap-1.5 rounded-md border px-3 text-sm font-medium transition hover:bg-muted"
              >
                <Pencil className="h-3.5 w-3.5" />
                Edit
              </button>
            )}
            <button
              type="button"
              onClick={openCreateRing}
              className="inline-flex h-10 shrink-0 items-center gap-1.5 rounded-md border px-3 text-sm font-medium transition hover:bg-muted"
            >
              <Plus className="h-3.5 w-3.5" />
              New ring
            </button>
          </div>
        )}
        {ringsError && <p className="mt-2 text-xs text-destructive">{ringsError}</p>}
        {selectedRing && (
          <div className="mt-2 flex gap-4 text-xs text-muted-foreground">
            <span>Hold: {selectedRing.deferralDays === 0 ? 'None' : `${selectedRing.deferralDays}d`}</span>
            <span>Deadline: {selectedRing.deadlineDays == null ? 'None' : `${selectedRing.deadlineDays}d`}</span>
            <span>Reboot grace: {selectedRing.gracePeriodHours}h</span>
          </div>
        )}
      </div>

      <PatchAppRulesSection apps={settings.apps} onChange={(apps) => update('apps', apps)} />

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

      {/* Inline ring editor */}
      <Dialog
        open={ringEditorOpen}
        onClose={() => setRingEditorOpen(false)}
        title={ringEditorMode === 'edit' ? 'Edit update ring' : 'Create update ring'}
        maxWidth="2xl"
        alignTop
        className="flex max-h-[90vh] flex-col"
      >
        <div className="flex items-center justify-between border-b px-6 py-4">
          <h2 className="text-lg font-semibold">
            {ringEditorMode === 'edit' ? 'Edit update ring' : 'Create update ring'}
          </h2>
          <button
            type="button"
            aria-label="Close"
            onClick={() => setRingEditorOpen(false)}
            className="flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
          >
            &times;
          </button>
        </div>
        <div className="overflow-y-auto px-6 py-5">
          {ringEditorError && (
            <div className="mb-4 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
              {ringEditorError}
            </div>
          )}
          <UpdateRingForm
            key={ringEditorMode === 'edit' ? selectedRing?.id ?? 'edit' : 'new'}
            onSubmit={handleRingEditorSubmit}
            onCancel={() => setRingEditorOpen(false)}
            loading={ringSubmitting}
            submitLabel={ringEditorMode === 'edit' ? 'Save Changes' : 'Create Ring'}
            usage={ringEditorMode === 'edit' && selectedRing ? { deviceCount: selectedRing.deviceCount } : undefined}
            defaultValues={
              ringEditorMode === 'edit' && selectedRing
                ? {
                    name: selectedRing.name,
                    description: selectedRing.description ?? undefined,
                    ringOrder: selectedRing.ringOrder,
                    deferralDays: selectedRing.deferralDays,
                    deadlineDays: selectedRing.deadlineDays,
                    gracePeriodHours: selectedRing.gracePeriodHours,
                    autoApprove: selectedRing.autoApprove ?? { enabled: false, severities: [], deferralDays: 0 },
                    categoryRules: selectedRing.categoryRules,
                  }
                : undefined
            }
          />
        </div>
      </Dialog>
    </FeatureTabShell>
  );
}
