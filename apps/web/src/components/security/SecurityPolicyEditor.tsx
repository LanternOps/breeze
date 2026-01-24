import { useCallback, useEffect, useMemo, useState } from 'react';
import { CalendarClock, Loader2, Plus, Save, Trash2 } from 'lucide-react';
import { fetchWithAuth } from '../../stores/auth';

type ToggleRowProps = {
  label: string;
  description: string;
  checked: boolean;
  onChange: (next: boolean) => void;
};

function ToggleRow({ label, description, checked, onChange }: ToggleRowProps) {
  return (
    <div className="flex items-center justify-between rounded-md border bg-background px-4 py-3">
      <div>
        <p className="text-sm font-medium">{label}</p>
        <p className="text-xs text-muted-foreground">{description}</p>
      </div>
      <button
        type="button"
        onClick={() => onChange(!checked)}
        className={`relative inline-flex h-6 w-11 items-center rounded-full border transition ${checked ? 'bg-emerald-500/80' : 'bg-muted'}`}
      >
        <span
          className={`inline-block h-5 w-5 rounded-full bg-white transition ${checked ? 'translate-x-5' : 'translate-x-1'}`}
        />
      </button>
    </div>
  );
}

type SecurityPolicy = {
  id: string;
  name: string;
  description?: string;
  providerId?: string;
  scanSchedule: 'daily' | 'weekly' | 'monthly' | 'manual';
  realTimeProtection: boolean;
  autoQuarantine: boolean;
  severityThreshold: 'low' | 'medium' | 'high' | 'critical';
  exclusions: string[];
  createdAt: string;
  updatedAt: string;
};

type SecurityPolicyEditorProps = {
  policyId?: string;
  onSave?: (policy: SecurityPolicy) => void;
};

const minuteOptions = ['0', '15', '30', '45'];
const hourOptions = ['0', '2', '6', '12', '18'];
const dayOfMonthOptions = ['*', '1', '15'];
const dayOfWeekOptions = [
  { label: '*', value: '*' },
  { label: 'Mon', value: '1' },
  { label: 'Tue', value: '2' },
  { label: 'Wed', value: '3' },
  { label: 'Thu', value: '4' },
  { label: 'Fri', value: '5' },
  { label: 'Sat', value: '6' },
  { label: 'Sun', value: '0' }
];

const scanScheduleFromCron = (minute: string, hour: string, dayOfMonth: string, dayOfWeek: string): 'daily' | 'weekly' | 'monthly' | 'manual' => {
  if (dayOfMonth !== '*') return 'monthly';
  if (dayOfWeek !== '*') return 'weekly';
  if (hour !== '*') return 'daily';
  return 'manual';
};

export default function SecurityPolicyEditor({ policyId, onSave }: SecurityPolicyEditorProps) {
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();
  const [policyName, setPolicyName] = useState('');
  const [description, setDescription] = useState('');
  const [realTimeEnabled, setRealTimeEnabled] = useState(true);
  const [behavioralEnabled, setBehavioralEnabled] = useState(true);
  const [cloudLookupEnabled, setCloudLookupEnabled] = useState(true);
  const [scheduledEnabled, setScheduledEnabled] = useState(true);
  const [scanMinute, setScanMinute] = useState('0');
  const [scanHour, setScanHour] = useState('2');
  const [scanDayOfMonth, setScanDayOfMonth] = useState('*');
  const [scanDayOfWeek, setScanDayOfWeek] = useState('*');
  const [autoQuarantine, setAutoQuarantine] = useState(true);
  const [notifyUser, setNotifyUser] = useState(true);
  const [blockUsb, setBlockUsb] = useState(false);
  const [exclusions, setExclusions] = useState<string[]>([]);
  const [newExclusion, setNewExclusion] = useState('');

  const fetchPolicy = useCallback(async () => {
    if (!policyId) return;

    setLoading(true);
    setError(undefined);

    try {
      const response = await fetchWithAuth(`/api/security/policies`);
      if (!response.ok) {
        throw new Error(`${response.status} ${response.statusText}`);
      }
      const json = await response.json();
      const policies: SecurityPolicy[] = json.data || [];
      const policy = policies.find((p) => p.id === policyId);

      if (policy) {
        setPolicyName(policy.name);
        setDescription(policy.description || '');
        setRealTimeEnabled(policy.realTimeProtection);
        setAutoQuarantine(policy.autoQuarantine);
        setExclusions(policy.exclusions || []);
        setScheduledEnabled(policy.scanSchedule !== 'manual');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load policy');
    } finally {
      setLoading(false);
    }
  }, [policyId]);

  useEffect(() => {
    fetchPolicy();
  }, [fetchPolicy]);

  const handleSavePolicy = async () => {
    setSaving(true);
    setError(undefined);

    const scanSchedule = scheduledEnabled
      ? scanScheduleFromCron(scanMinute, scanHour, scanDayOfMonth, scanDayOfWeek)
      : 'manual';

    const payload = {
      name: policyName,
      description,
      scanSchedule,
      realTimeProtection: realTimeEnabled,
      autoQuarantine,
      severityThreshold: 'medium' as const,
      exclusions
    };

    try {
      const url = policyId ? `/api/security/policies/${policyId}` : '/api/security/policies';
      const method = policyId ? 'PUT' : 'POST';

      const response = await fetchWithAuth(url, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });

      if (!response.ok) {
        throw new Error(`${response.status} ${response.statusText}`);
      }

      const json = await response.json();
      onSave?.(json.data || json);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save policy');
    } finally {
      setSaving(false);
    }
  };

  const cronExpression = useMemo(
    () => `${scanMinute} ${scanHour} ${scanDayOfMonth} * ${scanDayOfWeek}`,
    [scanMinute, scanHour, scanDayOfMonth, scanDayOfWeek]
  );

  const handleAddExclusion = () => {
    const trimmed = newExclusion.trim();
    if (!trimmed || exclusions.includes(trimmed)) return;
    setExclusions(prev => [...prev, trimmed]);
    setNewExclusion('');
  };

  const handleRemoveExclusion = (value: string) => {
    setExclusions(prev => prev.filter(item => item !== value));
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-2">
        <h2 className="text-lg font-semibold">Security Policy Editor</h2>
        <p className="text-sm text-muted-foreground">Tune protection settings for device groups.</p>
      </div>

      <div className="rounded-lg border bg-card p-6 shadow-sm">
        <div className="grid gap-4 md:grid-cols-2">
          <div>
            <label className="text-xs uppercase text-muted-foreground">Policy name</label>
            <input
              type="text"
              value={policyName}
              onChange={event => setPolicyName(event.target.value)}
              className="mt-2 h-10 w-full rounded-md border bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
            />
          </div>
          <div>
            <label className="text-xs uppercase text-muted-foreground">Description</label>
            <input
              type="text"
              value={description}
              onChange={event => setDescription(event.target.value)}
              className="mt-2 h-10 w-full rounded-md border bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
            />
          </div>
        </div>
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        <div className="space-y-6">
          <div className="rounded-lg border bg-card p-6 shadow-sm">
            <h3 className="text-base font-semibold">Real-time Protection</h3>
            <div className="mt-4 space-y-3">
              <ToggleRow
                label="Real-time file monitoring"
                description="Scan new and modified files continuously."
                checked={realTimeEnabled}
                onChange={setRealTimeEnabled}
              />
              <ToggleRow
                label="Behavioral monitoring"
                description="Detect suspicious process behavior and scripts."
                checked={behavioralEnabled}
                onChange={setBehavioralEnabled}
              />
              <ToggleRow
                label="Cloud threat lookup"
                description="Use cloud reputation for new indicators."
                checked={cloudLookupEnabled}
                onChange={setCloudLookupEnabled}
              />
            </div>
          </div>

          <div className="rounded-lg border bg-card p-6 shadow-sm">
            <div className="flex items-center justify-between">
              <h3 className="text-base font-semibold">Scheduled Scans</h3>
              <button
                type="button"
                onClick={() => setScheduledEnabled(!scheduledEnabled)}
                className={`rounded-full border px-3 py-1 text-xs font-semibold ${scheduledEnabled ? 'bg-emerald-500/15 text-emerald-700' : 'bg-muted text-muted-foreground'}`}
              >
                {scheduledEnabled ? 'Enabled' : 'Disabled'}
              </button>
            </div>
            <div className={`mt-4 space-y-3 ${scheduledEnabled ? '' : 'opacity-50'}`}>
              <div className="grid gap-3 sm:grid-cols-2">
                <div>
                  <label className="text-xs uppercase text-muted-foreground">Minute</label>
                  <select
                    disabled={!scheduledEnabled}
                    value={scanMinute}
                    onChange={event => setScanMinute(event.target.value)}
                    className="mt-2 h-10 w-full rounded-md border bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                  >
                    {minuteOptions.map(option => (
                      <option key={option} value={option}>
                        {option}
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="text-xs uppercase text-muted-foreground">Hour</label>
                  <select
                    disabled={!scheduledEnabled}
                    value={scanHour}
                    onChange={event => setScanHour(event.target.value)}
                    className="mt-2 h-10 w-full rounded-md border bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                  >
                    {hourOptions.map(option => (
                      <option key={option} value={option}>
                        {option.padStart(2, '0')}:00
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="text-xs uppercase text-muted-foreground">Day of month</label>
                  <select
                    disabled={!scheduledEnabled}
                    value={scanDayOfMonth}
                    onChange={event => setScanDayOfMonth(event.target.value)}
                    className="mt-2 h-10 w-full rounded-md border bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                  >
                    {dayOfMonthOptions.map(option => (
                      <option key={option} value={option}>
                        {option}
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="text-xs uppercase text-muted-foreground">Day of week</label>
                  <select
                    disabled={!scheduledEnabled}
                    value={scanDayOfWeek}
                    onChange={event => setScanDayOfWeek(event.target.value)}
                    className="mt-2 h-10 w-full rounded-md border bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                  >
                    {dayOfWeekOptions.map(option => (
                      <option key={option.value} value={option.value}>
                        {option.label}
                      </option>
                    ))}
                  </select>
                </div>
              </div>
              <div className="flex items-center gap-2 rounded-md border bg-muted/20 px-3 py-2 text-xs text-muted-foreground">
                <CalendarClock className="h-4 w-4" />
                Cron: <span className="font-mono text-foreground">{cronExpression}</span>
              </div>
            </div>
          </div>
        </div>

        <div className="space-y-6">
          <div className="rounded-lg border bg-card p-6 shadow-sm">
            <h3 className="text-base font-semibold">Exclusions</h3>
            <p className="text-sm text-muted-foreground">Skip trusted locations during scans.</p>
            <div className="mt-4 flex gap-2">
              <input
                type="text"
                value={newExclusion}
                onChange={event => setNewExclusion(event.target.value)}
                placeholder="Add path or process"
                className="h-10 flex-1 rounded-md border bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
              />
              <button
                type="button"
                onClick={handleAddExclusion}
                className="inline-flex items-center gap-2 rounded-md border bg-background px-3 py-2 text-sm font-medium hover:bg-muted"
              >
                <Plus className="h-4 w-4" />
                Add
              </button>
            </div>
            <div className="mt-4 space-y-2">
              {exclusions.map(item => (
                <div key={item} className="flex items-center justify-between rounded-md border bg-muted/30 px-3 py-2 text-sm">
                  <span className="truncate">{item}</span>
                  <button
                    type="button"
                    onClick={() => handleRemoveExclusion(item)}
                    className="rounded-md border p-1.5 hover:bg-muted"
                  >
                    <Trash2 className="h-4 w-4" />
                  </button>
                </div>
              ))}
            </div>
          </div>

          <div className="rounded-lg border bg-card p-6 shadow-sm">
            <h3 className="text-base font-semibold">Actions</h3>
            <div className="mt-4 space-y-3">
              <ToggleRow
                label="Auto-quarantine"
                description="Move threats to quarantine immediately."
                checked={autoQuarantine}
                onChange={setAutoQuarantine}
              />
              <ToggleRow
                label="Notify user on detection"
                description="Send device notifications when threats are found."
                checked={notifyUser}
                onChange={setNotifyUser}
              />
              <ToggleRow
                label="Block untrusted USB devices"
                description="Prevent unknown removable media."
                checked={blockUsb}
                onChange={setBlockUsb}
              />
            </div>
          </div>
        </div>
      </div>

      {error && (
        <div className="rounded-lg border border-destructive/40 bg-destructive/10 p-4 text-center">
          <p className="text-sm text-destructive">{error}</p>
        </div>
      )}

      <div className="flex justify-end">
        <button
          type="button"
          onClick={handleSavePolicy}
          disabled={saving || loading}
          className="inline-flex items-center gap-2 rounded-md border bg-background px-4 py-2 text-sm font-medium hover:bg-muted disabled:opacity-50"
        >
          {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
          {saving ? 'Saving...' : 'Save policy'}
        </button>
      </div>
    </div>
  );
}
