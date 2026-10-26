import { useTranslation } from 'react-i18next';
import TimezoneSelect from '@/components/shared/TimezoneSelect';
import type { DateFormat, TimeFormat, SupportedLocale } from '@breeze/shared';
import '@/lib/i18n';

const DATE_FORMATS: { value: DateFormat; labelKey: string }[] = [
  { value: 'MM/DD/YYYY', labelKey: 'us' },
  { value: 'DD/MM/YYYY', labelKey: 'international' },
  { value: 'YYYY-MM-DD', labelKey: 'iso' }
];

type PartnerRegionalTabProps = {
  timezone: string;
  dateFormat: DateFormat;
  timeFormat: TimeFormat;
  language: SupportedLocale;
  onTimezoneChange: (value: string) => void;
  onDateFormatChange: (value: DateFormat) => void;
  onTimeFormatChange: (value: TimeFormat) => void;
  onLanguageChange: (value: SupportedLocale) => void;
};

export default function PartnerRegionalTab({
  timezone,
  dateFormat,
  timeFormat,
  language,
  onTimezoneChange,
  onDateFormatChange,
  onTimeFormatChange,
  onLanguageChange,
}: PartnerRegionalTabProps) {
  const { t } = useTranslation('settings');

  return (
    <>
      <section className="rounded-lg border bg-card p-6 shadow-xs">
        <p className="mb-6 max-w-prose text-sm text-muted-foreground">
          {t('partner.regional.description')}
        </p>
        <div className="grid gap-6 sm:grid-cols-2">
          <div className="space-y-2">
            <label htmlFor="partner-timezone" className="text-sm font-medium">{t('partner.regional.timezone')}</label>
            <TimezoneSelect
              id="partner-timezone"
              label={t('partner.regional.timezone')}
              value={timezone}
              onChange={onTimezoneChange}
              testId="partner-timezone"
            />
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
              <option value="it-IT">{t('language.itITLabel')}</option>
              <option value="tr-TR">{t('language.trTRLabel')}</option>
            </select>
            <p className="text-xs text-muted-foreground">{t('partner.regional.languageDescription')}</p>
          </div>
        </div>
      </section>
    </>
  );
}
