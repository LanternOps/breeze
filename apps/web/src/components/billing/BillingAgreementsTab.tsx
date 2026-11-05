import { useTranslation } from 'react-i18next';
import {
  AGREEMENT_DEFAULT_EXPIRY_DAYS_MAX,
  AGREEMENT_DEFAULT_EXPIRY_DAYS_MIN,
  AGREEMENT_MAX_REMINDERS_MAX,
  AGREEMENT_MAX_REMINDERS_MIN,
  AGREEMENT_REMINDER_INTERVAL_DAYS_MAX,
  AGREEMENT_REMINDER_INTERVAL_DAYS_MIN,
} from '@breeze/shared';
import { validateAgreementDefaults, type AgreementDefaultsDraft } from './agreementDefaultsForm';

interface BillingAgreementsTabProps {
  value: AgreementDefaultsDraft;
  onChange: (value: AgreementDefaultsDraft) => void;
  /** False when the page is read-only or the user lacks agreements:send. */
  canEdit: boolean;
  /** The page is otherwise editable but agreements:send is missing — say why here
   *  (a page-wide read-only state has its own notice above the tabs). */
  missingSendGrant: boolean;
}

/**
 * Settings → Billing → Agreements (#9075 W4a, spec OD8 B). The ONE place the
 * agreement-request defaults are configured (partner level; no org override):
 * the expiry a new request gets when the sender sets none (the Send dialog
 * pre-fills it and the sender can change it per request) and the
 * automatic-reminder cadence. Saved by the page's Save button.
 */
export default function BillingAgreementsTab({ value, onChange, canEdit, missingSendGrant }: BillingAgreementsTabProps) {
  const { t } = useTranslation('billing');
  const errors = validateAgreementDefaults(value);
  const inputClass = (bad?: boolean) =>
    `mt-1 w-32 rounded-md border bg-background px-3 py-1.5 text-sm${bad ? ' border-destructive' : ''}`;
  const set = (patch: Partial<AgreementDefaultsDraft>) => onChange({ ...value, ...patch });

  return (
    <section className="rounded-lg border bg-card p-6 shadow-xs" data-testid="agreements-settings">
      <h2 className="text-lg font-semibold">{t('partnerBillingSettings.agreements.title')}</h2>
      <p className="mt-1 text-sm text-muted-foreground">{t('partnerBillingSettings.agreements.description')}</p>
      {missingSendGrant && (
        <p className="mt-3 rounded-md border bg-muted/40 px-3 py-2 text-sm text-muted-foreground" data-testid="agreements-settings-readonly">
          {t('partnerBillingSettings.agreements.readOnlyNoSend')}
        </p>
      )}
      <fieldset disabled={!canEdit} className="mt-4 min-w-0 space-y-5 border-0 p-0 m-0">
        <div>
          <label className="text-sm font-medium" htmlFor="pb-agreement-expiry">{t('partnerBillingSettings.agreements.expiryDays')}</label>
          <input
            id="pb-agreement-expiry" type="number" inputMode="numeric"
            min={AGREEMENT_DEFAULT_EXPIRY_DAYS_MIN} max={AGREEMENT_DEFAULT_EXPIRY_DAYS_MAX} step={1}
            value={value.expiryDays}
            onChange={(e) => set({ expiryDays: e.target.value })}
            data-testid="agreements-settings-expiry-days"
            aria-invalid={errors.expiryDays ? true : undefined}
            aria-describedby={errors.expiryDays ? 'pb-agreement-expiry-error' : 'pb-agreement-expiry-help'}
            className={inputClass(errors.expiryDays)}
          />
          {errors.expiryDays ? (
            <p id="pb-agreement-expiry-error" data-testid="agreements-settings-expiry-days-error" className="mt-1 text-sm text-destructive">
              {t('partnerBillingSettings.agreements.expiryDaysInvalid', { min: AGREEMENT_DEFAULT_EXPIRY_DAYS_MIN, max: AGREEMENT_DEFAULT_EXPIRY_DAYS_MAX })}
            </p>
          ) : (
            <p id="pb-agreement-expiry-help" className="mt-1 text-xs text-muted-foreground">
              {t('partnerBillingSettings.agreements.expiryDaysHelp')}
            </p>
          )}
        </div>

        <div>
          <label className="flex items-center gap-2 text-sm font-medium">
            <input
              type="checkbox" checked={value.remindersOn}
              onChange={(e) => set({ remindersOn: e.target.checked })}
              data-testid="agreements-settings-reminders-enabled"
              aria-describedby="pb-agreement-reminders-help"
            />
            {t('partnerBillingSettings.agreements.remindersEnabled')}
          </label>
          <p id="pb-agreement-reminders-help" className="mt-1 text-xs text-muted-foreground">
            {t('partnerBillingSettings.agreements.remindersHelp')}
          </p>
        </div>

        {value.remindersOn && (
          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <label className="text-sm font-medium" htmlFor="pb-agreement-interval">{t('partnerBillingSettings.agreements.intervalDays')}</label>
              <input
                id="pb-agreement-interval" type="number" inputMode="numeric"
                min={AGREEMENT_REMINDER_INTERVAL_DAYS_MIN} max={AGREEMENT_REMINDER_INTERVAL_DAYS_MAX} step={1}
                value={value.intervalDays}
                onChange={(e) => set({ intervalDays: e.target.value })}
                data-testid="agreements-settings-interval-days"
                aria-invalid={errors.intervalDays ? true : undefined}
                aria-describedby={errors.intervalDays ? 'pb-agreement-interval-error' : undefined}
                className={inputClass(errors.intervalDays)}
              />
              {errors.intervalDays && (
                <p id="pb-agreement-interval-error" data-testid="agreements-settings-interval-days-error" className="mt-1 text-sm text-destructive">
                  {t('partnerBillingSettings.agreements.intervalDaysInvalid', { min: AGREEMENT_REMINDER_INTERVAL_DAYS_MIN, max: AGREEMENT_REMINDER_INTERVAL_DAYS_MAX })}
                </p>
              )}
            </div>
            <div>
              <label className="text-sm font-medium" htmlFor="pb-agreement-max">{t('partnerBillingSettings.agreements.maxReminders')}</label>
              <input
                id="pb-agreement-max" type="number" inputMode="numeric"
                min={AGREEMENT_MAX_REMINDERS_MIN} max={AGREEMENT_MAX_REMINDERS_MAX} step={1}
                value={value.maxReminders}
                onChange={(e) => set({ maxReminders: e.target.value })}
                data-testid="agreements-settings-max-reminders"
                aria-invalid={errors.maxReminders ? true : undefined}
                aria-describedby={errors.maxReminders ? 'pb-agreement-max-error' : 'pb-agreement-max-help'}
                className={inputClass(errors.maxReminders)}
              />
              {errors.maxReminders ? (
                <p id="pb-agreement-max-error" data-testid="agreements-settings-max-reminders-error" className="mt-1 text-sm text-destructive">
                  {t('partnerBillingSettings.agreements.maxRemindersInvalid', { min: AGREEMENT_MAX_REMINDERS_MIN, max: AGREEMENT_MAX_REMINDERS_MAX })}
                </p>
              ) : (
                <p id="pb-agreement-max-help" className="mt-1 text-xs text-muted-foreground">
                  {t('partnerBillingSettings.agreements.maxRemindersHelp')}
                </p>
              )}
            </div>
          </div>
        )}
      </fieldset>
    </section>
  );
}
