import { useEffect, useState } from 'react';
import { Trans, useTranslation } from 'react-i18next';
import '@/lib/i18n';
import { fetchWithAuth } from '@/stores/auth';
import { KeyRound, Layers, RefreshCcw, Save, ShieldCheck, Sparkles } from 'lucide-react';
import AgentVersionPinSelectors, {
  type PinnableVersions,
  type AgentVersionPinsValue,
} from './AgentVersionPinSelectors';
import type { InheritableDefaultSettings } from '@breeze/shared';
import {
  MAINTENANCE_WINDOW_ALWAYS,
  MAINTENANCE_DAYS,
  ENROLLMENT_TTL_I18N_KEYS,
  MAX_ENROLLMENT_DEVICE_COUNT,
  MAX_ENROLLMENT_TTL_MINUTES,
  enrollmentTtlOptionsIncluding,
  isValidMaintenanceWindow,
  parseMaintenanceWindow,
  formatMaintenanceWindow,
  minutesToHHMM,
} from '@breeze/shared';

type WindowMode = 'always' | 'window';

type WindowState = { mode: WindowMode; day: string; start: string; end: string };

// Derive the structured editor state from the stored maintenance-window string.
// The "always/24/7/empty" state maps to mode 'always'; a valid window unpacks
// into day + start + end. A legacy malformed value falls back to the always
// state — that matches its actual runtime behavior (the gate fails open on an
// unparseable window), so a careless Save preserves "update anytime" rather than
// silently flipping the org into a restrictive 02:00-04:00 window it never had.
function deriveWindowState(raw: string | undefined): WindowState {
  const parsed = parseMaintenanceWindow(raw);
  if (parsed) {
    return {
      mode: 'window',
      day: parsed.day === null ? '' : MAINTENANCE_DAYS[parsed.day],
      start: minutesToHHMM(parsed.startMin),
      end: minutesToHHMM(parsed.endMin),
    };
  }
  // Always-state and malformed both land here as 'always' (seeded window times
  // are only used if the operator switches to the window mode).
  return { mode: 'always', day: '', start: '02:00', end: '04:00' };
}

// The shape of `organizations.settings.defaults`. This deliberately ALIASES the
// shared type rather than restating it. Add new editable fields to
// InheritableDefaultSettings in packages/shared, to EditableField below, and to
// the `current` map in handleSave — never re-fork this type.
type DefaultsData = InheritableDefaultSettings;

// The fields this form edits. Save writes ONLY the fields the admin changed or
// reset (issue #9945): everything else is passed through exactly as stored, so
// a field the org never set keeps inheriting instead of being materialised as
// an explicit override of whatever the control happened to display.
type EditableField =
  | 'policyDefaults'
  | 'deviceGroup'
  | 'autoEnrollment'
  | 'agentUpdatePolicy'
  | 'maintenanceWindow'
  | 'agentVersionPins'
  | 'defaultEnrollmentTtlMinutes'
  | 'defaultEnrollmentDeviceCount';

// 'set' = write the control's current value; 'clear' = drop the org's override
// so the field inherits again ("Reset to default").
type FieldEdit = 'set' | 'clear';

type OrgDefaultsEditorProps = {
  organizationName: string;
  // Needed to list the org's real device groups for the default-group picker
  // (#9617). Without it the picker is empty (only "None").
  organizationId?: string;
  defaults?: DefaultsData;
  onDirty?: () => void;
  onSave?: (data: DefaultsData) => void;
  // Issue #2124: the registered versions to offer plus the partner's effective
  // pins to show as the inherited default. Pins are inherit-with-override, so
  // there is no lock — an org pin always overrides the partner default.
  pinnableVersions?: PinnableVersions | null;
  partnerPins?: AgentVersionPinsValue;
  // Issue #2752: dot-path fields the partner has locked (e.g. "defaults.deviceGroup"),
  // straight from GET /organizations/:id/effective-settings, plus the merged
  // `defaults` category those locks resolve to. This editor was the only org
  // settings editor with no lock awareness, which is why a partner-set field
  // 403'd every save in this category.
  locked?: string[];
  effectiveDefaults?: DefaultsData;
  // Issue #2776: the partner's enrollment-link lifetime cap, shown read-only.
  // The cap is partner-only — an org can never edit it here (see below).
  partnerMaxEnrollmentTtlMinutes?: number;
};

// Lockable `defaults` fields. `agentVersionPins` is deliberately absent: it is
// INHERIT-WITH-OVERRIDE, not partner-locked (issue #2124); a partner pin is
// reported in the effective-settings `partnerDefaults` list, not in `locked` (#9762).
const LOCKABLE_FIELDS = [
  'policyDefaults',
  'autoEnrollment',
  'agentUpdatePolicy',
  'maintenanceWindow',
] as const;

// `maxEnrollmentLinkTtlMinutes` is not an editable field of this form (the cap
// is partner-only, surfaced as a read-only notice — issue #2776), but it does
// arrive via `locked`, so the lock helper must accept it alongside the
// seedable editor fields.
type LockableField = (typeof LOCKABLE_FIELDS)[number] | 'maxEnrollmentLinkTtlMinutes';

// Section titles that name each field in its "Reset to default" button label.
const INHERITANCE_TITLE_KEYS: Record<(typeof LOCKABLE_FIELDS)[number], string> = {
  policyDefaults: 'orgDefaultsEditor.policies.title',
  autoEnrollment: 'orgDefaultsEditor.autoEnrollment.title',
  agentUpdatePolicy: 'orgDefaultsEditor.agentUpdates.title',
  maintenanceWindow: 'orgDefaultsEditor.maintenance.title',
};

const defaultValues: DefaultsData = {
  policyDefaults: {
    deviceCompliance: 'balanced',
    dataProtection: 'strict',
    accessControl: 'standard'
  },
  autoEnrollment: {
    enabled: true,
    requireApproval: false
  },
  // The UI exposes only "Automatic" and "Manual" — the legacy 'staged' value is
  // behaviourally identical to 'auto' (both are gated by the maintenance window;
  // there is no rings/canaries machinery behind it — see issue #1962), so we
  // default unconfigured orgs to 'auto' and fold any stored 'staged' into it on
  // load (the backend still accepts 'staged' for back-compat).
  agentUpdatePolicy: 'auto',
  // Default to the explicit "always" state so an unconfigured org matches the
  // backend's permissive default (auto + no window = update anytime) instead
  // of silently committing to a Sunday window the first time defaults are saved.
  maintenanceWindow: MAINTENANCE_WINDOW_ALWAYS
};

const policyOptions = [
  { value: 'strict', labelKey: 'orgDefaultsEditor.policies.options.strict' },
  { value: 'balanced', labelKey: 'orgDefaultsEditor.policies.options.balanced' },
  { value: 'standard', labelKey: 'orgDefaultsEditor.policies.options.standard' },
  { value: 'lenient', labelKey: 'orgDefaultsEditor.policies.options.lenient' },
];

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
type StaticGroup = { id: string; name: string };
const policyFields = [
  { id: 'deviceCompliance', labelKey: 'orgDefaultsEditor.policies.fields.deviceCompliance' },
  { id: 'dataProtection', labelKey: 'orgDefaultsEditor.policies.fields.dataProtection' },
  { id: 'accessControl', labelKey: 'orgDefaultsEditor.policies.fields.accessControl' },
];
const maintenanceDays = MAINTENANCE_DAYS.map(day => ({
  value: day,
  labelKey: `orgDefaultsEditor.maintenance.days.${day.toLowerCase()}`,
}));

export default function OrgDefaultsEditor({
  organizationName,
  organizationId,
  defaults,
  onDirty,
  onSave,
  pinnableVersions,
  partnerPins,
  locked,
  effectiveDefaults,
  partnerMaxEnrollmentTtlMinutes,
}: OrgDefaultsEditorProps) {
  const { t } = useTranslation('settings');
  // Matches the isLocked helper in OrgSecuritySettings / OrgNotificationSettings /
  // OrgEventLogSettings / OrgBrandingEditor (issue #2752 — this editor was missed).
  const isLocked = (field: LockableField) => locked?.includes(`defaults.${field}`) ?? false;

  // A locked field's effective value IS the partner's, so seed the control from it
  // rather than from the org's own (inert) value or the hard-coded default. That
  // way the disabled control shows what is actually in force.
  const lockedSeed: DefaultsData = {};
  if (effectiveDefaults) {
    if (isLocked('policyDefaults') && effectiveDefaults.policyDefaults) lockedSeed.policyDefaults = effectiveDefaults.policyDefaults;
    if (isLocked('autoEnrollment') && effectiveDefaults.autoEnrollment) lockedSeed.autoEnrollment = effectiveDefaults.autoEnrollment;
    if (isLocked('agentUpdatePolicy') && effectiveDefaults.agentUpdatePolicy !== undefined) lockedSeed.agentUpdatePolicy = effectiveDefaults.agentUpdatePolicy;
    if (isLocked('maintenanceWindow') && effectiveDefaults.maintenanceWindow !== undefined) lockedSeed.maintenanceWindow = effectiveDefaults.maintenanceWindow;
  }
  const initialData = { ...defaultValues, ...defaults, ...lockedSeed };
  // Version pins are inherit-with-override (issue #2124): the org can always set
  // its own, which overrides the partner default. No lock.
  const [agentVersionPins, setAgentVersionPins] = useState<AgentVersionPinsValue>(
    initialData.agentVersionPins ?? {},
  );
  const [policyDefaults, setPolicyDefaults] = useState(initialData.policyDefaults || defaultValues.policyDefaults!);
  // #9617: a real device_groups.id, or '' for none. Legacy stored display strings
  // ("Contractors") are not ids and are treated as unset, matching enrollment.
  const [deviceGroup, setDeviceGroup] = useState(
    initialData.deviceGroup && UUID_RE.test(initialData.deviceGroup) ? initialData.deviceGroup : '',
  );
  const [staticGroups, setStaticGroups] = useState<StaticGroup[]>([]);
  useEffect(() => {
    if (!organizationId) return;
    let alive = true;
    void (async () => {
      try {
        const res = await fetchWithAuth(`/device-groups?orgId=${organizationId}&limit=200`);
        if (!res.ok) return;
        const body = await res.json();
        if (!alive) return;
        const items: Array<{ id: string; name: string; type?: string }> = Array.isArray(body.data) ? body.data : [];
        setStaticGroups(items.filter(g => g.type === 'static').map(g => ({ id: g.id, name: g.name })));
      } catch {
        // Picker stays at "None"; a failed list must not break the settings page.
      }
    })();
    return () => { alive = false; };
  }, [organizationId]);
  const [autoEnrollment, setAutoEnrollment] = useState(initialData.autoEnrollment || defaultValues.autoEnrollment!);
  // Fold the legacy 'staged' value into 'auto' (identical behaviour; see #1962)
  // so the select shows a valid selection rather than falling back to no match.
  const [agentUpdatePolicy, setAgentUpdatePolicy] = useState(
    (initialData.agentUpdatePolicy ?? defaultValues.agentUpdatePolicy!) === 'staged'
      ? 'auto'
      : initialData.agentUpdatePolicy || defaultValues.agentUpdatePolicy!
  );
  const initialWindow = deriveWindowState(initialData.maintenanceWindow);
  // A stored value that is neither the always-state nor a parseable window was
  // silently reset to seeded defaults by deriveWindowState. Surface that so the
  // operator knows their previous config was invalid and being ignored.
  const storedWindowInvalid =
    typeof initialData.maintenanceWindow === 'string' &&
    initialData.maintenanceWindow.trim() !== '' &&
    !isValidMaintenanceWindow(initialData.maintenanceWindow);
  // Issue #2776: both VALUES are inherit-with-override — `undefined` means "no
  // org override, follow the partner", so they are deliberately absent from
  // `defaultValues` (seeding one would silently pin this org to the product
  // default the first time defaults are saved).
  const [enrollmentTtlMinutes, setEnrollmentTtlMinutes] = useState<number | undefined>(
    initialData.defaultEnrollmentTtlMinutes,
  );
  const [enrollmentDeviceCount, setEnrollmentDeviceCount] = useState<number | undefined>(
    initialData.defaultEnrollmentDeviceCount,
  );
  const [windowMode, setWindowMode] = useState<WindowMode>(initialWindow.mode);
  const [windowDay, setWindowDay] = useState(initialWindow.day);
  const [windowStart, setWindowStart] = useState(initialWindow.start);
  const [windowEnd, setWindowEnd] = useState(initialWindow.end);

  // Canonical value to persist; null when the window inputs are invalid
  // (e.g. start === end). 'always' always resolves to the durable sentinel.
  const builtWindow =
    windowMode === 'always'
      ? MAINTENANCE_WINDOW_ALWAYS
      : formatMaintenanceWindow(windowDay || null, windowStart, windowEnd);
  const windowError =
    windowMode === 'window' && !builtWindow
      ? t('orgDefaultsEditor.maintenance.errors.invalidWindow')
      : null;

  // The partner cap is surfaced read-only: an org that could raise it wouldn't
  // be capped at all. `locked` carries `defaults.maxEnrollmentLinkTtlMinutes`
  // whenever the partner set one; the effective value may lag it by a fetch, so
  // an unknown value still renders the (valueless) notice rather than nothing.
  const showEnrollmentCap =
    isLocked('maxEnrollmentLinkTtlMinutes') || typeof partnerMaxEnrollmentTtlMinutes === 'number';
  const formatTtlMinutes = (minutes: number): string =>
    ENROLLMENT_TTL_I18N_KEYS[minutes]
      ? t(/* i18n-dynamic */ `devices:${ENROLLMENT_TTL_I18N_KEYS[minutes]}`)
      : t('orgDefaultsEditor.enrollment.capMinutes', { minutes });

  // Only lifetimes at or below the partner cap are SELECTABLE: picking "7 days"
  // under a 1-hour cap would promise a lifetime the resolver clamps away.
  //
  // But an ALREADY-STORED value above the cap is included as its own option, so
  // the select shows what is actually stored. It is deliberately not rewritten:
  // `defaultEnrollmentTtlMinutes` is lock-exempt, resolveEnrollmentDefaults
  // clamps it on every read, and handleSave below rebuilds the WHOLE defaults
  // blob — so clamping here would let someone editing their maintenance window
  // silently and irreversibly destroy an enrollment preference they never
  // touched, with no way back if the partner later raises the cap.
  const ttlOptions = enrollmentTtlOptionsIncluding(
    partnerMaxEnrollmentTtlMinutes ?? MAX_ENROLLMENT_TTL_MINUTES,
    enrollmentTtlMinutes,
  );

  const markDirty = () => {
    onDirty?.();
  };

  // Per-field edit intent (issue #9945). A field absent from this map is
  // untouched and is saved exactly as stored — or not at all if the org never
  // set it. Two stored values the runtime already ignores start as 'clear', so
  // saving drops them instead of writing the displayed fallback as a new
  // override: an invalid window (fails open to "anytime", which is what the
  // control shows) and a legacy display-string device group (not an id, so
  // enrollment treats it as unset — #9617).
  const [edits, setEdits] = useState<Partial<Record<EditableField, FieldEdit>>>(() => {
    const initial: Partial<Record<EditableField, FieldEdit>> = {};
    if (storedWindowInvalid && !isLocked('maintenanceWindow')) initial.maintenanceWindow = 'clear';
    if (defaults?.deviceGroup !== undefined && !UUID_RE.test(String(defaults.deviceGroup))) initial.deviceGroup = 'clear';
    return initial;
  });
  const editField = (field: EditableField) => {
    setEdits(prev => ({ ...prev, [field]: 'set' }));
    markDirty();
  };
  const hasOwnValue = (field: EditableField): boolean =>
    edits[field] === 'set' || (edits[field] !== 'clear' && defaults?.[field] !== undefined);

  // "Reset to default": drop the org override and show the inherited value. A
  // partner-set value for these fields is a lock (the control is disabled and
  // this is never offered), so the inherited value is the product default.
  const resetField = (field: Extract<EditableField, LockableField>) => {
    if (field === 'policyDefaults') setPolicyDefaults(defaultValues.policyDefaults!);
    if (field === 'autoEnrollment') setAutoEnrollment(defaultValues.autoEnrollment!);
    if (field === 'agentUpdatePolicy') setAgentUpdatePolicy(defaultValues.agentUpdatePolicy!);
    if (field === 'maintenanceWindow') setWindowMode('always');
    setEdits(prev => ({ ...prev, [field]: 'clear' }));
    markDirty();
  };

  // Granularity is the whole field, not each sub-control: editing one policy
  // select or one auto-enrollment checkbox writes that field's full object,
  // because the partner lock and the resolvers treat each field as one unit.
  const renderInheritance = (field: Extract<EditableField, LockableField>) => {
    if (isLocked(field)) return null; // "Managed by partner" already says where it comes from
    const own = hasOwnValue(field);
    return (
      <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
        {/* Live region: Reset unmounts its own button, so announce the new state. */}
        <span role="status" data-testid={`defaults-source-${field}`}>
          {own ? t('orgDefaultsEditor.inheritance.overridden') : t('orgDefaultsEditor.inheritance.inherited')}
        </span>
        {own && (
          <button
            type="button"
            onClick={() => resetField(field)}
            aria-label={t('orgDefaultsEditor.inheritance.resetLabel', {
              setting: t(/* i18n-dynamic */ INHERITANCE_TITLE_KEYS[field]),
            })}
            data-testid={`defaults-reset-${field}`}
            className="font-medium text-primary underline-offset-2 hover:underline"
          >
            {t('orgDefaultsEditor.inheritance.reset')}
          </button>
        )}
      </div>
    );
  };

  // If the stored window was invalid, the editor is already showing a corrected
  // value — mark the form dirty on mount so saving actually persists the fix.
  // Mount-only: intentionally empty deps (onDirty/storedWindowInvalid are stable
  // for the editor's lifetime).
  useEffect(() => {
    if (storedWindowInvalid) onDirty?.();
  }, []);

  const handleSave = () => {
    if (windowError || !builtWindow) return; // never persist an invalid window
    // Start from what the org stored, so untouched fields (including ones this
    // form does not know about) are written back exactly as they were.
    //
    // maxEnrollmentLinkTtlMinutes is the one exception. It is a partner-only
    // ceiling: the resolver ignores an org-set value, and the org PATCH rejects
    // it with 403 once the partner has set one. Dropping it both clears any
    // stale org-stored cap and keeps Save from 403ing.
    const { maxEnrollmentLinkTtlMinutes: _staleCap, ...stored } = defaults ?? {};
    const data: Record<string, unknown> = { ...stored };
    // Values the controls currently hold. `undefined` means "no override":
    // the key is removed, which is what "inherit" means to the resolvers (they
    // key on presence, not value).
    //
    // The enrollment TTL is persisted verbatim, never clamped to the partner
    // cap: resolveEnrollmentDefaults applies the cap at read time and the
    // select shows the stored value honestly (see ttlOptions above).
    const current: Record<EditableField, unknown> = {
      policyDefaults,
      deviceGroup: deviceGroup || undefined,
      autoEnrollment,
      agentUpdatePolicy,
      maintenanceWindow: builtWindow,
      agentVersionPins: Object.keys(agentVersionPins).length > 0 ? agentVersionPins : undefined,
      defaultEnrollmentTtlMinutes: enrollmentTtlMinutes,
      defaultEnrollmentDeviceCount: enrollmentDeviceCount,
    };
    for (const [field, edit] of Object.entries(edits) as Array<[EditableField, FieldEdit]>) {
      if (edit === 'clear' || current[field] === undefined) delete data[field];
      else data[field] = current[field];
    }
    // A partner-locked field the org still stores its own (inert) value for is
    // replaced by the partner's value: re-posting a value that diverges from the
    // partner's 403s the whole category (issue #2752). A locked field the org
    // never stored stays absent — writing the partner's value would materialise
    // a copy that outlives the lock (#9945).
    if (effectiveDefaults) {
      for (const field of LOCKABLE_FIELDS) {
        if (isLocked(field) && field in data && field in effectiveDefaults) {
          data[field] = (effectiveDefaults as Record<string, unknown>)[field];
        }
      }
    }
    onSave?.(data as DefaultsData);
  };

  return (
    <section className="space-y-6 rounded-lg border bg-card p-6 shadow-xs">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h2 className="text-lg font-semibold">{t('orgDefaultsEditor.title')}</h2>
          <p className="text-sm text-muted-foreground">
            {t('orgDefaultsEditor.description', { organization: organizationName })}
          </p>
        </div>
        <button
          type="button"
          onClick={handleSave}
          disabled={!!windowError}
          data-testid="save-defaults"
          className="inline-flex items-center gap-2 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
        >
          <Save className="h-4 w-4" />
          {t('orgDefaultsEditor.save')}
        </button>
      </div>

      <div className="space-y-4">
        <div className="flex items-center gap-2 text-sm font-medium">
          <ShieldCheck className="h-4 w-4" />
          {t('orgDefaultsEditor.policies.title')}
        </div>
        <div className="grid gap-4 md:grid-cols-3">
          {policyFields.map(policy => (
            <label key={policy.id} className="space-y-2 rounded-lg border bg-muted/40 p-4 text-sm">
              <span className="font-medium">{t(/* i18n-dynamic */ policy.labelKey)}</span>
              <select
                value={policyDefaults[policy.id as keyof typeof policyDefaults]}
                disabled={isLocked('policyDefaults')}
                onChange={event => {
                  setPolicyDefaults(prev => ({
                    ...prev,
                    [policy.id]: event.target.value
                  }));
                  editField('policyDefaults');
                }}
                className={`h-10 w-full rounded-md border bg-background px-3 text-sm ${isLocked('policyDefaults') ? 'opacity-60' : ''}`}
              >
                {policyOptions.map(option => (
                  <option key={option.value} value={option.value}>
                    {t(/* i18n-dynamic */ option.labelKey)}
                  </option>
                ))}
              </select>
              {isLocked('policyDefaults') && (
                <span className="text-xs text-amber-600 dark:text-amber-400 italic">{t('orgDefaultsEditor.managedByPartner')}</span>
              )}
            </label>
          ))}
        </div>
        {renderInheritance('policyDefaults')}
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        <div className="space-y-4">
          <div className="flex items-center gap-2 text-sm font-medium">
            <Layers className="h-4 w-4" />
            {t('orgDefaultsEditor.deviceGroup.title')}
          </div>
          <label htmlFor="org-defaults-device-group" className="sr-only">
            {t('orgDefaultsEditor.deviceGroup.title')}
          </label>
          <select
            id="org-defaults-device-group"
            value={deviceGroup}
            data-testid="default-device-group"
            onChange={event => {
              setDeviceGroup(event.target.value);
              editField('deviceGroup');
            }}
            className="h-10 w-full rounded-md border bg-background px-3 text-sm"
          >
            <option value="">{t('orgDefaultsEditor.deviceGroup.none')}</option>
            {/* A stored id that isn't in the list (still loading, fetch failed,
                group deleted/dynamic) must not masquerade as "None" while save
                would still persist it. */}
            {deviceGroup && !staticGroups.some(g => g.id === deviceGroup) && (
              <option value={deviceGroup}>{t('orgDefaultsEditor.deviceGroup.unavailable')}</option>
            )}
            {staticGroups.map(group => (
              <option key={group.id} value={group.id}>{group.name}</option>
            ))}
          </select>
          <p className="text-xs text-muted-foreground">
            {t('orgDefaultsEditor.deviceGroup.description')}
          </p>
        </div>

      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        <div className="space-y-4 rounded-lg border bg-muted/40 p-4">
          <div className="flex items-center gap-2 text-sm font-medium">
            <Sparkles className="h-4 w-4" />
            {t('orgDefaultsEditor.autoEnrollment.title')}
          </div>
          <label className={`flex items-center justify-between gap-4 text-sm ${isLocked('autoEnrollment') ? 'opacity-60' : ''}`}>
            <span>{t('orgDefaultsEditor.autoEnrollment.enable')}</span>
            <input
              type="checkbox"
              checked={autoEnrollment.enabled}
              disabled={isLocked('autoEnrollment')}
              onChange={event => {
                setAutoEnrollment(prev => ({ ...prev, enabled: event.target.checked }));
                editField('autoEnrollment');
              }}
              data-testid="auto-enrollment-enabled"
              className="h-4 w-4"
            />
          </label>
          <label className={`flex items-center justify-between gap-4 text-sm ${isLocked('autoEnrollment') ? 'opacity-60' : ''}`}>
            <span>{t('orgDefaultsEditor.autoEnrollment.requireApproval')}</span>
            <input
              type="checkbox"
              checked={autoEnrollment.requireApproval}
              disabled={isLocked('autoEnrollment')}
              onChange={event => {
                setAutoEnrollment(prev => ({ ...prev, requireApproval: event.target.checked }));
                editField('autoEnrollment');
              }}
              data-testid="auto-enrollment-require-approval"
              className="h-4 w-4"
            />
          </label>
          {isLocked('autoEnrollment') && (
            <span data-testid="auto-enrollment-locked" className="text-xs text-amber-600 dark:text-amber-400 italic">
              {t('orgDefaultsEditor.managedByPartner')}
            </span>
          )}
          {renderInheritance('autoEnrollment')}
        </div>

        <div className="space-y-4 rounded-lg border bg-muted/40 p-4">
          <div className="flex items-center gap-2 text-sm font-medium">
            <RefreshCcw className="h-4 w-4" />
            {t('orgDefaultsEditor.agentUpdates.title')}
          </div>
          <label htmlFor="org-defaults-agent-update-policy" className="sr-only">
            {t('orgDefaultsEditor.agentUpdates.title')}
          </label>
          <select
            id="org-defaults-agent-update-policy"
            value={agentUpdatePolicy}
            disabled={isLocked('agentUpdatePolicy')}
            onChange={event => {
              setAgentUpdatePolicy(event.target.value);
              editField('agentUpdatePolicy');
            }}
            className={`h-10 w-full rounded-md border bg-background px-3 text-sm ${isLocked('agentUpdatePolicy') ? 'opacity-60' : ''}`}
          >
            <option value="auto">{t('orgDefaultsEditor.agentUpdates.automatic')}</option>
            <option value="manual">{t('orgDefaultsEditor.agentUpdates.manual')}</option>
          </select>
          {isLocked('agentUpdatePolicy') && (
            <span className="text-xs text-amber-600 dark:text-amber-400 italic">{t('orgDefaultsEditor.managedByPartner')}</span>
          )}
          {renderInheritance('agentUpdatePolicy')}
          <p className="text-xs text-muted-foreground">
            <Trans
              i18nKey="orgDefaultsEditor.agentUpdates.description"
              ns="settings"
              components={{ strong: <strong /> }}
            />
          </p>
          <div className="space-y-3">
            <span className="text-xs font-medium uppercase text-muted-foreground">
              {t('orgDefaultsEditor.maintenance.title')}
            </span>
            {storedWindowInvalid && (
              <p data-testid="maintenance-stored-invalid" className="text-xs text-destructive">
                {t('orgDefaultsEditor.maintenance.errors.storedInvalid')}
              </p>
            )}
            <div className="space-y-2">
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="radio"
                  name="maintenanceWindowMode"
                  value="always"
                  checked={windowMode === 'always'}
                  disabled={isLocked('maintenanceWindow')}
                  onChange={() => {
                    setWindowMode('always');
                    editField('maintenanceWindow');
                  }}
                  data-testid="maintenance-mode-always"
                  className="h-4 w-4"
                />
                <span>{t('orgDefaultsEditor.maintenance.always')}</span>
              </label>
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="radio"
                  name="maintenanceWindowMode"
                  value="window"
                  checked={windowMode === 'window'}
                  disabled={isLocked('maintenanceWindow')}
                  onChange={() => {
                    setWindowMode('window');
                    editField('maintenanceWindow');
                  }}
                  data-testid="maintenance-mode-window"
                  className="h-4 w-4"
                />
                <span>{t('orgDefaultsEditor.maintenance.windowOnly')}</span>
              </label>
            </div>
            {isLocked('maintenanceWindow') && (
              <span className="text-xs text-amber-600 dark:text-amber-400 italic">{t('orgDefaultsEditor.managedByPartner')}</span>
            )}
            {renderInheritance('maintenanceWindow')}

            {windowMode === 'window' && (
              <div className="space-y-2 rounded-md border bg-background/60 p-3">
                <div className="grid grid-cols-3 gap-2">
                  <label className="space-y-1 text-xs">
                    <span className="text-muted-foreground">{t('orgDefaultsEditor.maintenance.day')}</span>
                    <select
                      value={windowDay}
                      onChange={event => {
                        setWindowDay(event.target.value);
                        editField('maintenanceWindow');
                      }}
                      disabled={isLocked('maintenanceWindow')}
                      data-testid="maintenance-day"
                      className="h-9 w-full rounded-md border bg-background px-2 text-sm"
                    >
                      <option value="">{t('orgDefaultsEditor.maintenance.everyDay')}</option>
                      {maintenanceDays.map(day => (
                        <option key={day.value} value={day.value}>
                          {t(/* i18n-dynamic */ day.labelKey)}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="space-y-1 text-xs">
                    <span className="text-muted-foreground">{t('orgDefaultsEditor.maintenance.startUtc')}</span>
                    <input
                      type="time"
                      value={windowStart}
                      onChange={event => {
                        setWindowStart(event.target.value);
                        editField('maintenanceWindow');
                      }}
                      disabled={isLocked('maintenanceWindow')}
                      data-testid="maintenance-start"
                      className="h-9 w-full rounded-md border bg-background px-2 text-sm"
                    />
                  </label>
                  <label className="space-y-1 text-xs">
                    <span className="text-muted-foreground">{t('orgDefaultsEditor.maintenance.endUtc')}</span>
                    <input
                      type="time"
                      value={windowEnd}
                      onChange={event => {
                        setWindowEnd(event.target.value);
                        editField('maintenanceWindow');
                      }}
                      disabled={isLocked('maintenanceWindow')}
                      data-testid="maintenance-end"
                      className="h-9 w-full rounded-md border bg-background px-2 text-sm"
                    />
                  </label>
                </div>
                {windowError && (
                  <p data-testid="maintenance-error" className="text-xs text-destructive">
                    {windowError}
                  </p>
                )}
              </div>
            )}

            <p className="text-xs text-muted-foreground">
              {windowMode === 'always'
                ? t('orgDefaultsEditor.maintenance.alwaysDescription')
                : t('orgDefaultsEditor.maintenance.windowDescription')}
            </p>
          </div>
        </div>
      </div>

      {/* Enrollment defaults (#2776). Both values are inherit-with-override;
          the lifetime CAP is partner-only and therefore read-only here. */}
      <div className="space-y-4 rounded-lg border bg-muted/40 p-4">
        <div className="flex items-center gap-2 text-sm font-medium">
          <KeyRound className="h-4 w-4" />
          {t('orgDefaultsEditor.enrollment.title')}
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          <label className="space-y-2 text-sm">
            <span className="font-medium">{t('orgDefaultsEditor.enrollment.ttl')}</span>
            <select
              value={enrollmentTtlMinutes ?? ''}
              onChange={event => {
                setEnrollmentTtlMinutes(event.target.value ? Number(event.target.value) : undefined);
                editField('defaultEnrollmentTtlMinutes');
              }}
              data-testid="org-default-enrollment-ttl"
              className="h-10 w-full rounded-md border bg-background px-3 text-sm"
            >
              <option value="">{t('orgDefaultsEditor.enrollment.inherit')}</option>
              {ttlOptions.map(minutes => (
                <option key={minutes} value={minutes}>
                  {formatTtlMinutes(minutes)}
                </option>
              ))}
            </select>
          </label>
          <label className="space-y-2 text-sm">
            <span className="font-medium">{t('orgDefaultsEditor.enrollment.deviceCount')}</span>
            <input
              type="number"
              min={1}
              max={MAX_ENROLLMENT_DEVICE_COUNT}
              value={enrollmentDeviceCount ?? ''}
              onChange={event => {
                setEnrollmentDeviceCount(event.target.value ? Number(event.target.value) : undefined);
                editField('defaultEnrollmentDeviceCount');
              }}
              placeholder={t('orgDefaultsEditor.enrollment.inherit')}
              data-testid="org-default-enrollment-device-count"
              className="h-10 w-full rounded-md border bg-background px-3 text-sm"
            />
          </label>
        </div>
        <p className="text-xs text-muted-foreground">
          {t('orgDefaultsEditor.enrollment.description')}
        </p>
        {showEnrollmentCap && (
          <p
            data-testid="org-max-enrollment-ttl-readonly"
            className="text-xs text-amber-600 dark:text-amber-400"
          >
            {typeof partnerMaxEnrollmentTtlMinutes === 'number'
              ? t('orgDefaultsEditor.enrollment.capNotice', {
                  value: formatTtlMinutes(partnerMaxEnrollmentTtlMinutes),
                })
              : t('orgDefaultsEditor.enrollment.capNoticeUnknown')}
          </p>
        )}
      </div>

      <AgentVersionPinSelectors
        context="organization"
        value={agentVersionPins}
        onChange={(next) => {
          setAgentVersionPins(next);
          editField('agentVersionPins');
        }}
        pinnable={pinnableVersions ?? null}
        inheritedPins={partnerPins}
      />
    </section>
  );
}
