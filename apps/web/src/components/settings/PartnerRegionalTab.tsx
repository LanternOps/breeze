import { Clock, Globe } from 'lucide-react';
import KnownGuestsSettings from './KnownGuestsSettings';
import type { BusinessHoursPreset, DateFormat, TimeFormat, DaySchedule } from '@breeze/shared';

const TIMEZONES = [
  'UTC', 'America/New_York', 'America/Chicago', 'America/Denver',
  'America/Los_Angeles', 'America/Phoenix', 'America/Anchorage',
  'Pacific/Honolulu', 'Europe/London', 'Europe/Paris', 'Europe/Berlin',
  'Asia/Tokyo', 'Asia/Shanghai', 'Asia/Singapore', 'Australia/Sydney'
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
const DAY_LABELS: Record<string, string> = { mon: 'Monday', tue: 'Tuesday', wed: 'Wednesday', thu: 'Thursday', fri: 'Friday', sat: 'Saturday', sun: 'Sunday' };
const BH: DaySchedule = { start: '09:00', end: '17:00' };
const BH_CLOSED: DaySchedule = { start: '09:00', end: '17:00', closed: true };
export const DEFAULT_BUSINESS_HOURS: Record<string, DaySchedule> = { mon: BH, tue: BH, wed: BH, thu: BH, fri: BH, sat: BH_CLOSED, sun: BH_CLOSED };

type PartnerRegionalTabProps = {
  timezone: string;
  dateFormat: DateFormat;
  timeFormat: TimeFormat;
  businessHoursPreset: BusinessHoursPreset;
  customHours: Record<string, DaySchedule>;
  onTimezoneChange: (value: string) => void;
  onDateFormatChange: (value: DateFormat) => void;
  onTimeFormatChange: (value: TimeFormat) => void;
  onBusinessHoursPresetChange: (value: BusinessHoursPreset) => void;
  onCustomHoursChange: (day: string, field: keyof DaySchedule, value: string | boolean) => void;
};

export default function PartnerRegionalTab({
  timezone,
  dateFormat,
  timeFormat,
  businessHoursPreset,
  customHours,
  onTimezoneChange,
  onDateFormatChange,
  onTimeFormatChange,
  onBusinessHoursPresetChange,
  onCustomHoursChange,
}: PartnerRegionalTabProps) {
  return (
    <>
      <section className="rounded-lg border bg-card p-6 shadow-xs">
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
            <select value={timezone} onChange={e => onTimezoneChange(e.target.value)}
              className="h-10 w-full rounded-md border bg-background px-3 text-sm">
              {TIMEZONES.map(tz => <option key={tz} value={tz}>{tz}</option>)}
            </select>
          </div>
          <div className="space-y-2">
            <label className="text-sm font-medium">Date Format</label>
            <select value={dateFormat} onChange={e => onDateFormatChange(e.target.value as DateFormat)}
              className="h-10 w-full rounded-md border bg-background px-3 text-sm">
              {DATE_FORMATS.map(fmt => <option key={fmt.value} value={fmt.value}>{fmt.label}</option>)}
            </select>
          </div>
          <div className="space-y-2">
            <label className="text-sm font-medium">Time Format</label>
            <div className="flex gap-4">
              <label className="flex items-center gap-2">
                <input type="radio" name="timeFormat" checked={timeFormat === '12h'}
                  onChange={() => onTimeFormatChange('12h')} className="h-4 w-4" />
                <span className="text-sm">12-hour</span>
              </label>
              <label className="flex items-center gap-2">
                <input type="radio" name="timeFormat" checked={timeFormat === '24h'}
                  onChange={() => onTimeFormatChange('24h')} className="h-4 w-4" />
                <span className="text-sm">24-hour</span>
              </label>
            </div>
          </div>
          <div className="space-y-2">
            <label className="text-sm font-medium">Language</label>
            <div className="flex h-10 w-full items-center rounded-md border bg-muted px-3 text-sm text-muted-foreground">
              English
            </div>
            <p className="text-xs text-muted-foreground">Default language for partner settings.</p>
          </div>
        </div>
      </section>

      {/* Business Hours */}
      <section className="rounded-lg border bg-card p-6 shadow-xs">
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
              <label key={preset.value}
                className={`cursor-pointer rounded-lg border p-4 transition ${
                  businessHoursPreset === preset.value
                    ? 'border-primary bg-primary/5' : 'hover:border-muted-foreground/50'
                }`}>
                <input type="radio" name="businessHoursPreset" value={preset.value}
                  checked={businessHoursPreset === preset.value}
                  onChange={() => onBusinessHoursPresetChange(preset.value)} className="sr-only" />
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
                    <input type="checkbox" checked={!customHours[day]?.closed}
                      onChange={e => onCustomHoursChange(day, 'closed', !e.target.checked)} className="h-4 w-4" />
                    <span className="text-sm">Open</span>
                  </label>
                  {!customHours[day]?.closed && (
                    <>
                      <input type="time" value={customHours[day]?.start || '09:00'}
                        onChange={e => onCustomHoursChange(day, 'start', e.target.value)}
                        className="h-8 rounded-md border bg-background px-2 text-sm" />
                      <span className="text-sm text-muted-foreground">to</span>
                      <input type="time" value={customHours[day]?.end || '17:00'}
                        onChange={e => onCustomHoursChange(day, 'end', e.target.value)}
                        className="h-8 rounded-md border bg-background px-2 text-sm" />
                    </>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      </section>

      <KnownGuestsSettings />
    </>
  );
}
