// Owner: W02d (NDA text, ticket-per-request setting, access-request inbox).
// W02a stub (Trust Center W2, #8770): wired into TrustCenterTab with the shared TrustSectionProps so the owner
// fills this file alone. Mutations must go through runAction (listed in no-silent-mutations TARGET_GLOBS).
import { useTranslation } from 'react-i18next';
import type { TrustSectionProps } from '@/lib/api/trustPage';

export default function TrustAccessSection(_props: TrustSectionProps) {
  const { t } = useTranslation('organizations');
  return (
    <section className="space-y-4 rounded-lg border bg-card p-4" data-testid="trust-access-section">
      <h3 className="text-base font-semibold">{t('orgRecord.trust.access.title')}</h3>
    </section>
  );
}
