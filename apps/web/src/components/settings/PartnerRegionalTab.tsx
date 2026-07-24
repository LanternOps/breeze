import { Clock, Globe } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import KnownGuestsSettings from './KnownGuestsSettings';
import type { BusinessHoursPreset, DateFormat, TimeFormat, DaySchedule, SupportedLocale } from '@breeze/shared';
import '@/lib/i18n';

const TIMEZONES = [
  'UTC', 'America/New_York', 'America/Chicago', 'America/Denver',
  'America/Los_Angeles', 'America/Phoenix', 'America/Anchorage',
  'Pacific/Honolulu', 'Europe/London', 'Europe/Paris', 'Europe/Berlin',
  'Asia/Tokyo', 'Asia/Shanghai', 'Asia/Singapore', 'Australia/Sydney'
];

const DATE_FORMATS: { value: DateFormat; labelKey: string }[] = [
  { value: 'MM/DD/YYYY', labelKey: 'us' },
  { value: 'DD/MM/YYYY', labelKey: 'international' },
  { value: 'YYYY-MM-DD', labelKey: 'iso' }
];

const BUSINESS_HOURS_PRESETS: { value: BusinessHoursPreset; key: string }[] = [
  { value: '24/7', key: 'always' },
  { value: 'business', key: 'business' },
  { value: 'extended', key: 'extended' },
  { value: 'custom', key: 'custom' }
];

const DAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'] as const;
const BH: DaySchedule = { start: '09:00', end: '17:00' };
const BH_CLOSED: DaySchedule = { start: '09:00', end: '17:00', closed: true };
export const DEFAULT_BUSINESS_HOURS: Record<string, DaySchedule> = { mon: BH, tue: BH, wed: BH, thu: BH, fri: BH, sat: BH_CLOSED, sun: BH_CLOSED };

type PartnerRegionalTabProps = {
  timezone: string;
  dateFormat: DateFormat;
  timeFormat: TimeFormat;
  language: SupportedLocale;
  businessHoursPreset: BusinessHoursPreset;
  customHours: Record<string, DaySchedule>;
  onTimezoneChange: (value: string) => void;
  onDateFormatChange: (value: DateFormat) => void;
  onTimeFormatChange: (value: TimeFormat) => void;
  onLanguageChange: (value: SupportedLocale) => void;
  onBusinessHoursPresetChange: (value: BusinessHoursPreset) => void;
  onCustomHoursChange: (day: string, field: keyof DaySchedule, value: string | boolean) => void;
};

export default function PartnerRegionalTab({
  timezone,
  dateFormat,
  timeFormat,
  language,
  businessHoursPreset,
  customHours,
  onTimezoneChange,
  onDateFormatChange,
  onTimeFormatChange,
  onLanguageChange,
  onBusinessHoursPresetChange,
  onCustomHoursChange,
}: PartnerRegionalTabProps) {
  const { t } = useTranslation('settings');

  return (
    <>
      <section className="rounded-lg border bg-card p-6 shadow-xs">
        <div className="mb-6">
          <div className="flex items-center gap-2">
            <Globe className="h-5 w-5 text-muted-foreground" />
            <h2 className="text-lg font-semibold">{t('partner.regional.title')}</h2>
          </div>
          <p className="mt-1 text-sm text-muted-foreground">
            {t('partner.regional.description')}
          </p>
        </div>
        <div className="grid gap-6 sm:grid-cols-2">
          <div className="space-y-2">
            <label htmlFor="partner-timezone" className="text-sm font-medium">{t('partner.regional.timezone')}</label>
            <select id="partner-timezone" value={timezone} onChange={e => onTimezoneChange(e.target.value)}
              className="h-10 w-full rounded-md border bg-background px-3 text-sm">
              {TIMEZONES.map(tz => <option key={tz} value={tz}>{tz}</option>)}
            </select>
          </div>
          <div className="space-y-2">
            <label htmlFor="partner-date-format" className="text-sm font-medium">{t('partner.regional.dateFormat')}</label>
            <select id="partner-date-format" value={dateFormat} onChange={e => onDateFormatChange(e.target.value as DateFormat)}
              className="h-10 w-full rounded-md border bg-background px-3 text-sm">
              {DATE_FORMATS.map(fmt => <option key={fmt.value} value={fmt.value}>{fmt.value} ({t(/* i18n-dynamic */ `partner.regional.dateFormats.${fmt.labelKey}`)})</option>)}
            </select>
          </div>
          <div className="space-y-2">
            <label className="text-sm font-medium">{t('partner.regional.timeFormat')}</label>
            <div className="flex gap-4">
              <label className="flex items-center gap-2">
                <input type="radio" name="timeFormat" checked={timeFormat === '12h'}
                  onChange={() => onTimeFormatChange('12h')} className="h-4 w-4" />
                <span className="text-sm">{t('partner.regional.twelveHour')}</span>
              </label>
              <label className="flex items-center gap-2">
                <input type="radio" name="timeFormat" checked={timeFormat === '24h'}
                  onChange={() => onTimeFormatChange('24h')} className="h-4 w-4" />
                <span className="text-sm">{t('partner.regional.twentyFourHour')}</span>
              </label>
            </div>
          </div>
          <div className="space-y-2">
            <label htmlFor="partner-language" className="text-sm font-medium">{t('partner.regional.language')}</label>
            <select id="partner-language" value={language}
              onChange={e => onLanguageChange(e.target.value as SupportedLocale)}
              className="h-10 w-full rounded-md border bg-background px-3 text-sm">
              <option value="en">{t('language.englishLabel')}</option>
              <option value="pt-BR">{t('language.ptBRLabel')}</option>
              <option value="es-419">{t('language.es419Label')}</option>
              <option value="fr-FR">{t('language.frFRLabel')}</option>
              <option value="fr-CA">{t('language.frCALabel')}</option>
              <option value="de-DE">{t('language.deDELabel')}</option>
            </select>
            <p className="text-xs text-muted-foreground">{t('partner.regional.languageDescription')}</p>
          </div>
        </div>
      </section>

      {/* Business Hours */}
      <section className="rounded-lg border bg-card p-6 shadow-xs">
        <div className="mb-6">
          <div className="flex items-center gap-2">
            <Clock className="h-5 w-5 text-muted-foreground" />
            <h2 className="text-lg font-semibold">{t('partner.regional.businessHours.title')}</h2>
          </div>
          <p className="mt-1 text-sm text-muted-foreground">
            {t('partner.regional.businessHours.description')}
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
                <div className="font-medium">{t(/* i18n-dynamic */ `partner.regional.businessHours.presets.${preset.key}.label`)}</div>
                <div className="text-xs text-muted-foreground">{t(/* i18n-dynamic */ `partner.regional.businessHours.presets.${preset.key}.description`)}</div>
              </label>
            ))}
          </div>
          {businessHoursPreset === 'custom' && (
            <div className="mt-4 space-y-3 rounded-lg border bg-muted/40 p-4">
              <p className="text-sm font-medium">{t('partner.regional.businessHours.customSchedule')}</p>
              {DAYS.map(day => (
                <div key={day} className="flex items-center gap-4">
                  <div className="w-24 text-sm font-medium">{t(/* i18n-dynamic */ `partner.regional.days.${day}`)}</div>
                  <label className="flex items-center gap-2">
                    <input type="checkbox" checked={!customHours[day]?.closed}
                      onChange={e => onCustomHoursChange(day, 'closed', !e.target.checked)} className="h-4 w-4" />
                    <span className="text-sm">{t('partner.regional.businessHours.open')}</span>
                  </label>
                  {!customHours[day]?.closed && (
                    <>
                      <input type="time" value={customHours[day]?.start || '09:00'}
                        onChange={e => onCustomHoursChange(day, 'start', e.target.value)}
                        className="h-8 rounded-md border bg-background px-2 text-sm" />
                      <span className="text-sm text-muted-foreground">{t('partner.regional.businessHours.to')}</span>
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
