import { useEffect, useMemo, useState } from 'react';
import type { InheritableDefaultSettings } from '@breeze/shared';
import { Plus, Trash2 } from 'lucide-react';
import { fetchWithAuth } from '../../stores/auth';

type Props = {
  data: InheritableDefaultSettings;
  onChange: (data: InheritableDefaultSettings) => void;
};

type DayOfWeek = 'sun' | 'mon' | 'tue' | 'wed' | 'thu' | 'fri' | 'sat';
type AgentUpdateScheduleWindow = { dayOfWeek: DayOfWeek; start: string; end: string };
type AgentUpdateSchedule = { windows: AgentUpdateScheduleWindow[] };
type LegacyAgentUpdateSchedule = { dayOfWeek: DayOfWeek; time: string };

const PLACEHOLDER = 'Not set — orgs configure individually';
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

function legacyPolicyFor(mode?: InheritableDefaultSettings['agentUpdateMode'], _timing?: InheritableDefaultSettings['agentUpdateTiming']) {
  if (mode === 'manual') return 'manual';
  return mode === 'automatic' ? 'auto' : undefined;
}

function normalizeSchedule(raw: InheritableDefaultSettings['agentUpdateSchedule'] | LegacyAgentUpdateSchedule | undefined, fallback?: AgentUpdateSchedule | null): AgentUpdateSchedule {
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

export default function PartnerDefaultsTab({ data, onChange }: Props) {
  const set = (patch: Partial<InheritableDefaultSettings>) =>
    onChange({ ...data, ...patch });

  const autoEnrollment = data.autoEnrollment ?? { enabled: false, requireApproval: true, sendWelcome: true };
  const legacySchedule = parseLegacySchedule(data.maintenanceWindow);
  const mode = data.agentUpdateMode ?? (
    data.agentUpdatePolicy === 'manual'
      ? 'manual'
      : data.agentUpdatePolicy === 'auto' || data.agentUpdatePolicy === 'staged'
        ? 'automatic'
        : undefined
  );
  const timing = data.agentUpdateTiming ?? (
    data.agentUpdatePolicy === 'auto'
      ? 'weekly'
      : data.agentUpdatePolicy === 'staged'
        ? (legacySchedule ? 'weekly' : 'asap')
        : legacySchedule
          ? 'weekly'
          : undefined
  );
  const schedule = normalizeSchedule(data.agentUpdateSchedule as InheritableDefaultSettings['agentUpdateSchedule'] | LegacyAgentUpdateSchedule | undefined, legacySchedule);
  const pins = data.agentVersionPins ?? {};
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

  const setUpdatePolicy = (nextMode: 'automatic' | 'manual' | undefined, nextTiming: 'asap' | 'weekly' | undefined) => {
    const patch: Partial<InheritableDefaultSettings> = {
      agentUpdateMode: nextMode,
      agentUpdateTiming: nextMode === 'automatic' ? nextTiming : undefined,
      agentUpdateSchedule: nextMode === 'automatic' && nextTiming === 'weekly' ? schedule : undefined,
      agentUpdatePolicy: nextMode ? legacyPolicyFor(nextMode, nextTiming) : undefined,
      maintenanceWindow: nextMode === 'automatic' && nextTiming === 'weekly' ? legacyWindowFor(schedule) : undefined,
    };
    set(patch);
  };

  return (
    <div className="space-y-6">
      <div className="grid gap-6 sm:grid-cols-2">
        <div className="space-y-2">
          <label className="text-sm font-medium">Agent Update Policy</label>
          <select
            value={!mode ? '' : mode === 'manual' ? 'manual' : (timing ?? 'asap')}
            data-testid="partner-agent-update-policy-select"
            onChange={e => {
              if (!e.target.value) {
                setUpdatePolicy(undefined, undefined);
              } else if (e.target.value === 'manual') {
                setUpdatePolicy('manual', undefined);
              } else {
                setUpdatePolicy('automatic', e.target.value as 'asap' | 'weekly');
              }
            }}
            className="h-10 w-full rounded-md border bg-background px-3 text-sm"
          >
            <option value="">{PLACEHOLDER}</option>
            <option value="asap">Automatic: as soon as possible</option>
            <option value="weekly">Automatic: weekly schedule</option>
            <option value="manual">Manual</option>
          </select>
        </div>

        {mode === 'automatic' && timing === 'weekly' ? (
          <div className="space-y-3 sm:col-span-2">
            {schedule.windows.map((window, index) => (
              <div
                key={`${window.dayOfWeek}-${window.start}-${window.end}-${index}`}
                className="grid items-end gap-3 sm:grid-cols-[1fr_1fr_1fr_auto]"
              >
                <label className="space-y-2">
                  <span className="text-sm font-medium">Day</span>
                  <select
                    value={window.dayOfWeek}
                    data-testid={`partner-agent-update-window-day-${index}`}
                    onChange={e => {
                      const nextSchedule = {
                        windows: schedule.windows.map((entry, windowIndex) =>
                          windowIndex === index ? { ...entry, dayOfWeek: e.target.value as DayOfWeek } : entry
                        ),
                      };
                      set({
                        agentUpdateSchedule: nextSchedule,
                        maintenanceWindow: legacyWindowFor(nextSchedule),
                      });
                    }}
                    className="h-10 w-full rounded-md border bg-background px-3 text-sm"
                  >
                    {dayOptions.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
                  </select>
                </label>
                <label className="space-y-2">
                  <span className="text-sm font-medium">Start</span>
                  <select
                    value={window.start}
                    data-testid={`partner-agent-update-window-start-${index}`}
                    onChange={e => {
                      const nextSchedule = {
                        windows: schedule.windows.map((entry, windowIndex) =>
                          windowIndex === index ? { ...entry, start: e.target.value } : entry
                        ),
                      };
                      set({
                        agentUpdateSchedule: nextSchedule,
                        maintenanceWindow: legacyWindowFor(nextSchedule),
                      });
                    }}
                    className="h-10 w-full rounded-md border bg-background px-3 text-sm"
                  >
                    {timeOptions.map(time => <option key={time} value={time}>{time}</option>)}
                  </select>
                </label>
                <label className="space-y-2">
                  <span className="text-sm font-medium">End</span>
                  <select
                    value={window.end}
                    data-testid={`partner-agent-update-window-end-${index}`}
                    onChange={e => {
                      const nextSchedule = {
                        windows: schedule.windows.map((entry, windowIndex) =>
                          windowIndex === index ? { ...entry, end: e.target.value } : entry
                        ),
                      };
                      set({
                        agentUpdateSchedule: nextSchedule,
                        maintenanceWindow: legacyWindowFor(nextSchedule),
                      });
                    }}
                    className="h-10 w-full rounded-md border bg-background px-3 text-sm"
                  >
                    {timeOptions.map(time => <option key={time} value={time}>{time}</option>)}
                  </select>
                </label>
                <button
                  type="button"
                  onClick={() => {
                    if (schedule.windows.length <= 1) return;
                    const nextSchedule = { windows: schedule.windows.filter((_, windowIndex) => windowIndex !== index) };
                    set({
                      agentUpdateSchedule: nextSchedule,
                      maintenanceWindow: legacyWindowFor(nextSchedule),
                    });
                  }}
                  disabled={schedule.windows.length === 1}
                  className="inline-flex h-10 w-10 items-center justify-center rounded-md border text-muted-foreground transition hover:bg-muted hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50"
                  title="Remove update window"
                  aria-label="Remove update window"
                >
                  <Trash2 className="h-4 w-4" />
                </button>
              </div>
            ))}
            <button
              type="button"
              onClick={() => {
                const nextSchedule = {
                  windows: [
                    ...schedule.windows,
                    { dayOfWeek: 'sun' as const, start: '02:00', end: '04:00' },
                  ],
                };
                set({
                  agentUpdateSchedule: nextSchedule,
                  maintenanceWindow: legacyWindowFor(nextSchedule),
                });
              }}
              className="inline-flex items-center gap-2 rounded-md border px-3 py-2 text-sm font-medium transition hover:bg-muted"
              data-testid="partner-agent-update-window-add"
            >
              <Plus className="h-4 w-4" />
              Add window
            </button>
          </div>
        ) : <div />}

        {(['agent', 'watchdog'] as const).map(component => (
          <div key={component} className="space-y-2">
            <label className="text-sm font-medium">
              {component === 'agent' ? 'Agent version pin' : 'Watchdog version pin'}
            </label>
            <select
              value={pins[component] ?? ''}
              onChange={e => set({
                agentVersionPins: {
                  ...pins,
                  [component]: e.target.value || undefined,
                },
              })}
              className="h-10 w-full rounded-md border bg-background px-3 text-sm"
            >
              <option value="">Latest</option>
              {(versionOptions[component].includes(pins[component] ?? '')
                ? versionOptions[component]
                : ([pins[component], ...versionOptions[component]].filter(Boolean) as string[])
              ).map(version => <option key={version} value={version}>{version}</option>)}
            </select>
          </div>
        ))}

        {data.maintenanceWindow && !legacySchedule && !data.agentUpdateSchedule ? (
          <p className="text-xs text-amber-600 sm:col-span-2">
            Existing maintenance window could not be parsed. Review the selected update schedule before saving.
          </p>
        ) : null}

        <div className="space-y-2">
          <label className="text-sm font-medium">Default Device Group</label>
          <input
            type="text"
            value={data.deviceGroup ?? ''}
            onChange={e => set({ deviceGroup: e.target.value || undefined })}
            placeholder={PLACEHOLDER}
            className="h-10 w-full rounded-md border bg-background px-3 text-sm"
          />
        </div>

        <div className="space-y-2">
          <label className="text-sm font-medium">Default Alert Threshold</label>
          <input
            type="text"
            value={data.alertThreshold ?? ''}
            onChange={e => set({ alertThreshold: e.target.value || undefined })}
            placeholder={PLACEHOLDER}
            className="h-10 w-full rounded-md border bg-background px-3 text-sm"
          />
        </div>
      </div>

      {/* Auto-enrollment */}
      <div className="space-y-4 rounded-lg border bg-muted/40 p-4">
        <p className="text-sm font-medium">Auto-Enrollment</p>
        <div className="space-y-3">
          <div className="flex items-center gap-3">
            <input
              type="checkbox"
              checked={autoEnrollment.enabled}
              onChange={e =>
                set({ autoEnrollment: { ...autoEnrollment, enabled: e.target.checked } })
              }
              className="h-4 w-4 rounded border"
            />
            <label className="text-sm font-medium">Enable auto-enrollment for new devices</label>
          </div>
          <div className="flex items-center gap-3">
            <input
              type="checkbox"
              checked={autoEnrollment.requireApproval}
              onChange={e =>
                set({ autoEnrollment: { ...autoEnrollment, requireApproval: e.target.checked } })
              }
              className="h-4 w-4 rounded border"
            />
            <label className="text-sm font-medium">Require admin approval</label>
          </div>
          <div className="flex items-center gap-3">
            <input
              type="checkbox"
              checked={autoEnrollment.sendWelcome}
              onChange={e =>
                set({ autoEnrollment: { ...autoEnrollment, sendWelcome: e.target.checked } })
              }
              className="h-4 w-4 rounded border"
            />
            <label className="text-sm font-medium">Send welcome notification</label>
          </div>
        </div>
      </div>
    </div>
  );
}
