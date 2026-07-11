import { useEffect, useState, type FormEvent, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';

export type DiscoverySchedule = {
  cadence: 'hourly' | 'interval' | 'daily' | 'weekly' | 'monthly';
  intervalHours?: number;
  intervalMinutes?: number;
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

export type ProfileAlertSettings = {
  enabled: boolean;
  alertOnNew: boolean;
  alertOnDisappeared: boolean;
  alertOnChanged: boolean;
  changeRetentionDays: number;
};

export const defaultAlertSettings: ProfileAlertSettings = {
  enabled: false,
  alertOnNew: true,
  alertOnDisappeared: true,
  alertOnChanged: true,
  changeRetentionDays: 90
};

export type DiscoveryProfileFormValues = {
  name: string;
  siteId: string;
  subnets: string[];
  methods: string[];
  schedule: DiscoverySchedule;
  snmp: SnmpSettings;
  alertSettings: ProfileAlertSettings;
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
  error?: string;
};

const methodOptions = [
  { id: 'ping', labelKey: 'discoveryProfileForm.methods.ping' },
  { id: 'arp', labelKey: 'discoveryProfileForm.methods.arp' },
  { id: 'snmp', labelKey: 'discoveryProfileForm.methods.snmp' },
  { id: 'port_scan', labelKey: 'discoveryProfileForm.methods.portScan' }
];

const dayOptions = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
const hourlyIntervalOptions = [1, 2, 3, 4, 6, 8, 12, 24];

const CIDR_REGEX = /^(\d{1,3}\.){3}\d{1,3}\/\d{1,3}$/;
const IP_REGEX = /^(\d{1,3}\.){3}\d{1,3}$/;

function validateSubnets(text: string, t: TFunction): string[] {
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
        errors.push(t('discoveryProfileForm.validation.octet', { value: line }));
      } else if (prefixNum > 32) {
        errors.push(t('discoveryProfileForm.validation.prefix', { value: line }));
      }
    } else if (IP_REGEX.test(line)) {
      const octets = line.split('.').map(Number);
      if (octets.some(o => o > 255)) {
        errors.push(t('discoveryProfileForm.validation.octet', { value: line }));
      }
      // bare IP is accepted (treated as /32)
    } else {
      errors.push(t('discoveryProfileForm.validation.invalidCidr', { value: line }));
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
    intervalHours: 1,
    intervalMinutes: 60,
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
  },
  alertSettings: { ...defaultAlertSettings }
};

export default function DiscoveryProfileForm({
  initialValues,
  sites = [],
  onSubmit,
  onCancel,
  submitLabel,
  disabled = false,
  error
}: DiscoveryProfileFormProps) {
  const { t } = useTranslation('discovery');
  const [formValues, setFormValues] = useState<DiscoveryProfileFormValues>(initialValues ?? defaultValues);
  const [subnetsText, setSubnetsText] = useState((initialValues?.subnets ?? []).join('\n'));
  const [subnetErrors, setSubnetErrors] = useState<string[]>([]);
  const isSnmpEnabled = formValues.methods.includes('snmp');
  const resolvedSubmitLabel = submitLabel ?? t('discoveryProfileForm.actions.saveProfile');

  useEffect(() => {
    setSubnetErrors([]);
    if (initialValues) {
      setFormValues({
        ...initialValues,
        alertSettings: initialValues.alertSettings ?? defaultAlertSettings
      });
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
      setSubnetErrors([t('discoveryProfileForm.validation.subnetRequired')]);
      return;
    }

    const errors = validateSubnets(subnetsText, t);
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
      <div className="rounded-lg border bg-card p-6 shadow-xs">
        <h2 className="text-lg font-semibold">{t('discoveryProfileForm.profileDetails.title')}</h2>
        <p className="text-sm text-muted-foreground">{t('discoveryProfileForm.profileDetails.description')}</p>

        <div className="mt-4 grid gap-4 md:grid-cols-2">
          <div>
            <label className="text-sm font-medium">{t('discoveryProfileForm.fields.profileName')}</label>
            <input
              type="text"
              value={formValues.name}
              onChange={event => setFormValues(prev => ({ ...prev, name: event.target.value }))}
              placeholder={t('discoveryProfileForm.placeholders.profileName')}
              className="mt-2 h-10 w-full rounded-md border bg-background px-3 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring"
            />
          </div>
          <div>
            <label className="text-sm font-medium">{t('common:labels.site')}</label>
            <select
              value={formValues.siteId}
              onChange={event => setFormValues(prev => ({ ...prev, siteId: event.target.value }))}
              className="mt-2 h-10 w-full rounded-md border bg-background px-3 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring"
            >
              <option value="">{t('discoveryProfileForm.options.selectSite')}</option>
              {sites.map(site => (
                <option key={site.id} value={site.id}>{site.name}</option>
              ))}
            </select>
          </div>
          <div>
            <label className="text-sm font-medium">{t('discoveryProfileForm.fields.scheduleCadence')}</label>
            <select
              value={formValues.schedule.cadence}
              onChange={event => {
                const cadence = event.target.value as DiscoverySchedule['cadence'];
                setFormValues(prev => ({
                  ...prev,
                  schedule: {
                    ...prev.schedule,
                    cadence,
                    intervalHours: cadence === 'hourly'
                      ? (prev.schedule.intervalHours && prev.schedule.intervalHours > 0 ? prev.schedule.intervalHours : 1)
                      : prev.schedule.intervalHours,
                    intervalMinutes: cadence === 'interval'
                      ? (prev.schedule.intervalMinutes && prev.schedule.intervalMinutes > 0 ? prev.schedule.intervalMinutes : 30)
                      : prev.schedule.intervalMinutes
                  }
                }));
              }}
              className="mt-2 h-10 w-full rounded-md border bg-background px-3 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring"
            >
              <option value="hourly">{t('discoveryProfileForm.cadence.hourly')}</option>
              <option value="interval">{t('discoveryProfileForm.cadence.interval')}</option>
              <option value="daily">{t('discoveryProfileForm.cadence.daily')}</option>
              <option value="weekly">{t('discoveryProfileForm.cadence.weekly')}</option>
              <option value="monthly">{t('discoveryProfileForm.cadence.monthly')}</option>
            </select>
          </div>
          <div className="md:col-span-2">
            <label className="text-sm font-medium">{t('discoveryProfileForm.fields.subnets')}</label>
            <textarea
              value={subnetsText}
              onChange={event => handleSubnetsChange(event.target.value)}
              placeholder={t('discoveryProfileForm.placeholders.subnets')}
              className={`mt-2 h-24 w-full rounded-md border bg-background px-3 py-2 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring ${subnetErrors.length > 0 ? 'border-destructive' : ''}`}
            />
            <p className="mt-2 text-xs text-muted-foreground">
              {t('discoveryProfileForm.subnetsHelp')}
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
          <label className="text-sm font-medium">{t('discoveryProfileForm.fields.methods')}</label>
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
                  className="h-4 w-4 rounded border-border"
                />
                {t(option.labelKey)}
              </label>
            ))}
          </div>
        </div>
      </div>

      <div className="rounded-lg border bg-card p-6 shadow-xs">
        <h2 className="text-lg font-semibold">{t('discoveryProfileForm.schedule.title')}</h2>
        <p className="text-sm text-muted-foreground">{t('discoveryProfileForm.schedule.description')}</p>

        <div className="mt-4 grid gap-4 md:grid-cols-3">
          {formValues.schedule.cadence === 'hourly' ? (
            <div>
              <label className="text-sm font-medium">{t('discoveryProfileForm.fields.repeatEvery')}</label>
              <select
                value={formValues.schedule.intervalHours ?? 1}
                onChange={event =>
                  setFormValues(prev => ({
                    ...prev,
                    schedule: { ...prev.schedule, intervalHours: Math.max(1, Number(event.target.value) || 1) }
                  }))
                }
                className="mt-2 h-10 w-full rounded-md border bg-background px-3 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring"
              >
                {hourlyIntervalOptions.map(hours => (
                  <option key={hours} value={hours}>
                    {t('discoveryProfileForm.options.everyHours', { count: hours })}
                  </option>
                ))}
              </select>
            </div>
          ) : formValues.schedule.cadence === 'interval' ? (
            <div>
              <label className="text-sm font-medium">{t('discoveryProfileForm.fields.repeatEveryMinutes')}</label>
              <input
                type="number"
                min={1}
                max={10080}
                value={formValues.schedule.intervalMinutes ?? 30}
                onChange={event =>
                  setFormValues(prev => ({
                    ...prev,
                    schedule: {
                      ...prev.schedule,
                      intervalMinutes: Math.max(1, Number(event.target.value) || 1)
                    }
                  }))
                }
                className="mt-2 h-10 w-full rounded-md border bg-background px-3 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring"
              />
            </div>
          ) : (
            <>
              <div>
                <label className="text-sm font-medium">{t('discoveryProfileForm.fields.time')}</label>
                <input
                  type="time"
                  value={formValues.schedule.time}
                  onChange={event =>
                    setFormValues(prev => ({
                      ...prev,
                      schedule: { ...prev.schedule, time: event.target.value }
                    }))
                  }
                  className="mt-2 h-10 w-full rounded-md border bg-background px-3 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring"
                />
              </div>
              <div>
                <label className="text-sm font-medium">{t('discoveryProfileForm.fields.timezone')}</label>
                <select
                  value={formValues.schedule.timezone}
                  onChange={event =>
                    setFormValues(prev => ({
                      ...prev,
                      schedule: { ...prev.schedule, timezone: event.target.value }
                    }))
                  }
                  className="mt-2 h-10 w-full rounded-md border bg-background px-3 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring"
                >
                  <option value="UTC">UTC</option>
                  <option value="America/New_York">America/New_York</option>
                  <option value="America/Chicago">America/Chicago</option>
                  <option value="America/Denver">America/Denver</option>
                  <option value="America/Los_Angeles">America/Los_Angeles</option>
                </select>
              </div>
            </>
          )}
          {formValues.schedule.cadence === 'weekly' && (
            <div>
              <label className="text-sm font-medium">{t('discoveryProfileForm.fields.dayOfWeek')}</label>
              <select
                value={formValues.schedule.dayOfWeek}
                onChange={event =>
                  setFormValues(prev => ({
                    ...prev,
                    schedule: { ...prev.schedule, dayOfWeek: event.target.value }
                  }))
                }
                className="mt-2 h-10 w-full rounded-md border bg-background px-3 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring"
              >
                {dayOptions.map(day => (
                  <option key={day} value={day}>
                    {t(`discoveryProfileForm.days.${day.toLowerCase()}`)}
                  </option>
                ))}
              </select>
            </div>
          )}
          {formValues.schedule.cadence === 'monthly' && (
            <div>
              <label className="text-sm font-medium">{t('discoveryProfileForm.fields.dayOfMonth')}</label>
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
                className="mt-2 h-10 w-full rounded-md border bg-background px-3 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring"
              />
            </div>
          )}
        </div>
      </div>

      {isSnmpEnabled && (
        <div className="rounded-lg border bg-card p-6 shadow-xs" data-testid="discovery-snmp-settings">
          <h2 className="text-lg font-semibold">{t('discoveryProfileForm.snmp.title')}</h2>
          <p className="text-sm text-muted-foreground">{t('discoveryProfileForm.snmp.description')}</p>

          <div className="mt-4 grid gap-4 md:grid-cols-2">
            <div>
              <label className="text-sm font-medium">{t('discoveryProfileForm.fields.snmpVersion')}</label>
              <select
                value={formValues.snmp.version}
                onChange={event =>
                  setFormValues(prev => ({
                    ...prev,
                    snmp: { ...prev.snmp, version: event.target.value as SnmpSettings['version'] }
                  }))
                }
                className="mt-2 h-10 w-full rounded-md border bg-background px-3 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring"
              >
                <option value="v2c">v2c</option>
                <option value="v3">v3</option>
              </select>
            </div>
            <div>
              <label className="text-sm font-medium">{t('discoveryProfileForm.fields.port')}</label>
              <input
                type="number"
                value={formValues.snmp.port}
                onChange={event =>
                  setFormValues(prev => ({
                    ...prev,
                    snmp: { ...prev.snmp, port: Number(event.target.value) }
                  }))
                }
                className="mt-2 h-10 w-full rounded-md border bg-background px-3 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring"
              />
            </div>
            <div>
              <label className="text-sm font-medium">{t('discoveryProfileForm.fields.timeout')}</label>
              <input
                type="number"
                value={formValues.snmp.timeout}
                onChange={event =>
                  setFormValues(prev => ({
                    ...prev,
                    snmp: { ...prev.snmp, timeout: Number(event.target.value) }
                  }))
                }
                className="mt-2 h-10 w-full rounded-md border bg-background px-3 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring"
              />
            </div>
            <div>
              <label className="text-sm font-medium">{t('discoveryProfileForm.fields.retries')}</label>
              <input
                type="number"
                value={formValues.snmp.retries}
                onChange={event =>
                  setFormValues(prev => ({
                    ...prev,
                    snmp: { ...prev.snmp, retries: Number(event.target.value) }
                  }))
                }
                className="mt-2 h-10 w-full rounded-md border bg-background px-3 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring"
              />
            </div>

            {formValues.snmp.version === 'v2c' ? (
              <div className="md:col-span-2">
                <label className="text-sm font-medium">{t('discoveryProfileForm.fields.community')}</label>
                <input
                  type="text"
                  value={formValues.snmp.community}
                  onChange={event =>
                    setFormValues(prev => ({
                      ...prev,
                      snmp: { ...prev.snmp, community: event.target.value }
                    }))
                  }
                  className="mt-2 h-10 w-full rounded-md border bg-background px-3 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring"
                />
              </div>
            ) : (
              <>
                <div>
                  <label className="text-sm font-medium">{t('discoveryProfileForm.fields.username')}</label>
                  <input
                    type="text"
                    value={formValues.snmp.username}
                    onChange={event =>
                      setFormValues(prev => ({
                        ...prev,
                        snmp: { ...prev.snmp, username: event.target.value }
                      }))
                    }
                    className="mt-2 h-10 w-full rounded-md border bg-background px-3 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring"
                  />
                </div>
                <div>
                  <label className="text-sm font-medium">{t('discoveryProfileForm.fields.authProtocol')}</label>
                  <select
                    value={formValues.snmp.authProtocol}
                    onChange={event =>
                      setFormValues(prev => ({
                        ...prev,
                        snmp: { ...prev.snmp, authProtocol: event.target.value as SnmpSettings['authProtocol'] }
                      }))
                    }
                    className="mt-2 h-10 w-full rounded-md border bg-background px-3 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring"
                  >
                    <option value="sha">SHA</option>
                    <option value="md5">MD5</option>
                  </select>
                </div>
                <div>
                  <label className="text-sm font-medium">{t('discoveryProfileForm.fields.authPassphrase')}</label>
                  <input
                    type="password"
                    value={formValues.snmp.authPassphrase}
                    onChange={event =>
                      setFormValues(prev => ({
                        ...prev,
                        snmp: { ...prev.snmp, authPassphrase: event.target.value }
                      }))
                    }
                    className="mt-2 h-10 w-full rounded-md border bg-background px-3 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring"
                  />
                </div>
                <div>
                  <label className="text-sm font-medium">{t('discoveryProfileForm.fields.privacyProtocol')}</label>
                  <select
                    value={formValues.snmp.privacyProtocol}
                    onChange={event =>
                      setFormValues(prev => ({
                        ...prev,
                        snmp: { ...prev.snmp, privacyProtocol: event.target.value as SnmpSettings['privacyProtocol'] }
                      }))
                    }
                    className="mt-2 h-10 w-full rounded-md border bg-background px-3 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring"
                  >
                    <option value="aes">AES</option>
                    <option value="des">DES</option>
                  </select>
                </div>
                <div>
                  <label className="text-sm font-medium">{t('discoveryProfileForm.fields.privacyPassphrase')}</label>
                  <input
                    type="password"
                    value={formValues.snmp.privacyPassphrase}
                    onChange={event =>
                      setFormValues(prev => ({
                        ...prev,
                        snmp: { ...prev.snmp, privacyPassphrase: event.target.value }
                      }))
                    }
                    className="mt-2 h-10 w-full rounded-md border bg-background px-3 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring"
                  />
                </div>
              </>
            )}
          </div>
        </div>
      )}

      <div className="rounded-lg border bg-card p-6 shadow-xs">
        <h2 className="text-lg font-semibold">{t('discoveryProfileForm.alerting.title')}</h2>
        <p className="text-sm text-muted-foreground">{t('discoveryProfileForm.alerting.description')}</p>

        <label className="mt-3 flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={formValues.alertSettings.enabled}
            onChange={e => setFormValues(prev => ({
              ...prev,
              alertSettings: { ...prev.alertSettings, enabled: e.target.checked }
            }))}
            className="h-4 w-4 rounded border"
          />
          {t('discoveryProfileForm.alerting.enable')}
        </label>

        {formValues.alertSettings.enabled && (
          <div className="mt-3 rounded-md border p-3 space-y-2 text-sm">
            {(['alertOnNew', 'alertOnDisappeared', 'alertOnChanged'] as const).map(key => (
              <label key={key} className="flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={formValues.alertSettings[key]}
                  onChange={e => setFormValues(prev => ({
                    ...prev,
                    alertSettings: { ...prev.alertSettings, [key]: e.target.checked }
                  }))}
                  className="h-4 w-4 rounded border"
                />
                {t(`discoveryProfileForm.alerting.${key}`)}
              </label>
            ))}
            <div className="pt-1">
              <label className="block text-xs font-medium text-muted-foreground mb-1">{t('discoveryProfileForm.fields.retainChangeLog')}</label>
              <input
                type="number"
                min={1}
                max={365}
                value={formValues.alertSettings.changeRetentionDays}
                onChange={e => setFormValues(prev => ({
                  ...prev,
                  alertSettings: { ...prev.alertSettings, changeRetentionDays: Number(e.target.value) || 90 }
                }))}
                className="h-9 w-32 rounded-md border bg-background px-3 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring"
              />
            </div>
          </div>
        )}
      </div>

      <div className="flex items-center justify-end gap-3">
        {error && (
          <p className="mr-auto rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">
            {error}
          </p>
        )}
        {onCancel && (
          <button
            type="button"
            onClick={onCancel}
            className="h-10 rounded-md border px-4 text-sm font-medium text-muted-foreground hover:text-foreground"
          >
            {t('common:actions.cancel')}
          </button>
        )}
        <button
          type="submit"
          disabled={disabled}
          className="h-10 rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {resolvedSubmitLabel}
        </button>
      </div>
    </form>
  );
}
