import { useTranslation } from 'react-i18next';
import { FeeFields, PaymentFields, type PaymentSettingsView, type PaymentValues } from './PaymentsSettingsTab';
import RemindersSettingsSection, { type ReminderDraft } from './RemindersSettingsSection';
export default function OrgPaymentsSettingsSection({ view, setValues, reminders, setReminders, disabled }: {
  view: PaymentSettingsView; setValues: (patch: Partial<PaymentValues>) => void;
  reminders: ReminderDraft; setReminders: (value: ReminderDraft) => void; disabled: boolean;
}) {
  const { t } = useTranslation('billing');
  return <div className="space-y-6" data-testid="autopay-payments-shell">
    <RemindersSettingsSection scope="org" value={reminders} inherited={view.inherited}
      onChange={setReminders} disabled={disabled} />
    {view.autopayEnabled && <section data-testid="autopay-settings-section" className="min-w-0 space-y-4 rounded-lg border bg-card p-6">
      <h2 className="text-lg font-semibold">{t('autopay.title')}</h2><PaymentFields view={view} setValues={setValues} disabled={disabled} />
      <FeeFields view={view} setValues={setValues} disabled={disabled} scope="org" />
    </section>}
  </div>;
}
