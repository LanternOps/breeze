import { useTranslation } from 'react-i18next';
import '@/lib/i18n';
import type { PortalAccessPolicyView } from '@breeze/shared';
import HashLink from '../../shared/HashLink';
import { ownValue, type PortalAccessPolicyDraft } from './types';

type Props = { view: PortalAccessPolicyView; draft: PortalAccessPolicyDraft };

/**
 * Under the Google row (portal registration W7 #11384, plan D6): Google sign-in
 * works only for a Workspace domain verified for the org, so the org view lists
 * this org's verified domains, or says there is none and links to
 * Organization › Domains. Only this org's own domains are shown, never whether
 * a domain is verified elsewhere. The partner view has no domains of its own:
 * while its Google default is on it says where that default takes effect.
 * Renders nothing while the deployment cannot run Google sign-in.
 */
export function GoogleDomainsStatus({ view, draft }: Props) {
  const { t } = useTranslation('settings');
  if (!view.capabilities.google) return null;

  if (view.owner.kind === 'partner') {
    const on = ownValue(view, draft, 'googleEnabled') ?? view.inherited.googleEnabled.value;
    if (!on) return null;
    return (
      <p data-testid="google-domains-partner" className="mt-2 text-xs text-muted-foreground">
        {t('portalAccessPolicy.google.domains.partner')}
      </p>
    );
  }

  const domains = view.verifiedDomains ?? [];
  if (domains.length === 0) {
    return (
      <p data-testid="google-domains-none" className="mt-2 text-xs text-muted-foreground">
        {t('portalAccessPolicy.google.domains.none')}{' '}
        <HashLink hash="domains" className="font-medium text-primary hover:underline">
          {t('portalAccessPolicy.google.domains.verify')}
        </HashLink>
      </p>
    );
  }
  return (
    <p data-testid="google-domains-status" className="mt-2 text-xs text-muted-foreground">
      {t('portalAccessPolicy.google.domains.verified', { domains: domains.join(', ') })}
    </p>
  );
}
