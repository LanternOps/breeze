import { useEffect, useMemo, useState } from 'react';
import { Bell, Layers, Plus, RefreshCcw, Save, ShieldCheck, Sparkles, Trash2 } from 'lucide-react';
import { fetchWithAuth } from '../../stores/auth';

type DayOfWeek = 'sun' | 'mon' | 'tue' | 'wed' | 'thu' | 'fri' | 'sat';

type AgentUpdateScheduleWindow = {
  dayOfWeek: DayOfWeek;
  start: string;
  end: string;
};

type AgentUpdateSchedule = {
  windows: AgentUpdateScheduleWindow[];
};

type LegacyAgentUpdateSchedule = {
  dayOfWeek: DayOfWeek;
  time: string;
};

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
  agentUpdateMode?: 'automatic' | 'manual';
  agentUpdateTiming?: 'asap' | 'weekly';
  agentUpdateSchedule?: AgentUpdateSchedule | LegacyAgentUpdateSchedule;
  agentVersionPins?: {
    agent?: string;
    watchdog?: string;
  };
};

type OrgDefaultsEditorProps = {
  organizationName: string;
  defaults?: DefaultsData;
  onDirty?: () => void;
  onSave?: (data: DefaultsData) => void;
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
  agentVersionPins: {}
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
const dayOptions = [
  { value: 'sun', label: 'Sunday' },
  { value: 'mon', label: 'Monday' },
  { value: 'tue', label: 'Tuesday' },
  { value: 'wed', label: 'Wednesday' },
  { value: 'thu', label: 'Thursday' },
  { value: 'fri', label: 'Friday' },
  { value: 'sat', label: 'Saturday' },
] as const;
const timeOptions = Array.from({ length: 48 }, (_, index) => {
  const hour = Math.floor(index / 2);
  const minute = index % 2 === 0 ? '00' : '30';
  return `${String(hour).padStart(2, '0')}:${minute}`;
});
const defaultAgentUpdateSchedule: AgentUpdateSchedule = {
  windows: [{ dayOfWeek: 'sun', start: '02:00', end: '04:00' }],
};

type ComponentVersion = {
  version: string;
  component: 'agent' | 'watchdog';
  isLatest?: boolean;
};

function addMinutes(time: string, minutes: number) {
  const [hourText, minuteText] = time.split(':');
  const total = ((Number(hourText) * 60 + Number(minuteText) + minutes) % 1440 + 1440) % 1440;
  return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
}

function isValidTimeWindow(window: Partial<AgentUpdateScheduleWindow>): window is AgentUpdateScheduleWindow {
  const timeRe = /^([01]\d|2[0-3]):([0-5]\d)$/;
  return (
    !!window.dayOfWeek &&
    dayOptions.some(option => option.value === window.dayOfWeek) &&
    typeof window.start === 'string' &&
    typeof window.end === 'string' &&
    timeRe.test(window.start) &&
    timeRe.test(window.end) &&
    window.start !== window.end
  );
}

function parseLegacySchedule(windowText?: string): AgentUpdateSchedule | null {
  const match = windowText?.trim().match(/^(sun|mon|tue|wed|thu|fri|sat)\s+(\d{1,2}):([0-5]\d)\s*-\s*(\d{1,2}):([0-5]\d)$/i);
  if (!match) return null;
  const [, day, rawStartHour, startMinute, rawEndHour, endMinute] = match;
  if (!day || !rawStartHour || !startMinute || !rawEndHour || !endMinute) return null;
  const startHour = Number(rawStartHour);
  const endHour = Number(rawEndHour);
  if (startHour < 0 || startHour > 23 || endHour < 0 || endHour > 23) return null;
  return {
    windows: [{
      dayOfWeek: day.toLowerCase() as DayOfWeek,
      start: `${String(startHour).padStart(2, '0')}:${startMinute}`,
      end: `${String(endHour).padStart(2, '0')}:${endMinute}`,
    }],
  };
}

function legacyPolicyFor(mode: DefaultsData['agentUpdateMode'], _timing: DefaultsData['agentUpdateTiming']) {
  if (mode === 'manual') return 'manual';
  return 'auto';
}

function normalizeSchedule(raw: DefaultsData['agentUpdateSchedule'] | undefined, fallback?: AgentUpdateSchedule | null): AgentUpdateSchedule {
  if (raw && 'windows' in raw && Array.isArray(raw.windows)) {
    const windows = raw.windows.filter(isValidTimeWindow);
    if (windows.length > 0) return { windows };
  }
  if (raw && 'dayOfWeek' in raw && 'time' in raw && isValidTimeWindow({
    dayOfWeek: raw.dayOfWeek,
    start: raw.time,
    end: addMinutes(raw.time, 60),
  })) {
    return { windows: [{ dayOfWeek: raw.dayOfWeek, start: raw.time, end: addMinutes(raw.time, 60) }] };
  }
  return fallback ?? defaultAgentUpdateSchedule;
}

function legacyWindowFor(schedule: AgentUpdateSchedule) {
  const first = schedule.windows[0];
  if (!first) return undefined;
  const day = first.dayOfWeek.charAt(0).toUpperCase() + first.dayOfWeek.slice(1);
  return `${day} ${first.start}-${first.end}`;
}

export default function OrgDefaultsEditor({ organizationName, defaults, onDirty, onSave }: OrgDefaultsEditorProps) {
  const rawDefaults = defaults ?? {};
  const initialData = { ...defaultValues, ...rawDefaults };
  const [policyDefaults, setPolicyDefaults] = useState(initialData.policyDefaults || defaultValues.policyDefaults!);
  const [deviceGroup, setDeviceGroup] = useState(initialData.deviceGroup || defaultValues.deviceGroup!);
  const [alertThreshold, setAlertThreshold] = useState(initialData.alertThreshold || defaultValues.alertThreshold!);
  const [autoEnrollment, setAutoEnrollment] = useState(initialData.autoEnrollment || defaultValues.autoEnrollment!);
  const legacySchedule = parseLegacySchedule(rawDefaults.maintenanceWindow);
  const resolvedAgentUpdateMode = rawDefaults.agentUpdateMode ?? (rawDefaults.agentUpdatePolicy === 'manual' ? 'manual' : 'automatic');
  const [agentUpdateMode, setAgentUpdateMode] = useState<NonNullable<DefaultsData['agentUpdateMode']>>(
    resolvedAgentUpdateMode
  );
  const [agentUpdateTiming, setAgentUpdateTiming] = useState<NonNullable<DefaultsData['agentUpdateTiming']>>(
    rawDefaults.agentUpdateTiming ?? (
      resolvedAgentUpdateMode === 'manual'
        ? 'asap'
        : rawDefaults.agentUpdatePolicy === 'auto' || legacySchedule
          ? 'weekly'
          : 'asap'
    )
  );
  const [agentUpdateSchedule, setAgentUpdateSchedule] = useState<AgentUpdateSchedule>(
    normalizeSchedule(rawDefaults.agentUpdateSchedule, legacySchedule)
  );
  const [agentVersionPins, setAgentVersionPins] = useState<NonNullable<DefaultsData['agentVersionPins']>>(
    initialData.agentVersionPins ?? {}
  );
  const [versions, setVersions] = useState<ComponentVersion[]>([]);

  useEffect(() => {
    let cancelled = false;
    fetchWithAuth('/agent-versions')
      .then(async response => {
        if (!response.ok) return;
        const body = await response.json() as { data?: ComponentVersion[] };
        if (!cancelled) setVersions(Array.isArray(body.data) ? body.data : []);
      })
      .catch(() => {
        if (!cancelled) setVersions([]);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const versionOptions = useMemo(() => {
    const byComponent: Record<'agent' | 'watchdog', string[]> = { agent: [], watchdog: [] };
    for (const row of versions) {
      if (row.component !== 'agent' && row.component !== 'watchdog') continue;
      if (!byComponent[row.component].includes(row.version)) byComponent[row.component].push(row.version);
    }
    return byComponent;
  }, [versions]);

  const markDirty = () => {
    onDirty?.();
  };

  const updateScheduleWindow = (index: number, patch: Partial<AgentUpdateScheduleWindow>) => {
    setAgentUpdateSchedule(prev => ({
      windows: prev.windows.map((window, windowIndex) =>
        windowIndex === index ? { ...window, ...patch } : window
      ),
    }));
    markDirty();
  };

  const addScheduleWindow = () => {
    setAgentUpdateSchedule(prev => ({
      windows: [
        ...prev.windows,
        { dayOfWeek: 'sun', start: '02:00', end: '04:00' },
      ],
    }));
    markDirty();
  };

  const removeScheduleWindow = (index: number) => {
    setAgentUpdateSchedule(prev => ({
      windows: prev.windows.length > 1
        ? prev.windows.filter((_, windowIndex) => windowIndex !== index)
        : prev.windows,
    }));
    markDirty();
  };

  const handleSave = () => {
    const data: DefaultsData = {
      policyDefaults,
      deviceGroup,
      alertThreshold,
      autoEnrollment,
      agentUpdateMode,
      agentUpdateTiming: agentUpdateMode === 'automatic' ? agentUpdateTiming : undefined,
      agentUpdateSchedule: agentUpdateMode === 'automatic' && agentUpdateTiming === 'weekly'
        ? agentUpdateSchedule
        : undefined,
      agentVersionPins,
      agentUpdatePolicy: legacyPolicyFor(agentUpdateMode, agentUpdateTiming),
      maintenanceWindow: agentUpdateMode === 'automatic' && agentUpdateTiming === 'weekly'
        ? legacyWindowFor(agentUpdateSchedule)
        : undefined,
    };
    onSave?.(data);
  };

  return (
    <section className="space-y-6 rounded-lg border bg-card p-6 shadow-sm">
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
          data-testid="org-defaults-save"
          className="inline-flex items-center gap-2 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition hover:opacity-90"
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
            value={agentUpdateMode === 'manual' ? 'manual' : agentUpdateTiming}
            data-testid="agent-update-policy-select"
            onChange={event => {
              if (event.target.value === 'manual') {
                setAgentUpdateMode('manual');
                setAgentUpdateTiming('asap');
              } else {
                setAgentUpdateMode('automatic');
                setAgentUpdateTiming(event.target.value as 'asap' | 'weekly');
              }
              markDirty();
            }}
            className="h-10 w-full rounded-md border bg-background px-3 text-sm"
          >
            <option value="asap">Automatic: as soon as possible</option>
            <option value="weekly">Automatic: weekly schedule</option>
            <option value="manual">Manual</option>
          </select>
          {agentUpdateMode === 'automatic' && agentUpdateTiming === 'weekly' ? (
            <div className="space-y-3">
              {agentUpdateSchedule.windows.map((window, index) => (
                <div
                  key={`${window.dayOfWeek}-${window.start}-${window.end}-${index}`}
                  className="grid items-end gap-3 sm:grid-cols-[1fr_1fr_1fr_auto]"
                  data-testid={`agent-update-window-${index}`}
                >
                  <label className="space-y-2 text-sm">
                    <span className="text-xs font-medium uppercase text-muted-foreground">Day</span>
                    <select
                      value={window.dayOfWeek}
                      onChange={event => updateScheduleWindow(index, { dayOfWeek: event.target.value as DayOfWeek })}
                      className="h-10 w-full rounded-md border bg-background px-3 text-sm"
                      data-testid={`agent-update-window-day-${index}`}
                    >
                      {dayOptions.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
                    </select>
                  </label>
                  <label className="space-y-2 text-sm">
                    <span className="text-xs font-medium uppercase text-muted-foreground">Start</span>
                    <select
                      value={window.start}
                      onChange={event => updateScheduleWindow(index, { start: event.target.value })}
                      className="h-10 w-full rounded-md border bg-background px-3 text-sm"
                      data-testid={`agent-update-window-start-${index}`}
                    >
                      {timeOptions.map(time => <option key={time} value={time}>{time}</option>)}
                    </select>
                  </label>
                  <label className="space-y-2 text-sm">
                    <span className="text-xs font-medium uppercase text-muted-foreground">End</span>
                    <select
                      value={window.end}
                      onChange={event => updateScheduleWindow(index, { end: event.target.value })}
                      className="h-10 w-full rounded-md border bg-background px-3 text-sm"
                      data-testid={`agent-update-window-end-${index}`}
                    >
                      {timeOptions.map(time => <option key={time} value={time}>{time}</option>)}
                    </select>
                  </label>
                  <button
                    type="button"
                    onClick={() => removeScheduleWindow(index)}
                    disabled={agentUpdateSchedule.windows.length === 1}
                    className="inline-flex h-10 w-10 items-center justify-center rounded-md border text-muted-foreground transition hover:bg-muted hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50"
                    title="Remove update window"
                    aria-label="Remove update window"
                    data-testid={`agent-update-window-remove-${index}`}
                  >
                    <Trash2 className="h-4 w-4" />
                  </button>
                </div>
              ))}
              <button
                type="button"
                onClick={addScheduleWindow}
                className="inline-flex items-center gap-2 rounded-md border px-3 py-2 text-sm font-medium transition hover:bg-muted"
                data-testid="agent-update-window-add"
              >
                <Plus className="h-4 w-4" />
                Add window
              </button>
            </div>
          ) : null}
          <div className="grid gap-3 sm:grid-cols-2">
            {(['agent', 'watchdog'] as const).map(component => (
              <label key={component} className="space-y-2 text-sm">
                <span className="text-xs font-medium uppercase text-muted-foreground">
                  {component === 'agent' ? 'Agent pin' : 'Watchdog pin'}
                </span>
                <select
                  value={agentVersionPins[component] ?? ''}
                  onChange={event => {
                    setAgentVersionPins(prev => ({ ...prev, [component]: event.target.value || undefined }));
                    markDirty();
                  }}
                  className="h-10 w-full rounded-md border bg-background px-3 text-sm"
                >
                  <option value="">Latest</option>
                  {(versionOptions[component].includes(agentVersionPins[component] ?? '')
                    ? versionOptions[component]
                    : ([agentVersionPins[component], ...versionOptions[component]].filter(Boolean) as string[])
                  ).map(version => (
                    <option key={version} value={version}>{version}</option>
                  ))}
                </select>
              </label>
            ))}
          </div>
          {rawDefaults.maintenanceWindow && !legacySchedule && !rawDefaults.agentUpdateSchedule ? (
            <p className="text-xs text-amber-600">
              Existing maintenance window could not be parsed. Review the selected update schedule before saving.
            </p>
          ) : null}
        </div>
      </div>
    </section>
  );
}
