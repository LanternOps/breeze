import { useCallback, useEffect, useState } from 'react';
import {
  Building2,
  Calendar,
  CheckCircle2,
  Clock,
  Globe,
  Loader2,
  Mail,
  Phone,
  Save,
  User
} from 'lucide-react';
import { fetchWithAuth } from '../../stores/auth';
import { useOrgStore } from '../../stores/orgStore';
import type { PartnerSettings, BusinessHoursPreset, DateFormat, TimeFormat, DaySchedule } from '@breeze/shared';

type Partner = {
  id: string;
  name: string;
  slug: string;
  type: string;
  plan: string;
  settings: PartnerSettings;
  createdAt: string;
};

const TIMEZONES = [
  'UTC',
  'America/New_York',
  'America/Chicago',
  'America/Denver',
  'America/Los_Angeles',
  'America/Phoenix',
  'America/Anchorage',
  'Pacific/Honolulu',
  'Europe/London',
  'Europe/Paris',
  'Europe/Berlin',
  'Asia/Tokyo',
  'Asia/Shanghai',
  'Asia/Singapore',
  'Australia/Sydney'
];

const DATE_FORMATS: { value: DateFormat; label: string }[] = [
  { value: 'MM/DD/YYYY', label: 'MM/DD/YYYY (US)' },
  { value: 'DD/MM/YYYY', label: 'DD/MM/YYYY (International)' },
  { value: 'YYYY-MM-DD', label: 'YYYY-MM-DD (ISO)' }
];

const BUSINESS_HOURS_PRESETS: { value: BusinessHoursPreset; label: string; description: string }[] = [
  { value: '24/7', label: '24/7', description: 'Always available' },
  { value: 'business', label: 'Business Hours', description: 'Mon-Fri 9am-5pm' },
  { value: 'extended', label: 'Extended Hours', description: 'Mon-Fri 7am-7pm, Sat 9am-1pm' },
  { value: 'custom', label: 'Custom', description: 'Set your own schedule' }
];

const DAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'] as const;
const DAY_LABELS: Record<string, string> = {
  mon: 'Monday',
  tue: 'Tuesday',
  wed: 'Wednesday',
  thu: 'Thursday',
  fri: 'Friday',
  sat: 'Saturday',
  sun: 'Sunday'
};

const DEFAULT_BUSINESS_HOURS: Record<string, DaySchedule> = {
  mon: { start: '09:00', end: '17:00' },
  tue: { start: '09:00', end: '17:00' },
  wed: { start: '09:00', end: '17:00' },
  thu: { start: '09:00', end: '17:00' },
  fri: { start: '09:00', end: '17:00' },
  sat: { start: '09:00', end: '17:00', closed: true },
  sun: { start: '09:00', end: '17:00', closed: true }
};

export default function PartnerSettingsPage() {
  const { currentPartnerId, isLoading: contextLoading } = useOrgStore();
  const [partner, setPartner] = useState<Partner | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();
  const [successMessage, setSuccessMessage] = useState<string>();

  // Form state
  const [timezone, setTimezone] = useState('UTC');
  const [dateFormat, setDateFormat] = useState<DateFormat>('MM/DD/YYYY');
  const [timeFormat, setTimeFormat] = useState<TimeFormat>('12h');
  const [businessHoursPreset, setBusinessHoursPreset] = useState<BusinessHoursPreset>('business');
  const [customHours, setCustomHours] = useState<Record<string, DaySchedule>>(DEFAULT_BUSINESS_HOURS);
  const [contactName, setContactName] = useState('');
  const [contactEmail, setContactEmail] = useState('');
  const [contactPhone, setContactPhone] = useState('');
  const [contactWebsite, setContactWebsite] = useState('');

  const fetchPartner = useCallback(async () => {
    try {
      setLoading(true);
      setError(undefined);
      const response = await fetchWithAuth('/orgs/partners/me');
      if (!response.ok) {
        if (response.status === 401) {
          window.location.href = '/login';
          return;
        }
        if (response.status === 403) {
          setError('You do not have permission to view partner settings');
          return;
        }
        throw new Error('Failed to fetch partner settings');
      }
      const data: Partner = await response.json();
      setPartner(data);

      // Populate form with existing settings
      const settings = data.settings || {};
      setTimezone(settings.timezone || 'UTC');
      setDateFormat(settings.dateFormat || 'MM/DD/YYYY');
      setTimeFormat(settings.timeFormat || '12h');
      setBusinessHoursPreset(settings.businessHours?.preset || 'business');
      if (settings.businessHours?.custom) {
        setCustomHours({ ...DEFAULT_BUSINESS_HOURS, ...settings.businessHours.custom });
      }
      setContactName(settings.contact?.name || '');
      setContactEmail(settings.contact?.email || '');
      setContactPhone(settings.contact?.phone || '');
      setContactWebsite(settings.contact?.website || '');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'An error occurred');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (currentPartnerId) {
      fetchPartner();
    } else {
      setLoading(contextLoading);
    }
  }, [currentPartnerId, contextLoading, fetchPartner]);

  const handleSave = async () => {
    try {
      setSaving(true);
      setError(undefined);
      setSuccessMessage(undefined);

      const settings: PartnerSettings = {
        timezone,
        dateFormat,
        timeFormat,
        language: 'en',
        businessHours: {
          preset: businessHoursPreset,
          ...(businessHoursPreset === 'custom' ? { custom: customHours } : {})
        },
        contact: {
          name: contactName || undefined,
          email: contactEmail || undefined,
          phone: contactPhone || undefined,
          website: contactWebsite || undefined
        }
      };

      const response = await fetchWithAuth('/orgs/partners/me', {
        method: 'PATCH',
        body: JSON.stringify({ settings })
      });

      if (!response.ok) {
        throw new Error('Failed to save settings');
      }

      const updated = await response.json();
      setPartner(updated);
      setSuccessMessage('Settings saved successfully');
      setTimeout(() => setSuccessMessage(undefined), 3000);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save settings');
    } finally {
      setSaving(false);
    }
  };

  const updateCustomHours = (day: string, field: keyof DaySchedule, value: string | boolean) => {
    setCustomHours(prev => ({
      ...prev,
      [day]: { ...prev[day], [field]: value }
    }));
  };

  // Not partner-scoped
  if (!currentPartnerId) {
    return (
      <div className="rounded-lg border border-amber-200 bg-amber-50 p-6 text-center dark:border-amber-800 dark:bg-amber-950">
        <Building2 className="mx-auto h-12 w-12 text-amber-500" />
        <h2 className="mt-4 text-lg font-semibold">Partner Access Required</h2>
        <p className="mt-2 text-sm text-muted-foreground">
          Partner settings are only available to partner-level users.
        </p>
      </div>
    );
  }

  // Loading state
  if (loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <div className="text-center">
          <Loader2 className="h-8 w-8 animate-spin mx-auto text-primary" />
          <p className="mt-4 text-sm text-muted-foreground">Loading partner settings...</p>
        </div>
      </div>
    );
  }

  // Error state
  if (error && !partner) {
    return (
      <div className="rounded-lg border border-destructive/40 bg-destructive/10 p-6 text-center">
        <p className="text-sm text-destructive">{error}</p>
        <button
          type="button"
          onClick={fetchPartner}
          className="mt-4 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:opacity-90"
        >
          Try again
        </button>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-4xl space-y-6">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold">Partner Settings</h1>
          <p className="text-sm text-muted-foreground">
            Configure defaults for {partner?.name || 'your MSP'}.
          </p>
        </div>
        <button
          type="button"
          onClick={handleSave}
          disabled={saving}
          className="inline-flex items-center gap-2 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition hover:opacity-90 disabled:opacity-50"
        >
          {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
          {saving ? 'Saving...' : 'Save Settings'}
        </button>
      </header>

      {successMessage && (
        <div className="flex items-center gap-2 rounded-lg border border-emerald-200 bg-emerald-50 p-4 text-emerald-900 dark:border-emerald-800 dark:bg-emerald-950 dark:text-emerald-100">
          <CheckCircle2 className="h-5 w-5" />
          <p className="text-sm font-medium">{successMessage}</p>
        </div>
      )}

      {error && (
        <div className="rounded-lg border border-destructive/40 bg-destructive/10 p-4 text-destructive">
          <p className="text-sm">{error}</p>
        </div>
      )}

      {/* Regional Settings */}
      <section className="rounded-lg border bg-card p-6 shadow-sm">
        <div className="mb-6">
          <div className="flex items-center gap-2">
            <Globe className="h-5 w-5 text-muted-foreground" />
            <h2 className="text-lg font-semibold">Regional Settings</h2>
          </div>
          <p className="mt-1 text-sm text-muted-foreground">
            These defaults apply to new organizations and sites.
          </p>
        </div>

        <div className="grid gap-6 sm:grid-cols-2">
          <div className="space-y-2">
            <label className="text-sm font-medium">Timezone</label>
            <select
              value={timezone}
              onChange={e => setTimezone(e.target.value)}
              className="h-10 w-full rounded-md border bg-background px-3 text-sm"
            >
              {TIMEZONES.map(tz => (
                <option key={tz} value={tz}>{tz}</option>
              ))}
            </select>
          </div>

          <div className="space-y-2">
            <label className="text-sm font-medium">Date Format</label>
            <select
              value={dateFormat}
              onChange={e => setDateFormat(e.target.value as DateFormat)}
              className="h-10 w-full rounded-md border bg-background px-3 text-sm"
            >
              {DATE_FORMATS.map(fmt => (
                <option key={fmt.value} value={fmt.value}>{fmt.label}</option>
              ))}
            </select>
          </div>

          <div className="space-y-2">
            <label className="text-sm font-medium">Time Format</label>
            <div className="flex gap-4">
              <label className="flex items-center gap-2">
                <input
                  type="radio"
                  name="timeFormat"
                  checked={timeFormat === '12h'}
                  onChange={() => setTimeFormat('12h')}
                  className="h-4 w-4"
                />
                <span className="text-sm">12-hour</span>
              </label>
              <label className="flex items-center gap-2">
                <input
                  type="radio"
                  name="timeFormat"
                  checked={timeFormat === '24h'}
                  onChange={() => setTimeFormat('24h')}
                  className="h-4 w-4"
                />
                <span className="text-sm">24-hour</span>
              </label>
            </div>
          </div>

          <div className="space-y-2">
            <label className="text-sm font-medium">Language</label>
            <select
              value="en"
              disabled
              className="h-10 w-full rounded-md border bg-muted px-3 text-sm text-muted-foreground"
            >
              <option value="en">English</option>
            </select>
            <p className="text-xs text-muted-foreground">More languages coming soon</p>
          </div>
        </div>
      </section>

      {/* Business Hours */}
      <section className="rounded-lg border bg-card p-6 shadow-sm">
        <div className="mb-6">
          <div className="flex items-center gap-2">
            <Clock className="h-5 w-5 text-muted-foreground" />
            <h2 className="text-lg font-semibold">Business Hours</h2>
          </div>
          <p className="mt-1 text-sm text-muted-foreground">
            Set your standard operating hours for support and alerts.
          </p>
        </div>

        <div className="space-y-4">
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            {BUSINESS_HOURS_PRESETS.map(preset => (
              <label
                key={preset.value}
                className={`cursor-pointer rounded-lg border p-4 transition ${
                  businessHoursPreset === preset.value
                    ? 'border-primary bg-primary/5'
                    : 'hover:border-muted-foreground/50'
                }`}
              >
                <input
                  type="radio"
                  name="businessHoursPreset"
                  value={preset.value}
                  checked={businessHoursPreset === preset.value}
                  onChange={() => setBusinessHoursPreset(preset.value)}
                  className="sr-only"
                />
                <div className="font-medium">{preset.label}</div>
                <div className="text-xs text-muted-foreground">{preset.description}</div>
              </label>
            ))}
          </div>

          {businessHoursPreset === 'custom' && (
            <div className="mt-4 space-y-3 rounded-lg border bg-muted/40 p-4">
              <p className="text-sm font-medium">Custom Schedule</p>
              {DAYS.map(day => (
                <div key={day} className="flex items-center gap-4">
                  <div className="w-24 text-sm font-medium">{DAY_LABELS[day]}</div>
                  <label className="flex items-center gap-2">
                    <input
                      type="checkbox"
                      checked={!customHours[day]?.closed}
                      onChange={e => updateCustomHours(day, 'closed', !e.target.checked)}
                      className="h-4 w-4"
                    />
                    <span className="text-sm">Open</span>
                  </label>
                  {!customHours[day]?.closed && (
                    <>
                      <input
                        type="time"
                        value={customHours[day]?.start || '09:00'}
                        onChange={e => updateCustomHours(day, 'start', e.target.value)}
                        className="h-8 rounded-md border bg-background px-2 text-sm"
                      />
                      <span className="text-sm text-muted-foreground">to</span>
                      <input
                        type="time"
                        value={customHours[day]?.end || '17:00'}
                        onChange={e => updateCustomHours(day, 'end', e.target.value)}
                        className="h-8 rounded-md border bg-background px-2 text-sm"
                      />
                    </>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      </section>

      {/* Contact Information */}
      <section className="rounded-lg border bg-card p-6 shadow-sm">
        <div className="mb-6">
          <div className="flex items-center gap-2">
            <User className="h-5 w-5 text-muted-foreground" />
            <h2 className="text-lg font-semibold">Contact Information</h2>
          </div>
          <p className="mt-1 text-sm text-muted-foreground">
            Primary contact for your MSP.
          </p>
        </div>

        <div className="grid gap-6 sm:grid-cols-2">
          <div className="space-y-2">
            <label className="flex items-center gap-2 text-sm font-medium">
              <User className="h-4 w-4 text-muted-foreground" />
              Contact Name
            </label>
            <input
              type="text"
              value={contactName}
              onChange={e => setContactName(e.target.value)}
              placeholder="John Smith"
              className="h-10 w-full rounded-md border bg-background px-3 text-sm"
            />
          </div>

          <div className="space-y-2">
            <label className="flex items-center gap-2 text-sm font-medium">
              <Mail className="h-4 w-4 text-muted-foreground" />
              Email
            </label>
            <input
              type="email"
              value={contactEmail}
              onChange={e => setContactEmail(e.target.value)}
              placeholder="contact@example.com"
              className="h-10 w-full rounded-md border bg-background px-3 text-sm"
            />
          </div>

          <div className="space-y-2">
            <label className="flex items-center gap-2 text-sm font-medium">
              <Phone className="h-4 w-4 text-muted-foreground" />
              Phone
            </label>
            <input
              type="tel"
              value={contactPhone}
              onChange={e => setContactPhone(e.target.value)}
              placeholder="+1 (555) 123-4567"
              className="h-10 w-full rounded-md border bg-background px-3 text-sm"
            />
          </div>

          <div className="space-y-2">
            <label className="flex items-center gap-2 text-sm font-medium">
              <Calendar className="h-4 w-4 text-muted-foreground" />
              Website
            </label>
            <input
              type="url"
              value={contactWebsite}
              onChange={e => setContactWebsite(e.target.value)}
              placeholder="https://example.com"
              className="h-10 w-full rounded-md border bg-background px-3 text-sm"
            />
          </div>
        </div>
      </section>
    </div>
  );
}
