import { Plus, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import '@/lib/i18n';
import { WEEKDAY_ORDER, type WeekDraft } from './businessHoursModel';

type Props = {
  week: WeekDraft;
  onChange: (week: WeekDraft) => void;
  disabled?: boolean;
};

/** Weekly grid: each weekday holds zero or more open intervals (split shifts). */
export default function BusinessHoursWeekEditor({ week, onChange, disabled }: Props) {
  const { t } = useTranslation('settings');

  const update = (weekday: number, rows: WeekDraft[number]) => {
    onChange(week.map((day, i) => (i === weekday ? rows : day)));
  };

  return (
    <div className="space-y-2" data-testid="business-hours-week-editor">
      {WEEKDAY_ORDER.map((weekday) => {
        const rows = week[weekday] ?? [];
        const dayName = t(/* i18n-dynamic */ `businessHoursCard.weekdays.${weekday}`);
        return (
          <div key={weekday} className="flex flex-wrap items-start gap-3 border-b pb-2 last:border-b-0" data-testid={`business-hours-day-${weekday}`}>
            <div className="w-28 pt-1.5 text-sm font-medium">{dayName}</div>
            <div className="flex-1 space-y-1.5">
              {rows.length === 0 && (
                <p className="pt-1.5 text-sm text-muted-foreground" data-testid={`business-hours-closed-${weekday}`}>
                  {t('businessHoursCard.closed')}
                </p>
              )}
              {rows.map((row, index) => (
                <div key={index} className="flex items-center gap-2">
                  <input
                    type="text"
                    inputMode="numeric"
                    value={row.start}
                    maxLength={5}
                    placeholder="09:00"
                    disabled={disabled}
                    aria-label={t('businessHoursCard.intervalStart', { day: dayName })}
                    onChange={(e) => update(weekday, rows.map((r, i) => (i === index ? { ...r, start: e.target.value } : r)))}
                    className="h-8 w-20 rounded-md border bg-background px-2 text-sm"
                    data-testid={`business-hours-interval-${weekday}-${index}-start`}
                  />
                  <span className="text-sm text-muted-foreground">{t('businessHoursCard.to')}</span>
                  <input
                    type="text"
                    inputMode="numeric"
                    value={row.end}
                    maxLength={5}
                    placeholder="17:00"
                    disabled={disabled}
                    aria-label={t('businessHoursCard.intervalEnd', { day: dayName })}
                    onChange={(e) => update(weekday, rows.map((r, i) => (i === index ? { ...r, end: e.target.value } : r)))}
                    className="h-8 w-20 rounded-md border bg-background px-2 text-sm"
                    data-testid={`business-hours-interval-${weekday}-${index}-end`}
                  />
                  <button
                    type="button"
                    disabled={disabled}
                    onClick={() => update(weekday, rows.filter((_, i) => i !== index))}
                    aria-label={t('businessHoursCard.removeInterval', { day: dayName })}
                    className="rounded p-1 text-muted-foreground hover:text-foreground"
                    data-testid={`business-hours-remove-interval-${weekday}-${index}`}
                  >
                    <X className="h-4 w-4" />
                  </button>
                </div>
              ))}
            </div>
            <button
              type="button"
              disabled={disabled}
              onClick={() => update(weekday, [...rows, rows.length === 0 ? { start: '09:00', end: '17:00' } : { start: '', end: '' }])}
              className="inline-flex items-center gap-1 rounded-md border px-2 py-1 text-xs hover:bg-muted"
              data-testid={`business-hours-add-interval-${weekday}`}
            >
              <Plus className="h-3.5 w-3.5" />
              {t('businessHoursCard.addInterval')}
            </button>
          </div>
        );
      })}
    </div>
  );
}
