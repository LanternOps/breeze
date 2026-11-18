import { useEffect, useRef, useState } from 'react';
import { AlertTriangle, Cpu, Info, Layers } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import {
  OEM_CATEGORIES,
  OEM_DAYS_OF_WEEK,
  OEM_LANES,
  OEM_UPDATES_POLICY_DEFAULTS,
  OEM_WEEKS_OF_MONTH,
  oemUpdatesInlineSettingsSchema,
  type OemCategory,
  type OemLane,
  type OemUpdatesGateSnapshot,
} from '@breeze/shared';
import { fetchWithAuth } from '../../../stores/auth';
import type { FeatureTabProps } from './types';
import { useFeatureLink } from './useFeatureLink';
import FeatureTabShell from './FeatureTabShell';
import '@/lib/i18n';

// Inline settings for the `oem_updates` feature (Vendor updates, #11070): when
// Breeze runs each hardware vendor's own update tool, and which update
// categories it may install. The shared schema is the validator.
//
// Two rules from spec 4.1 shape this tab:
//  - A category is offered only once its rollout gate is open
//    (GET /configuration-policies/oem-updates/gates). A closed one renders
//    disabled with the reason and cannot be newly turned on. One already
//    stored true (its gate closed again after it was chosen) is shown as it is
//    stored and sent back unchanged: the API accepts that, and the dispatch
//    seam re-checks every gate. Saving waits for the gates, so a failed read
//    can never rewrite what is stored.
//  - Opening a gate turns nothing on. A link that never set a now-open
//    category shows "now available" and keeps it off until a person turns it on.
// Turning updates on, or adding a category, needs devices.execute + MFA; the API
// decides and this tab explains its refusal.

const VENDOR_NAMES: Record<OemLane, string> = {
  dell: 'Dell',
  surface: 'Microsoft Surface',
  hp: 'HP',
  lenovo: 'Lenovo',
};

const EXECUTE_REQUIRED = 'oem_updates_execute_required';
const GATE_CLOSED = 'oem_updates_category_gate_closed';
const GATES_URL = '/configuration-policies/oem-updates/gates';

type Categories = Partial<Record<OemCategory, boolean>>;
type VendorState = { present: boolean; enabled: boolean; categories: Categories; blocked: string };
type FormState = {
  enabled: boolean;
  weekOfMonth: string;
  dayOfWeek: string;
  windowStart: string;
  windowHours: string;
  catchUpNights: string;
  reboot: string;
  vendors: Record<OemLane, VendorState>;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

/** Reads a stored blob defensively: anything malformed falls back to the defaults, then the schema reports it. */
function readForm(raw: unknown): FormState {
  const settings = isRecord(raw) ? raw : {};
  const schedule = isRecord(settings.schedule) ? settings.schedule : {};
  const defaults = OEM_UPDATES_POLICY_DEFAULTS;
  const vendorsRaw = isRecord(settings.vendors) ? settings.vendors : {};
  const vendors = {} as Record<OemLane, VendorState>;
  for (const lane of OEM_LANES) {
    const vendor = isRecord(vendorsRaw[lane]) ? vendorsRaw[lane] : null;
    const categoriesRaw = vendor && isRecord(vendor.categories) ? vendor.categories : {};
    const categories: Categories = {};
    for (const category of OEM_CATEGORIES) {
      if (typeof categoriesRaw[category] === 'boolean') categories[category] = categoriesRaw[category] as boolean;
    }
    const ids = vendor && Array.isArray(vendor.blockedUpdateIds) ? vendor.blockedUpdateIds : [];
    vendors[lane] = {
      present: !!vendor,
      enabled: vendor?.enabled === true,
      categories,
      blocked: ids.filter((id): id is string => typeof id === 'string').join(', '),
    };
  }
  const text = (value: unknown, fallback: string | number) =>
    typeof value === 'string' || typeof value === 'number' ? String(value) : String(fallback);
  return {
    enabled: settings.enabled === true,
    weekOfMonth: text(schedule.weekOfMonth, defaults.schedule.weekOfMonth),
    dayOfWeek: text(schedule.dayOfWeek, defaults.schedule.dayOfWeek),
    windowStart: text(schedule.windowStart, defaults.schedule.windowStart),
    windowHours: text(schedule.windowHours, defaults.schedule.windowHours),
    catchUpNights: text(settings.catchUpNights, defaults.catchUpNights),
    reboot: text(settings.reboot, defaults.reboot),
    vendors,
  };
}

/** Accepts only the documented snapshot shape; anything else counts as "every gate closed". */
function readGates(body: unknown): OemUpdatesGateSnapshot | null {
  const data = isRecord(body) ? body.data : undefined;
  if (!isRecord(data) || !Array.isArray(data.lanes)) return null;
  const lanes = data.lanes.flatMap((entry) => {
    if (!isRecord(entry) || !(OEM_LANES as readonly unknown[]).includes(entry.lane) || !isRecord(entry.categories)) return [];
    const categories = entry.categories;
    return [{
      lane: entry.lane as OemLane,
      shipped: entry.shipped === true,
      categories: Object.fromEntries(OEM_CATEGORIES.map((c) => [c, categories[c] === true])) as Record<OemCategory, boolean>,
    }];
  });
  return { lanes };
}

const toNumber = (value: string) => (value.trim() === '' ? Number.NaN : Number(value));

export default function VendorUpdatesTab({
  policyId,
  existingLink,
  parentLink,
  linkedPolicyId,
  onLinkChanged,
  orgId,
}: FeatureTabProps) {
  const { t } = useTranslation('policies');
  const k = (key: string, opts?: Record<string, unknown>) =>
    t(/* i18n-dynamic */ `configurationPolicies.featureTabs.vendorUpdatesTab.${key}`, opts);
  const { save, remove, saving, error, errorDetail, clearError } = useFeatureLink(policyId);

  const source = (existingLink ?? parentLink)?.inlineSettings;
  const isNew = !existingLink && !parentLink;
  const [form, setForm] = useState<FormState>(() => readForm(source));
  const [attempted, setAttempted] = useState(false);
  const [gates, setGates] = useState<OemUpdatesGateSnapshot | null>(null);
  const [gatesFailed, setGatesFailed] = useState(false);
  const preselected = useRef(false);

  useEffect(() => {
    setForm(readForm((existingLink ?? parentLink)?.inlineSettings));
    setAttempted(false);
  }, [existingLink, parentLink]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetchWithAuth(GATES_URL);
        const snapshot = res.ok ? readGates(await res.json()) : null;
        if (cancelled) return;
        if (snapshot) setGates(snapshot);
        else setGatesFailed(true);
      } catch {
        if (!cancelled) setGatesFailed(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const laneGates = (lane: OemLane) => gates?.lanes.find((l) => l.lane === lane);
  const isOpen = (lane: OemLane, category: OemCategory) => laneGates(lane)?.categories[category] === true;
  const isShipped = (lane: OemLane) => laneGates(lane)?.shipped === true;

  // A new policy preselects Dell plus the categories open today (spec 4.1). Once.
  useEffect(() => {
    if (!gates || !isNew || preselected.current) return;
    preselected.current = true;
    setForm((prev) => {
      const vendors = { ...prev.vendors };
      for (const { lane, shipped, categories } of gates.lanes) {
        if (lane !== 'dell' || !shipped) continue;
        const open: Categories = {};
        for (const category of OEM_CATEGORIES) if (categories[category]) open[category] = true;
        vendors[lane] = { ...vendors[lane], present: true, enabled: true, categories: open };
      }
      return { ...prev, vendors };
    });
  }, [gates, isNew]);

  const inherited = !!parentLink && !existingLink;
  const partnerWide = orgId === null;
  // What the resolver will make of the stored link: one that no longer parses resolves as disabled.
  const storedInvalid = source != null && !oemUpdatesInlineSettingsSchema.safeParse(source).success;
  const anyOpen = !!gates?.lanes.some((l) => OEM_CATEGORIES.some((c) => l.categories[c]));

  const buildSettings = () => {
    const vendors: Record<string, unknown> = {};
    for (const lane of OEM_LANES) {
      const vendor = form.vendors[lane];
      if (!vendor.present && !vendor.enabled) continue;
      const categories: Categories = {};
      for (const category of OEM_CATEGORIES) {
        const value = vendor.categories[category];
        if (value === undefined) continue;
        categories[category] = value;
      }
      const blockedUpdateIds = Array.from(new Set(vendor.blocked.split(/[\s,]+/).map((id) => id.trim()).filter(Boolean)));
      vendors[lane] = { enabled: vendor.enabled, categories, blockedUpdateIds };
    }
    return {
      version: 1,
      enabled: form.enabled,
      schedule: {
        weekOfMonth: form.weekOfMonth,
        dayOfWeek: form.dayOfWeek,
        windowStart: form.windowStart,
        windowHours: toNumber(form.windowHours),
      },
      catchUpNights: toNumber(form.catchUpNights),
      reboot: form.reboot,
      vendors,
    };
  };

  const parsed = oemUpdatesInlineSettingsSchema.safeParse(buildSettings());

  const persist = async (id: string | null) => {
    setAttempted(true);
    if (!parsed.success) return;
    clearError();
    const result = await save(id, { featureType: 'oem_updates', featurePolicyId: null, inlineSettings: parsed.data });
    if (result) onLinkChanged(result, 'oem_updates');
  };
  const discard = async () => {
    if (existingLink && (await remove(existingLink.id))) onLinkChanged(null, 'oem_updates');
  };

  const setVendor = (lane: OemLane, patch: Partial<VendorState>) =>
    setForm((prev) => ({ ...prev, vendors: { ...prev.vendors, [lane]: { ...prev.vendors[lane], present: true, ...patch } } }));

  const code = errorDetail?.code;
  const handledError = code === EXECUTE_REQUIRED || code === GATE_CLOSED;
  const controlClass =
    'mt-1 h-9 w-full rounded-md border bg-background px-2 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring disabled:opacity-60';
  const labelClass = 'text-xs font-medium text-muted-foreground';

  return (
    <FeatureTabShell
      title={k('title')}
      description={k('description')}
      icon={<Cpu className="h-5 w-5" />}
      isConfigured={!!existingLink || inherited}
      configuredButInactive={!form.enabled}
      saving={saving}
      saveTestId="vendor-updates-save"
      // No save until the gates are known: the form could not tell a stored category from a closed one.
      saveDisabled={!gates || (inherited && !parsed.success)}
      error={handledError ? undefined : error}
      onSave={() => void persist(existingLink?.id ?? null)}
      onRemove={existingLink && !linkedPolicyId ? discard : undefined}
      isInherited={inherited}
      onOverride={inherited ? () => void persist(null) : undefined}
      onRevert={!inherited && !!linkedPolicyId && !!existingLink ? discard : undefined}
    >
      {partnerWide && (
        <span
          data-testid="vendor-updates-partner-wide-badge"
          className="mb-4 inline-flex items-center gap-1 rounded-full border border-primary/30 bg-primary/10 px-2 py-0.5 text-xs font-medium text-primary"
        >
          <Layers className="h-3 w-3" />
          {k('partnerWideBadge')}
        </span>
      )}

      {code === EXECUTE_REQUIRED && (
        <div role="alert" data-testid="vendor-updates-execute-required" className="mb-4 flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          <p>{k('executeRequired')}</p>
        </div>
      )}
      {code === GATE_CLOSED && (
        <div role="alert" data-testid="vendor-updates-gate-closed" className="mb-4 flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          <p>{k('gateClosedRefusal')}</p>
        </div>
      )}
      {storedInvalid && (
        <div role="alert" data-testid="vendor-updates-stored-invalid" className="mb-4 flex items-start gap-2 rounded-md border border-amber-500/30 bg-amber-500/10 p-3 text-sm text-amber-800 dark:text-amber-300">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          <p>{k('storedInvalid')}</p>
        </div>
      )}
      {attempted && !parsed.success && !inherited && (
        <div role="alert" data-testid="vendor-updates-invalid" className="mb-4 flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          <p>{k('invalid')}</p>
        </div>
      )}
      {gatesFailed && (
        <div role="alert" data-testid="vendor-updates-gates-error" className="mb-4 flex items-start gap-2 rounded-md border border-amber-500/30 bg-amber-500/10 p-3 text-sm text-amber-800 dark:text-amber-300">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          <p>{k('gatesError')}</p>
        </div>
      )}
      {gates && !anyOpen && (
        <div data-testid="vendor-updates-still-gated" className="mb-4 flex items-start gap-2 rounded-md bg-muted/50 p-3 text-xs text-muted-foreground">
          <Info className="mt-0.5 h-4 w-4 shrink-0" />
          <p>{k('stillGated')}</p>
        </div>
      )}

      <fieldset disabled={inherited || saving} className="space-y-6">
        <label className="flex items-start gap-2 text-sm font-medium">
          <input
            data-testid="vendor-updates-enabled"
            type="checkbox"
            role="switch"
            className="mt-1"
            checked={form.enabled}
            onChange={(e) => setForm((prev) => ({ ...prev, enabled: e.target.checked }))}
          />
          <span>
            {k('enabled')}
            <span className="block text-xs font-normal text-muted-foreground">{k('enabledHelp')}</span>
          </span>
        </label>

        <section>
          <h4 className="mb-2 text-sm font-semibold">{k('scheduleHeading')}</h4>
          <div className="grid gap-3 sm:grid-cols-3">
            <label className={labelClass}>
              {k('weekOfMonth')}
              <select data-testid="vendor-updates-week" className={controlClass} value={form.weekOfMonth}
                onChange={(e) => setForm((prev) => ({ ...prev, weekOfMonth: e.target.value }))}>
                {OEM_WEEKS_OF_MONTH.map((week) => (
                  <option key={week} value={week}>{k(`weeks.${week}`)}</option>
                ))}
              </select>
            </label>
            <label className={labelClass}>
              {k('dayOfWeek')}
              <select data-testid="vendor-updates-day" className={controlClass} value={form.dayOfWeek}
                onChange={(e) => setForm((prev) => ({ ...prev, dayOfWeek: e.target.value }))}>
                {OEM_DAYS_OF_WEEK.map((day) => (
                  <option key={day} value={day}>{k(`days.${day}`)}</option>
                ))}
              </select>
            </label>
            <label className={labelClass}>
              {k('windowStart')}
              <input data-testid="vendor-updates-window-start" type="time" className={controlClass} value={form.windowStart}
                onChange={(e) => setForm((prev) => ({ ...prev, windowStart: e.target.value }))} />
            </label>
            <label className={labelClass}>
              {k('windowHours')}
              <input data-testid="vendor-updates-window-hours" type="number" min={1} max={8} step={1} className={controlClass}
                value={form.windowHours} onChange={(e) => setForm((prev) => ({ ...prev, windowHours: e.target.value }))} />
            </label>
            <label className={labelClass}>
              {k('catchUpNights')}
              <input data-testid="vendor-updates-catch-up" type="number" min={0} max={14} step={1} className={controlClass}
                value={form.catchUpNights} onChange={(e) => setForm((prev) => ({ ...prev, catchUpNights: e.target.value }))} />
            </label>
            <label className={labelClass}>
              {k('reboot')}
              <select data-testid="vendor-updates-reboot" className={controlClass} value={form.reboot}
                onChange={(e) => setForm((prev) => ({ ...prev, reboot: e.target.value }))}>
                <option value="overnight">{k('rebootOvernight')}</option>
                <option value="never">{k('rebootNever')}</option>
              </select>
            </label>
          </div>
          <p className="mt-2 text-xs text-muted-foreground">{k('scheduleHelp')}</p>
          {form.reboot === 'never' && (
            <p data-testid="vendor-updates-reboot-never-note" className="mt-1 text-xs text-muted-foreground">{k('rebootNeverHelp')}</p>
          )}
        </section>

        <section className="space-y-3">
          <h4 className="text-sm font-semibold">{k('vendorsHeading')}</h4>
          {OEM_LANES.map((lane) => {
            const vendor = form.vendors[lane];
            const shipped = isShipped(lane);
            return (
              <div key={lane} data-testid={`vendor-updates-vendor-${lane}`} className="rounded-md border p-3">
                <label className="flex items-center gap-2 text-sm font-medium">
                  <input
                    data-testid={`vendor-updates-${lane}-enabled`}
                    type="checkbox"
                    role="switch"
                    checked={vendor.enabled}
                    disabled={!shipped && !vendor.enabled}
                    onChange={(e) => setVendor(lane, { enabled: e.target.checked })}
                  />
                  {k('vendorEnabled', { vendor: VENDOR_NAMES[lane] })}
                  {gates && !shipped && (
                    <span data-testid={`vendor-updates-${lane}-not-shipped`} className="rounded-full bg-muted px-2 py-0.5 text-xs font-normal text-muted-foreground">
                      {k('notShipped')}
                    </span>
                  )}
                </label>
                {(shipped || vendor.present) && (
                  <div className="mt-3 space-y-2 pl-6">
                    {OEM_CATEGORIES.map((category) => {
                      const open = isOpen(lane, category);
                      const value = vendor.categories[category];
                      const nowAvailable = open && !isNew && value === undefined;
                      return (
                        <div key={category}>
                          <label className="flex items-center gap-2 text-sm">
                            <input
                              data-testid={`vendor-updates-${lane}-${category}`}
                              type="checkbox"
                              checked={value === true}
                              disabled={!open}
                              onChange={(e) => setVendor(lane, { categories: { ...vendor.categories, [category]: e.target.checked } })}
                            />
                            {k(`categories.${category}`)}
                          </label>
                          {!open && (
                            <p data-testid={`vendor-updates-${lane}-${category}-closed`} className="pl-6 text-xs text-muted-foreground">
                              {k('categoryClosed')}
                            </p>
                          )}
                          {nowAvailable && (
                            <p data-testid={`vendor-updates-${lane}-${category}-now-available`} className="pl-6 text-xs text-primary">
                              {k('nowAvailable')}
                            </p>
                          )}
                        </div>
                      );
                    })}
                    <label className={`block ${labelClass}`}>
                      {k('blockedLabel')}
                      <textarea
                        data-testid={`vendor-updates-${lane}-blocked`}
                        rows={2}
                        className="mt-1 w-full rounded-md border bg-background px-2 py-1 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring disabled:opacity-60"
                        value={vendor.blocked}
                        placeholder={k('blockedPlaceholder')}
                        onChange={(e) => setVendor(lane, { blocked: e.target.value })}
                      />
                      <span className="mt-1 block font-normal">{k('blockedHelp')}</span>
                    </label>
                  </div>
                )}
              </div>
            );
          })}
        </section>
      </fieldset>

      <div data-testid="vendor-updates-arming-notice" className="mt-4 flex items-start gap-2 rounded-md bg-muted/50 p-3 text-xs text-muted-foreground">
        <Info className="mt-0.5 h-4 w-4 shrink-0" />
        <p>{k('armingNotice')}</p>
      </div>
    </FeatureTabShell>
  );
}
