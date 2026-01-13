import { useEffect, useState, type FormEvent } from 'react';

export type DiscoverySchedule = {
  cadence: 'daily' | 'weekly' | 'monthly';
  time: string;
  dayOfWeek?: string;
  dayOfMonth?: string;
  timezone: string;
};

export type SnmpSettings = {
  version: 'v2c' | 'v3';
  community: string;
  port: number;
  timeout: number;
  retries: number;
  username: string;
  authProtocol: 'md5' | 'sha';
  authPassphrase: string;
  privacyProtocol: 'des' | 'aes';
  privacyPassphrase: string;
};

export type DiscoveryProfileFormValues = {
  name: string;
  subnets: string[];
  methods: string[];
  schedule: DiscoverySchedule;
  snmp: SnmpSettings;
};

type DiscoveryProfileFormProps = {
  initialValues?: DiscoveryProfileFormValues;
  onSubmit?: (values: DiscoveryProfileFormValues) => void;
  onCancel?: () => void;
  submitLabel?: string;
};

const methodOptions = [
  { id: 'icmp', label: 'ICMP Ping' },
  { id: 'arp', label: 'ARP Sweep' },
  { id: 'snmp', label: 'SNMP Probe' },
  { id: 'tcp', label: 'TCP Port Scan' },
  { id: 'agent', label: 'Agent Check-in' }
];

const dayOptions = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];

const defaultValues: DiscoveryProfileFormValues = {
  name: '',
  subnets: [],
  methods: ['icmp', 'snmp'],
  schedule: {
    cadence: 'daily',
    time: '02:00',
    dayOfWeek: 'Monday',
    dayOfMonth: '1',
    timezone: 'UTC'
  },
  snmp: {
    version: 'v2c',
    community: 'public',
    port: 161,
    timeout: 2000,
    retries: 1,
    username: '',
    authProtocol: 'sha',
    authPassphrase: '',
    privacyProtocol: 'aes',
    privacyPassphrase: ''
  }
};

export default function DiscoveryProfileForm({
  initialValues,
  onSubmit,
  onCancel,
  submitLabel = 'Save Profile'
}: DiscoveryProfileFormProps) {
  const [formValues, setFormValues] = useState<DiscoveryProfileFormValues>(initialValues ?? defaultValues);
  const [subnetsText, setSubnetsText] = useState((initialValues?.subnets ?? []).join('\n'));

  useEffect(() => {
    if (initialValues) {
      setFormValues(initialValues);
      setSubnetsText(initialValues.subnets.join('\n'));
      return;
    }

    setFormValues(defaultValues);
    setSubnetsText('');
  }, [initialValues]);

  const handleToggleMethod = (method: string) => {
    setFormValues(prev => {
      const exists = prev.methods.includes(method);
      return {
        ...prev,
        methods: exists ? prev.methods.filter(item => item !== method) : [...prev.methods, method]
      };
    });
  };

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const subnets = subnetsText
      .split(/\n|,/)
      .map(value => value.trim())
      .filter(Boolean);

    onSubmit?.({
      ...formValues,
      subnets
    });
  };

  return (
    <form onSubmit={handleSubmit} className="space-y-6">
      <div className="rounded-lg border bg-card p-6 shadow-sm">
        <h2 className="text-lg font-semibold">Profile Details</h2>
        <p className="text-sm text-muted-foreground">Define the network scope and discovery methods.</p>

        <div className="mt-4 grid gap-4 md:grid-cols-2">
          <div>
            <label className="text-sm font-medium">Profile name</label>
            <input
              type="text"
              value={formValues.name}
              onChange={event => setFormValues(prev => ({ ...prev, name: event.target.value }))}
              placeholder="Headquarters scan"
              className="mt-2 h-10 w-full rounded-md border bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
            />
          </div>
          <div>
            <label className="text-sm font-medium">Schedule cadence</label>
            <select
              value={formValues.schedule.cadence}
              onChange={event =>
                setFormValues(prev => ({
                  ...prev,
                  schedule: { ...prev.schedule, cadence: event.target.value as DiscoverySchedule['cadence'] }
                }))
              }
              className="mt-2 h-10 w-full rounded-md border bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
            >
              <option value="daily">Daily</option>
              <option value="weekly">Weekly</option>
              <option value="monthly">Monthly</option>
            </select>
          </div>
          <div className="md:col-span-2">
            <label className="text-sm font-medium">Subnets to scan</label>
            <textarea
              value={subnetsText}
              onChange={event => setSubnetsText(event.target.value)}
              placeholder="10.0.0.0/24\n10.0.1.0/24"
              className="mt-2 h-24 w-full rounded-md border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
            />
            <p className="mt-2 text-xs text-muted-foreground">
              Enter CIDR ranges separated by commas or new lines.
            </p>
          </div>
        </div>

        <div className="mt-6">
          <label className="text-sm font-medium">Discovery methods</label>
          <div className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {methodOptions.map(option => (
              <label
                key={option.id}
                className="flex items-center gap-3 rounded-md border px-3 py-2 text-sm"
              >
                <input
                  type="checkbox"
                  checked={formValues.methods.includes(option.id)}
                  onChange={() => handleToggleMethod(option.id)}
                  className="h-4 w-4 rounded border-gray-300"
                />
                {option.label}
              </label>
            ))}
          </div>
        </div>
      </div>

      <div className="rounded-lg border bg-card p-6 shadow-sm">
        <h2 className="text-lg font-semibold">Schedule</h2>
        <p className="text-sm text-muted-foreground">Set when discovery jobs should run.</p>

        <div className="mt-4 grid gap-4 md:grid-cols-3">
          <div>
            <label className="text-sm font-medium">Time</label>
            <input
              type="time"
              value={formValues.schedule.time}
              onChange={event =>
                setFormValues(prev => ({
                  ...prev,
                  schedule: { ...prev.schedule, time: event.target.value }
                }))
              }
              className="mt-2 h-10 w-full rounded-md border bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
            />
          </div>
          <div>
            <label className="text-sm font-medium">Timezone</label>
            <select
              value={formValues.schedule.timezone}
              onChange={event =>
                setFormValues(prev => ({
                  ...prev,
                  schedule: { ...prev.schedule, timezone: event.target.value }
                }))
              }
              className="mt-2 h-10 w-full rounded-md border bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
            >
              <option value="UTC">UTC</option>
              <option value="America/New_York">America/New_York</option>
              <option value="America/Chicago">America/Chicago</option>
              <option value="America/Denver">America/Denver</option>
              <option value="America/Los_Angeles">America/Los_Angeles</option>
            </select>
          </div>
          {formValues.schedule.cadence === 'weekly' && (
            <div>
              <label className="text-sm font-medium">Day of week</label>
              <select
                value={formValues.schedule.dayOfWeek}
                onChange={event =>
                  setFormValues(prev => ({
                    ...prev,
                    schedule: { ...prev.schedule, dayOfWeek: event.target.value }
                  }))
                }
                className="mt-2 h-10 w-full rounded-md border bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
              >
                {dayOptions.map(day => (
                  <option key={day} value={day}>
                    {day}
                  </option>
                ))}
              </select>
            </div>
          )}
          {formValues.schedule.cadence === 'monthly' && (
            <div>
              <label className="text-sm font-medium">Day of month</label>
              <input
                type="number"
                min={1}
                max={28}
                value={formValues.schedule.dayOfMonth}
                onChange={event =>
                  setFormValues(prev => ({
                    ...prev,
                    schedule: { ...prev.schedule, dayOfMonth: event.target.value }
                  }))
                }
                className="mt-2 h-10 w-full rounded-md border bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
              />
            </div>
          )}
        </div>
      </div>

      <div className="rounded-lg border bg-card p-6 shadow-sm">
        <h2 className="text-lg font-semibold">SNMP Settings</h2>
        <p className="text-sm text-muted-foreground">Credentials used for SNMP discovery probes.</p>

        <div className="mt-4 grid gap-4 md:grid-cols-2">
          <div>
            <label className="text-sm font-medium">SNMP version</label>
            <select
              value={formValues.snmp.version}
              onChange={event =>
                setFormValues(prev => ({
                  ...prev,
                  snmp: { ...prev.snmp, version: event.target.value as SnmpSettings['version'] }
                }))
              }
              className="mt-2 h-10 w-full rounded-md border bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
            >
              <option value="v2c">v2c</option>
              <option value="v3">v3</option>
            </select>
          </div>
          <div>
            <label className="text-sm font-medium">Port</label>
            <input
              type="number"
              value={formValues.snmp.port}
              onChange={event =>
                setFormValues(prev => ({
                  ...prev,
                  snmp: { ...prev.snmp, port: Number(event.target.value) }
                }))
              }
              className="mt-2 h-10 w-full rounded-md border bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
            />
          </div>
          <div>
            <label className="text-sm font-medium">Timeout (ms)</label>
            <input
              type="number"
              value={formValues.snmp.timeout}
              onChange={event =>
                setFormValues(prev => ({
                  ...prev,
                  snmp: { ...prev.snmp, timeout: Number(event.target.value) }
                }))
              }
              className="mt-2 h-10 w-full rounded-md border bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
            />
          </div>
          <div>
            <label className="text-sm font-medium">Retries</label>
            <input
              type="number"
              value={formValues.snmp.retries}
              onChange={event =>
                setFormValues(prev => ({
                  ...prev,
                  snmp: { ...prev.snmp, retries: Number(event.target.value) }
                }))
              }
              className="mt-2 h-10 w-full rounded-md border bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
            />
          </div>

          {formValues.snmp.version === 'v2c' ? (
            <div className="md:col-span-2">
              <label className="text-sm font-medium">Community string</label>
              <input
                type="text"
                value={formValues.snmp.community}
                onChange={event =>
                  setFormValues(prev => ({
                    ...prev,
                    snmp: { ...prev.snmp, community: event.target.value }
                  }))
                }
                className="mt-2 h-10 w-full rounded-md border bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
              />
            </div>
          ) : (
            <>
              <div>
                <label className="text-sm font-medium">Username</label>
                <input
                  type="text"
                  value={formValues.snmp.username}
                  onChange={event =>
                    setFormValues(prev => ({
                      ...prev,
                      snmp: { ...prev.snmp, username: event.target.value }
                    }))
                  }
                  className="mt-2 h-10 w-full rounded-md border bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                />
              </div>
              <div>
                <label className="text-sm font-medium">Auth protocol</label>
                <select
                  value={formValues.snmp.authProtocol}
                  onChange={event =>
                    setFormValues(prev => ({
                      ...prev,
                      snmp: { ...prev.snmp, authProtocol: event.target.value as SnmpSettings['authProtocol'] }
                    }))
                  }
                  className="mt-2 h-10 w-full rounded-md border bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                >
                  <option value="sha">SHA</option>
                  <option value="md5">MD5</option>
                </select>
              </div>
              <div>
                <label className="text-sm font-medium">Auth passphrase</label>
                <input
                  type="password"
                  value={formValues.snmp.authPassphrase}
                  onChange={event =>
                    setFormValues(prev => ({
                      ...prev,
                      snmp: { ...prev.snmp, authPassphrase: event.target.value }
                    }))
                  }
                  className="mt-2 h-10 w-full rounded-md border bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                />
              </div>
              <div>
                <label className="text-sm font-medium">Privacy protocol</label>
                <select
                  value={formValues.snmp.privacyProtocol}
                  onChange={event =>
                    setFormValues(prev => ({
                      ...prev,
                      snmp: { ...prev.snmp, privacyProtocol: event.target.value as SnmpSettings['privacyProtocol'] }
                    }))
                  }
                  className="mt-2 h-10 w-full rounded-md border bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                >
                  <option value="aes">AES</option>
                  <option value="des">DES</option>
                </select>
              </div>
              <div>
                <label className="text-sm font-medium">Privacy passphrase</label>
                <input
                  type="password"
                  value={formValues.snmp.privacyPassphrase}
                  onChange={event =>
                    setFormValues(prev => ({
                      ...prev,
                      snmp: { ...prev.snmp, privacyPassphrase: event.target.value }
                    }))
                  }
                  className="mt-2 h-10 w-full rounded-md border bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                />
              </div>
            </>
          )}
        </div>
      </div>

      <div className="flex items-center justify-end gap-3">
        {onCancel && (
          <button
            type="button"
            onClick={onCancel}
            className="h-10 rounded-md border px-4 text-sm font-medium text-muted-foreground hover:text-foreground"
          >
            Cancel
          </button>
        )}
        <button
          type="submit"
          className="h-10 rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground hover:opacity-90"
        >
          {submitLabel}
        </button>
      </div>
    </form>
  );
}
