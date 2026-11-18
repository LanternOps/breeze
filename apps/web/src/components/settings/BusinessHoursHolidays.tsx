import { useState } from 'react';
import { Trash2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import '@/lib/i18n';
import { businessCalendarHolidaySchema, type BusinessCalendarDto } from '@breeze/shared';
import { fetchWithAuth } from '../../stores/auth';
import { navigateTo } from '@/lib/navigation';
import { showToast } from '../shared/Toast';
import { runAction, ActionError } from '@/lib/runAction';

type Props = {
  calendar: BusinessCalendarDto;
  onChanged: () => void;
};

export default function BusinessHoursHolidays({ calendar, onChanged }: Props) {
  const { t } = useTranslation('settings');
  const [date, setDate] = useState('');
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const recomputeToast = (queued: boolean | undefined) => {
    if (queued) showToast({ type: 'success', message: t('businessHoursCard.toasts.recompute') });
  };

  const add = async () => {
    if (busy) return;
    const parsed = businessCalendarHolidaySchema.safeParse({ date, name });
    if (!parsed.success) { setError(t('businessHoursCard.errors.holidayInvalid')); return; }
    setError(null);
    setBusy(true);
    try {
      const result = await runAction<{ data: { recomputeQueued?: boolean } }>({
        request: () => fetchWithAuth(`/business-calendars/${calendar.id}/holidays`, {
          method: 'POST',
          body: JSON.stringify(parsed.data),
        }),
        errorFallback: t('businessHoursCard.errors.holidayAdd'),
        successMessage: t('businessHoursCard.toasts.holidayAdded'),
        onUnauthorized: () => void navigateTo('/login', { replace: true }),
      });
      recomputeToast(result.data?.recomputeQueued);
      setDate('');
      setName('');
      onChanged();
    } catch (err) {
      if (err instanceof ActionError && err.status === 401) return;
      if (!(err instanceof ActionError)) showToast({ type: 'error', message: t('businessHoursCard.errors.holidayAdd') });
    } finally {
      setBusy(false);
    }
  };

  const remove = async (holidayId: string) => {
    if (busy) return;
    setBusy(true);
    try {
      const result = await runAction<{ data: { recomputeQueued?: boolean } }>({
        request: () => fetchWithAuth(`/business-calendars/${calendar.id}/holidays/${holidayId}`, { method: 'DELETE' }),
        errorFallback: t('businessHoursCard.errors.holidayRemove'),
        successMessage: t('businessHoursCard.toasts.holidayRemoved'),
        onUnauthorized: () => void navigateTo('/login', { replace: true }),
      });
      recomputeToast(result.data?.recomputeQueued);
      onChanged();
    } catch (err) {
      if (err instanceof ActionError && err.status === 401) return;
      if (!(err instanceof ActionError)) showToast({ type: 'error', message: t('businessHoursCard.errors.holidayRemove') });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-2" data-testid="business-hours-holidays">
      <h4 className="text-sm font-semibold">{t('businessHoursCard.holidays')}</h4>
      <p className="text-xs text-muted-foreground" data-testid="business-hours-holiday-hint">
        {t('businessHoursCard.holidayHint')}
      </p>
      {calendar.holidays.length === 0 ? (
        <p className="text-sm text-muted-foreground" data-testid="business-hours-no-holidays">{t('businessHoursCard.noHolidays')}</p>
      ) : (
        <ul className="divide-y rounded-md border text-sm">
          {calendar.holidays.map((h) => (
            <li key={h.id} className="flex items-center justify-between px-3 py-1.5" data-testid={`business-hours-holiday-${h.id}`}>
              <span><span className="font-mono text-xs">{h.date}</span> {h.name}</span>
              <button
                type="button"
                disabled={busy}
                onClick={() => void remove(h.id)}
                aria-label={t('businessHoursCard.holidayRemove', { name: h.name })}
                className="rounded p-1 text-muted-foreground hover:text-destructive"
                data-testid={`business-hours-holiday-remove-${h.id}`}
              >
                <Trash2 className="h-4 w-4" />
              </button>
            </li>
          ))}
        </ul>
      )}
      <div className="flex flex-wrap items-end gap-2">
        <div className="space-y-1">
          <label htmlFor="business-hours-holiday-date" className="text-xs font-medium">{t('businessHoursCard.holidayDate')}</label>
          <input
            id="business-hours-holiday-date"
            type="date"
            value={date}
            onChange={(e) => setDate(e.target.value)}
            className="h-9 rounded-md border bg-background px-2 text-sm"
            data-testid="business-hours-holiday-date"
          />
        </div>
        <div className="space-y-1">
          <label htmlFor="business-hours-holiday-name" className="text-xs font-medium">{t('businessHoursCard.holidayName')}</label>
          <input
            id="business-hours-holiday-name"
            type="text"
            value={name}
            maxLength={100}
            onChange={(e) => setName(e.target.value)}
            className="h-9 rounded-md border bg-background px-2 text-sm"
            data-testid="business-hours-holiday-name"
          />
        </div>
        <button
          type="button"
          disabled={busy}
          onClick={() => void add()}
          className="h-9 rounded-md border px-3 text-sm hover:bg-muted disabled:opacity-50"
          data-testid="business-hours-holiday-add"
        >
          {t('businessHoursCard.holidayAdd')}
        </button>
      </div>
      {error && <p className="text-sm text-destructive" role="alert" data-testid="business-hours-holiday-error">{error}</p>}
    </div>
  );
}
