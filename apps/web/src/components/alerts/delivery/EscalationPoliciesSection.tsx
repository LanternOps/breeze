import { useTranslation } from 'react-i18next';
export default function EscalationPoliciesSection(_props: Record<string, unknown>) {
  const { t } = useTranslation('alerts');
  return <section><h2>{t('deliveryPage.sections.escalation')}</h2></section>;
}
