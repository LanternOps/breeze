import { useEffect, useState } from 'react';
import { Bell, Layers, RefreshCcw, Save, ShieldCheck, Sparkles } from 'lucide-react';
import AgentVersionPinSelectors, {
  type PinnableVersions,
  type AgentVersionPinsValue,
} from './AgentVersionPinSelectors';
import {
  MAINTENANCE_WINDOW_ALWAYS,
  MAINTENANCE_DAYS,
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

type DefaultsData = {
  policyDefaults?: Record<string, string>;
  deviceGroup?: string;
  alertThreshold?: string;
  autoEnrollment?: {
    enabled: boolean;
    requireApproval: boolean;
    sendWelcome: boolean;
  };
  agentUpdatePolicy?: string;
  maintenanceWindow?: string;
  agentVersionPins?: { agent?: string; watchdog?: string };
};

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
  { value: 'strict', label: 'Strict' },
  { value: 'balanced', label: 'Balanced' },
  { value: 'standard', label: 'Standard' },
  { value: 'lenient', label: 'Lenient' }
];

const groupOptions = ['All Managed Devices', 'Critical Infrastructure', 'Remote Staff', 'Contractors'];
const alertThresholds = [
  { value: 'critical', label: 'Critical only' },
  { value: 'high', label: 'High and critical' },
  { value: 'medium', label: 'Medium and above' }
];

export default function OrgDefaultsEditor({
  organizationName,
  defaults,
  onDirty,
  onSave,
  pinnableVersions,
  partnerPins,
}: OrgDefaultsEditorProps) {
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
      ? 'Enter a valid window — start and end times must differ.'
      : null;

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
    };
    onSave?.(data);
  };

  return (
    <section className="space-y-6 rounded-lg border bg-card p-6 shadow-xs">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h2 className="text-lg font-semibold">Default settings</h2>
          <p className="text-sm text-muted-foreground">
            Tune the default policies and enrollment behavior for {organizationName}.
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
          Save defaults
        </button>
      </div>

      <div className="space-y-4">
        <div className="flex items-center gap-2 text-sm font-medium">
          <ShieldCheck className="h-4 w-4" />
          Default policies
        </div>
        <div className="grid gap-4 md:grid-cols-3">
          {[
            { id: 'deviceCompliance', label: 'Device compliance' },
            { id: 'dataProtection', label: 'Data protection' },
            { id: 'accessControl', label: 'Access control' }
          ].map(policy => (
            <label key={policy.id} className="space-y-2 rounded-lg border bg-muted/40 p-4 text-sm">
              <span className="font-medium">{policy.label}</span>
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
                    {option.label}
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
            Default device group
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
              <option key={option} value={option}>
                {option}
              </option>
            ))}
          </select>
          <p className="text-xs text-muted-foreground">
            Newly enrolled devices are added to this group automatically.
          </p>
        </div>

        <div className="space-y-4">
          <div className="flex items-center gap-2 text-sm font-medium">
            <Bell className="h-4 w-4" />
            Default alert severity
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
                {option.label}
              </option>
            ))}
          </select>
          <p className="text-xs text-muted-foreground">
            Alerts below this severity are delivered to the summary feed only.
          </p>
        </div>
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        <div className="space-y-4 rounded-lg border bg-muted/40 p-4">
          <div className="flex items-center gap-2 text-sm font-medium">
            <Sparkles className="h-4 w-4" />
            Auto-enrollment
          </div>
          <label className="flex items-center justify-between gap-4 text-sm">
            <span>Enable automatic enrollment</span>
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
            <span>Require admin approval</span>
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
            <span>Send welcome message</span>
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
            Agent update policy
          </div>
          <select
            value={agentUpdatePolicy}
            onChange={event => {
              setAgentUpdatePolicy(event.target.value);
              markDirty();
            }}
            className="h-10 w-full rounded-md border bg-background px-3 text-sm"
          >
            <option value="auto">Automatic</option>
            <option value="manual">Manual (block automatic updates)</option>
          </select>
          <p className="text-xs text-muted-foreground">
            <strong>Automatic</strong> installs agent updates during the maintenance window below
            (or at any time when set to 24/7). <strong>Manual</strong> blocks automatic updates
            entirely — agents stay on their current version until you update them yourself.
          </p>
          <div className="space-y-3">
            <span className="text-xs font-medium uppercase text-muted-foreground">
              Maintenance window
            </span>
            {storedWindowInvalid && (
              <p data-testid="maintenance-stored-invalid" className="text-xs text-destructive">
                Your saved maintenance window was invalid and is being ignored, so agents may
                currently update at any time. Choose a valid setting below and save to fix it.
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
                <span>Always — agents may update anytime (24/7)</span>
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
                <span>Only during a maintenance window</span>
              </label>
            </div>

            {windowMode === 'window' && (
              <div className="space-y-2 rounded-md border bg-background/60 p-3">
                <div className="grid grid-cols-3 gap-2">
                  <label className="space-y-1 text-xs">
                    <span className="text-muted-foreground">Day</span>
                    <select
                      value={windowDay}
                      onChange={event => {
                        setWindowDay(event.target.value);
                        markDirty();
                      }}
                      data-testid="maintenance-day"
                      className="h-9 w-full rounded-md border bg-background px-2 text-sm"
                    >
                      <option value="">Every day</option>
                      {MAINTENANCE_DAYS.map(day => (
                        <option key={day} value={day}>
                          {day}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="space-y-1 text-xs">
                    <span className="text-muted-foreground">Start (UTC)</span>
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
                    <span className="text-muted-foreground">End (UTC)</span>
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
                ? 'Agents may install updates at any time, subject to the update policy above.'
                : 'Agents install updates only inside this window. Times are evaluated in UTC. A window may span midnight (e.g. 22:00–02:00).'}
            </p>
          </div>
        </div>
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
