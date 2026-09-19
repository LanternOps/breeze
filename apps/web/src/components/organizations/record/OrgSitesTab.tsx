import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import SiteList from '@/components/settings/SiteList';
import SiteModals from '@/components/settings/SiteModals';
import { useSiteCrud } from '@/components/settings/useSiteCrud';
import { navigateTo } from '@/lib/navigation';
import { handleSessionExpired } from '@/stores/auth';

export interface OrgSitesTabProps {
  orgId: string;
  orgName?: string;
}

/**
 * The organization record's Sites tab (#5075 W02).
 *
 * Shares `useSiteCrud` and `SiteModals` with `OrganizationsPage` — same URLs,
 * same `runAction` behaviour — so a site added here shows up unmodified in
 * the settings list, and vice versa. `useSiteCrud`'s GET carries
 * `orgIdOverride: orgId`, so the list is always the record's own sites
 * regardless of what the OrgSwitcher currently points at.
 */
export default function OrgSitesTab({ orgId, orgName }: OrgSitesTabProps) {
  const { t } = useTranslation('settings');
  const siteCrud = useSiteCrud(orgId, { onUnauthorized: handleSessionExpired, t });

  useEffect(() => {
    void siteCrud.refresh();
  }, [siteCrud.refresh]);

  return (
    <div data-testid="org-sites-tab" className="space-y-4">
      {siteCrud.sitesLoading ? (
        <div className="flex items-center justify-center py-8">
          <div className="h-6 w-6 animate-spin rounded-full border-4 border-primary border-t-transparent" />
          <span className="ml-3 text-sm text-muted-foreground">{t('organizationsPage.sites.loading')}</span>
        </div>
      ) : siteCrud.sitesFailed ? (
        // A failed load must not read as "this org has no sites" — `sites` is
        // reset to `[]` on failure too (existing first-site-guidance callers
        // rely on that), so `sitesFailed` is what actually distinguishes the
        // two here.
        <div
          data-testid="org-sites-load-error"
          className="rounded-lg border bg-card p-6 text-sm text-muted-foreground"
        >
          {t('organizationsPage.errors.loadSites')}{' '}
          <button
            type="button"
            onClick={() => void siteCrud.refresh()}
            className="underline hover:text-foreground"
          >
            {t('organizationsPage.actions.tryAgain')}
          </button>
        </div>
      ) : (
        <SiteList
          sites={siteCrud.sites}
          onAddSite={siteCrud.openAdd}
          onEdit={siteCrud.openEdit}
          onDelete={siteCrud.openDelete}
          onSiteClick={(site) => void navigateTo(`/settings/sites/${site.id}`)}
        />
      )}

      <SiteModals
        mode={siteCrud.siteModalMode}
        selectedSite={siteCrud.selectedSite}
        guidingFirstSite={siteCrud.guidingFirstSite}
        orgName={orgName}
        submitting={siteCrud.siteSubmitting}
        onSubmit={siteCrud.submit}
        onClose={siteCrud.close}
        onConfirmDelete={siteCrud.confirmDelete}
        getSiteFormDefaults={siteCrud.getSiteFormDefaults}
      />
    </div>
  );
}
