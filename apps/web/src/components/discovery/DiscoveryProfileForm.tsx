import { useEffect, useState, type FormEvent, useCallback } from 'react';

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
  siteId: string;
  subnets: string[];
  methods: string[];
  schedule: DiscoverySchedule;
  snmp: SnmpSettings;
};

type SiteOption = {
  id: string;
  name: string;
};

type DiscoveryProfileFormProps = {
  initialValues?: DiscoveryProfileFormValues;
  sites?: SiteOption[];
  onSubmit?: (values: DiscoveryProfileFormValues) => void;
  onCancel?: () => void;
  submitLabel?: string;
  disabled?: boolean;
};

const methodOptions = [
  { id: 'ping', label: 'ICMP Ping' },
  { id: 'arp', label: 'ARP Sweep' },
  { id: 'snmp', label: 'SNMP Probe' },
  { id: 'port_scan', label: 'TCP Port Scan' }
];

const dayOptions = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];

const CIDR_REGEX = /^(\d{1,3}\.){3}\d{1,3}\/\d{1,3}$/;
const IP_REGEX = /^(\d{1,3}\.){3}\d{1,3}$/;

function validateSubnets(text: string): string[] {
  const lines = text
    .split(/\n|,/)
    .map(v => v.trim())
    .filter(Boolean);

  const errors: string[] = [];
  for (const line of lines) {
    if (CIDR_REGEX.test(line)) {
      const [ip, prefix] = line.split('/');
      const octets = ip.split('.').map(Number);
      const prefixNum = Number(prefix);
      if (octets.some(o => o > 255)) {
        errors.push(`"${line}": octet value exceeds 255`);
      } else if (prefixNum > 32) {
        errors.push(`"${line}": prefix length must be 0–32`);
      }
    } else if (IP_REGEX.test(line)) {
      const octets = line.split('.').map(Number);
      if (octets.some(o => o > 255)) {
        errors.push(`"${line}": octet value exceeds 255`);
      }
      // bare IP is accepted (treated as /32)
    } else {
      errors.push(`"${line}": not a valid CIDR range or IP address`);
    }
  }
  return errors;
}

const defaultValues: DiscoveryProfileFormValues = {
  name: '',
  siteId: '',
  subnets: [],
  methods: ['ping', 'snmp'],
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
  sites = [],
  onSubmit,
  onCancel,
  submitLabel = 'Save Profile',
  disabled = false
}: DiscoveryProfileFormProps) {
  const [formValues, setFormValues] = useState<DiscoveryProfileFormValues>(initialValues ?? defaultValues);
  const [subnetsText, setSubnetsText] = useState((initialValues?.subnets ?? []).join('\n'));
  const [subnetErrors, setSubnetErrors] = useState<string[]>([]);

  useEffect(() => {
    setSubnetErrors([]);
    if (initialValues) {
      setFormValues(initialValues);
      setSubnetsText(initialValues.subnets.join('\n'));
      return;
    }

    // Auto-select first site if only one available
    const autoSiteId = sites.length === 1 ? sites[0].id : '';
    setFormValues({ ...defaultValues, siteId: autoSiteId });
    setSubnetsText('');
  }, [initialValues, sites]);

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

    if (subnets.length === 0) {
      setSubnetErrors(['At least one subnet or IP address is required.']);
      return;
    }

    const errors = validateSubnets(subnetsText);
    if (errors.length > 0) {
      setSubnetErrors(errors);
      return;
    }

    onSubmit?.({
      ...formValues,
      subnets
    });
  };

  const handleSubnetsChange = useCallback((value: string) => {
    setSubnetsText(value);
    setSubnetErrors([]);
  }, []);

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
            <label className="text-sm font-medium">Site</label>
            <select
              value={formValues.siteId}
              onChange={event => setFormValues(prev => ({ ...prev, siteId: event.target.value }))}
              className="mt-2 h-10 w-full rounded-md border bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
            >
              <option value="">Select a site...</option>
              {sites.map(site => (
                <option key={site.id} value={site.id}>{site.name}</option>
              ))}
            </select>
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
              onChange={event => handleSubnetsChange(event.target.value)}
              placeholder={"10.0.0.0/24\n10.0.1.0/24"}
              className={`mt-2 h-24 w-full rounded-md border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring ${subnetErrors.length > 0 ? 'border-destructive' : ''}`}
            />
            <p className="mt-2 text-xs text-muted-foreground">
              Enter CIDR ranges separated by commas or new lines.
            </p>
            {subnetErrors.length > 0 && (
              <div className="mt-1 space-y-0.5">
                {subnetErrors.map((err, i) => (
                  <p key={i} className="text-xs text-destructive">{err}</p>
                ))}
              </div>
            )}
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
          disabled={disabled}
          className="h-10 rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {submitLabel}
        </button>
      </div>
    </form>
  );
}
