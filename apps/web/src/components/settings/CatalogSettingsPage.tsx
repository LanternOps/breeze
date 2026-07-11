import '@/lib/i18n';
import { useTranslation } from 'react-i18next';
import { getJwtClaims } from '../../lib/authScope';
import CatalogItemsTab from './CatalogItemsTab';

export default function CatalogSettingsPage() {
  const { t } = useTranslation('settings');
  // Catalog routes enforce requireScope('partner','system') server-side. Gate
  // the page client-side so org-scope users get a clear "partner accounts only"
  // message instead of a misleading load error. getJwtClaims returns null scope
  // on a missing/undecodable token, so only a confirmed 'organization' scope is
  // blocked here; everything else falls through to the server's own check.
  const isOrgScoped = getJwtClaims().scope === 'organization';

  if (isOrgScoped) {
    return (
      <div className="space-y-6" data-testid="catalog-settings-page">
        <div>
          <h1 className="text-xl font-semibold">{t('catalogSettingsPage.productCatalog')}</h1>
        </div>
        <p
          className="text-center text-sm text-muted-foreground"
          data-testid="catalog-settings-org-scope"
        >
          {t('catalogSettingsPage.theProductCatalogIsAvailableToPartnerAccountsOnly')}</p>
      </div>
    );
  }

  return (
    <div className="space-y-6" data-testid="catalog-settings-page">
      <div>
        <h1 className="text-xl font-semibold">{t('catalogSettingsPage.productCatalog')}</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          {t('catalogSettingsPage.manageHardwareSoftwareAndServiceItemsUsedAcrossQuotesCon')}</p>
      </div>
      <CatalogItemsTab />
    </div>
  );
}
