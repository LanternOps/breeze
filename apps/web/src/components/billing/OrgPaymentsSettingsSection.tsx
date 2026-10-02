import { useTranslation } from 'react-i18next';
import { PaymentFields, type PaymentSettingsView, type PaymentValues } from './PaymentsSettingsTab';
export default function OrgPaymentsSettingsSection({ view, setValues, disabled }: {
  view: PaymentSettingsView; setValues: (patch: Partial<PaymentValues>) => void; disabled: boolean;
}) {
  const { t } = useTranslation('billing');
  if (!view.autopayEnabled) return null;
  return <section data-testid="autopay-org-settings" className="rounded-lg border bg-card p-6 space-y-4">
    <h2>{t('autopay.title')}</h2><PaymentFields view={view} setValues={setValues} disabled={disabled} />
  </section>;
}
