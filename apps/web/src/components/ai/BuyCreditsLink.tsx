import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { useFeaturesStore } from '@/stores/featuresStore';

/**
 * The billing sidecar's Credits page. The sidecar is served same-origin under
 * `/billing/*` on hosted deployments (docker/Caddyfile.prod), the same
 * origin the header's billing-portal button talks to.
 */
export const BUY_CREDITS_HREF = '/billing/credits';

/**
 * "Buy credits" link for the hosted billing sidecar. Renders nothing on a
 * self-hosted deployment: `features.billing` mirrors the API's hosted-billing
 * configuration, so a self-hoster never sees a link to a page that is not there.
 */
export default function BuyCreditsLink({ className }: { className?: string }) {
  const { t } = useTranslation('ai');
  const billing = useFeaturesStore((s) => s.features.billing);
  const load = useFeaturesStore((s) => s.load);

  // Idempotent: the store no-ops once /config has loaded.
  useEffect(() => {
    void load();
  }, [load]);

  if (!billing) return null;

  return (
    <a
      href={BUY_CREDITS_HREF}
      className={className ?? 'text-xs font-medium underline underline-offset-2 hover:opacity-80'}
    >
      {t('buyCredits.link')}
    </a>
  );
}
