import { useTranslation } from 'react-i18next';
import { SERIES_SCHEDULES, isSeriesSchedule } from './seriesConfig';
import type { SeriesSchedule } from './types';

/**
 * The recurring schedule a template-created series needs (INDEX: the series
 * schema rejects one_time). Required, and never defaulted from a one-time
 * template: the user picks it.
 */
export function SeriesScheduleField({
  value,
  onChange,
  showRequired,
}: {
  value: SeriesSchedule | '';
  onChange: (next: SeriesSchedule | '') => void;
  showRequired: boolean;
}) {
  const { t } = useTranslation('reports');
  return (
    <div data-testid="series-schedule-field" className="space-y-1">
      <label htmlFor="series-schedule" className="text-sm font-medium">{t('reports.series.schedule.label')}</label>
      <select
        id="series-schedule"
        data-testid="series-schedule-select"
        required
        aria-invalid={showRequired}
        value={value}
        onChange={(e) => onChange(isSeriesSchedule(e.target.value) ? e.target.value : '')}
        className="h-10 w-full rounded-md border bg-background px-3 text-sm"
      >
        <option value="">{t('reports.series.schedule.placeholder')}</option>
        {SERIES_SCHEDULES.map((schedule) => (
          <option key={schedule} value={schedule}>
            {t(/* i18n-dynamic */ `reports.reportsList.schedules.${schedule}`)}
          </option>
        ))}
      </select>
      <p data-testid="series-schedule-hint" className="text-xs text-muted-foreground">{t('reports.series.schedule.hint')}</p>
      {showRequired && (
        <p data-testid="series-schedule-required" role="alert" className="text-xs text-destructive">
          {t('reports.series.schedule.required')}
        </p>
      )}
    </div>
  );
}
