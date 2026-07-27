import { useEffect, useState } from 'react';
import { Trans, useTranslation } from 'react-i18next';
import '@/lib/i18n';
import { Bell, KeyRound, Layers, RefreshCcw, Save, ShieldCheck, Sparkles } from 'lucide-react';
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
// shared type rather than restating it: this editor rebuilds the whole object
// on save (see handleSave), so a field this type doesn't know about is dropped
// on every save with no error. Add new fields to InheritableDefaultSettings in
// packages/shared and wire them into handleSave — never re-fork this type.
type DefaultsData = InheritableDefaultSettings;

type OrgDefaultsEditorProps = {
  organizationName: string;
  defaults?: DefaultsData;
  onDirty?: () => void;
  onSave?: (data: DefaultsData) => void;
  // Issue #2124: the registered versions to offer plus the partner's effective
  // pins to show as the inherited default. Pins are inherit-with-override, so
  // there is no lock — an org pin always overrides the partner default.
  pinnableVersions?: PinnableVersions | null;
  partnerPins?: AgentVersionPinsValue;
  // Partner-locked field paths (`defaults.<field>`) from GET effective-settings.
  locked?: string[];
  // Issue #2776: the partner's enrollment-link lifetime cap, shown read-only.
  // The cap is partner-only — an org can never edit it here (see below).
  partnerMaxEnrollmentTtlMinutes?: number;
};

const defaultValues: DefaultsData = {
  policyDefaults: {
    deviceCompliance: 'balanced',
    dataProtection: 'strict',
    accessControl: 'standard'
  },
  deviceGroup: 'All Managed Devices',
  alertThreshold: 'high',
  autoEnrollment: {
    enabled: true,
    requireApproval: false,
    sendWelcome: true
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

const groupOptions = [
  { value: 'All Managed Devices', labelKey: 'orgDefaultsEditor.deviceGroup.options.allManagedDevices' },
  { value: 'Critical Infrastructure', labelKey: 'orgDefaultsEditor.deviceGroup.options.criticalInfrastructure' },
  { value: 'Remote Staff', labelKey: 'orgDefaultsEditor.deviceGroup.options.remoteStaff' },
  { value: 'Contractors', labelKey: 'orgDefaultsEditor.deviceGroup.options.contractors' },
];
const alertThresholds = [
  { value: 'critical', labelKey: 'orgDefaultsEditor.alertSeverity.options.critical' },
  { value: 'high', labelKey: 'orgDefaultsEditor.alertSeverity.options.high' },
  { value: 'medium', labelKey: 'orgDefaultsEditor.alertSeverity.options.medium' },
];
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
  defaults,
  onDirty,
  onSave,
  pinnableVersions,
  partnerPins,
  locked,
  partnerMaxEnrollmentTtlMinutes,
}: OrgDefaultsEditorProps) {
  const { t } = useTranslation('settings');
  const isLocked = (field: string) => locked?.includes(`defaults.${field}`) ?? false;
  const initialData = { ...defaultValues, ...defaults };
  // Version pins are inherit-with-override (issue #2124): the org can always set
  // its own, which overrides the partner default. No lock.
  const [agentVersionPins, setAgentVersionPins] = useState<AgentVersionPinsValue>(
    initialData.agentVersionPins ?? {},
  );
  const [policyDefaults, setPolicyDefaults] = useState(initialData.policyDefaults || defaultValues.policyDefaults!);
  const [deviceGroup, setDeviceGroup] = useState(initialData.deviceGroup || defaultValues.deviceGroup!);
  const [alertThreshold, setAlertThreshold] = useState(initialData.alertThreshold || defaultValues.alertThreshold!);
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

  // If the stored window was invalid, the editor is already showing a corrected
  // value — mark the form dirty on mount so saving actually persists the fix.
  // Mount-only: intentionally empty deps (onDirty/storedWindowInvalid are stable
  // for the editor's lifetime).
  useEffect(() => {
    if (storedWindowInvalid) onDirty?.();
  }, []);

  const handleSave = () => {
    if (windowError || !builtWindow) return; // never persist an invalid window
    const data: DefaultsData = {
      policyDefaults,
      deviceGroup,
      alertThreshold,
      autoEnrollment,
      agentUpdatePolicy,
      maintenanceWindow: builtWindow,
      agentVersionPins,
      // `undefined` serializes away entirely, which is what "inherit from the
      // partner" means to the resolver (it keys on key presence, not value).
      //
      // Persisted verbatim, never clamped to the partner cap. This editor
      // rebuilds the entire blob on every save, so a save triggered by an
      // unrelated field must not rewrite this one. The cap is applied at read
      // time by resolveEnrollmentDefaults; the select shows the stored value
      // honestly (see ttlOptions above) so nothing is hidden either way.
      defaultEnrollmentTtlMinutes: enrollmentTtlMinutes,
      defaultEnrollmentDeviceCount: enrollmentDeviceCount,
      // maxEnrollmentLinkTtlMinutes is intentionally NOT rebuilt here. It is a
      // partner-only ceiling: the resolver ignores an org-set value, and the
      // org PATCH rejects it with 403 once the partner has set one. Omitting it
      // both drops any stale org-stored cap and keeps Save from 403ing.
    };
    onSave?.(data);
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
                onChange={event => {
                  setPolicyDefaults(prev => ({
                    ...prev,
                    [policy.id]: event.target.value
                  }));
                  markDirty();
                }}
                className="h-10 w-full rounded-md border bg-background px-3 text-sm"
              >
                {policyOptions.map(option => (
                  <option key={option.value} value={option.value}>
                    {t(/* i18n-dynamic */ option.labelKey)}
                  </option>
                ))}
              </select>
            </label>
          ))}
        </div>
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        <div className="space-y-4">
          <div className="flex items-center gap-2 text-sm font-medium">
            <Layers className="h-4 w-4" />
            {t('orgDefaultsEditor.deviceGroup.title')}
          </div>
          <select
            value={deviceGroup}
            onChange={event => {
              setDeviceGroup(event.target.value);
              markDirty();
            }}
            className="h-10 w-full rounded-md border bg-background px-3 text-sm"
          >
            {groupOptions.map(option => (
              <option key={option.value} value={option.value}>
                {t(/* i18n-dynamic */ option.labelKey)}
              </option>
            ))}
          </select>
          <p className="text-xs text-muted-foreground">
            {t('orgDefaultsEditor.deviceGroup.description')}
          </p>
        </div>

        <div className="space-y-4">
          <div className="flex items-center gap-2 text-sm font-medium">
            <Bell className="h-4 w-4" />
            {t('orgDefaultsEditor.alertSeverity.title')}
          </div>
          <select
            value={alertThreshold}
            onChange={event => {
              setAlertThreshold(event.target.value);
              markDirty();
            }}
            className="h-10 w-full rounded-md border bg-background px-3 text-sm"
          >
            {alertThresholds.map(option => (
              <option key={option.value} value={option.value}>
                {t(/* i18n-dynamic */ option.labelKey)}
              </option>
            ))}
          </select>
          <p className="text-xs text-muted-foreground">
            {t('orgDefaultsEditor.alertSeverity.description')}
          </p>
        </div>
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        <div className="space-y-4 rounded-lg border bg-muted/40 p-4">
          <div className="flex items-center gap-2 text-sm font-medium">
            <Sparkles className="h-4 w-4" />
            {t('orgDefaultsEditor.autoEnrollment.title')}
          </div>
          <label className="flex items-center justify-between gap-4 text-sm">
            <span>{t('orgDefaultsEditor.autoEnrollment.enable')}</span>
            <input
              type="checkbox"
              checked={autoEnrollment.enabled}
              onChange={event => {
                setAutoEnrollment(prev => ({ ...prev, enabled: event.target.checked }));
                markDirty();
              }}
              className="h-4 w-4"
            />
          </label>
          <label className="flex items-center justify-between gap-4 text-sm">
            <span>{t('orgDefaultsEditor.autoEnrollment.requireApproval')}</span>
            <input
              type="checkbox"
              checked={autoEnrollment.requireApproval}
              onChange={event => {
                setAutoEnrollment(prev => ({ ...prev, requireApproval: event.target.checked }));
                markDirty();
              }}
              className="h-4 w-4"
            />
          </label>
          <label className="flex items-center justify-between gap-4 text-sm">
            <span>{t('orgDefaultsEditor.autoEnrollment.sendWelcome')}</span>
            <input
              type="checkbox"
              checked={autoEnrollment.sendWelcome}
              onChange={event => {
                setAutoEnrollment(prev => ({ ...prev, sendWelcome: event.target.checked }));
                markDirty();
              }}
              className="h-4 w-4"
            />
          </label>
        </div>

        <div className="space-y-4 rounded-lg border bg-muted/40 p-4">
          <div className="flex items-center gap-2 text-sm font-medium">
            <RefreshCcw className="h-4 w-4" />
            {t('orgDefaultsEditor.agentUpdates.title')}
          </div>
          <select
            value={agentUpdatePolicy}
            onChange={event => {
              setAgentUpdatePolicy(event.target.value);
              markDirty();
            }}
            className="h-10 w-full rounded-md border bg-background px-3 text-sm"
          >
            <option value="auto">{t('orgDefaultsEditor.agentUpdates.automatic')}</option>
            <option value="manual">{t('orgDefaultsEditor.agentUpdates.manual')}</option>
          </select>
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
                  onChange={() => {
                    setWindowMode('always');
                    markDirty();
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
                  onChange={() => {
                    setWindowMode('window');
                    markDirty();
                  }}
                  data-testid="maintenance-mode-window"
                  className="h-4 w-4"
                />
                <span>{t('orgDefaultsEditor.maintenance.windowOnly')}</span>
              </label>
            </div>

            {windowMode === 'window' && (
              <div className="space-y-2 rounded-md border bg-background/60 p-3">
                <div className="grid grid-cols-3 gap-2">
                  <label className="space-y-1 text-xs">
                    <span className="text-muted-foreground">{t('orgDefaultsEditor.maintenance.day')}</span>
                    <select
                      value={windowDay}
                      onChange={event => {
                        setWindowDay(event.target.value);
                        markDirty();
                      }}
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
                        markDirty();
                      }}
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
                        markDirty();
                      }}
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
                markDirty();
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
                markDirty();
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
          markDirty();
        }}
        pinnable={pinnableVersions ?? null}
        inheritedPins={partnerPins}
      />
    </section>
  );
}
