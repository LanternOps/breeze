import { useEffect, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import '@/lib/i18n';
import SiteList, { type Site } from './SiteList';
import SiteModals from './SiteModals';
import { useSiteCrud } from './useSiteCrud';
import { siteDevicesHref } from '../contracts/deviceCoverageLinks';
import { navigateTo } from '@/lib/navigation';
import { usePermissions } from '../../lib/permissions';
import { handleSessionExpired } from '../../stores/auth';
import { useOrgStore } from '../../stores/orgStore';

/**
 * The site-centric Sites page (`/settings/sites`, #9794; spec §4.1).
 *
 * Fleet view (no org selected) lists every site the viewer can reach, with an
 * Organization column once more than one org is in play; with an org selected
 * (or for an org-scoped user, whose org the store auto-selects) it lists that
 * org's sites. The server owns the scoping — org access and a site-scoped
 * user's `allowedSiteIds` — and this page renders exactly what comes back,
 * never a broader request (RF1).
 *
 * All CRUD is `useSiteCrud` (fleet mode), the same hook the org record's Sites
 * tab uses, so both views share one write path (`runAction`, MFA-required 403
 * surfaced the same way). The org a write targets is captured when its dialog
 * opens: the selected org for Add (or the dialog's org picker in fleet view),
 * the row's own org for Edit/Delete.
 */
export default function SitesPage() {
  const { t } = useTranslation('settings');
  const currentOrgId = useOrgStore((s) => s.currentOrgId);
  const organizations = useOrgStore((s) => s.organizations);
  const { can } = usePermissions();
  const canWrite = can('sites', 'write');
  const isFleet = currentOrgId === null;

  const siteCrud = useSiteCrud(currentOrgId, { onUnauthorized: handleSessionExpired, t, fleet: true });
  const { refresh } = siteCrud;

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const orgNameById = useMemo(() => new Map(organizations.map((o) => [o.id, o.name])), [organizations]);

  // The API names each row's org on a cross-org listing; the org store is the
  // fallback for a row it could not name.
  const sites: Site[] = useMemo(
    () =>
      siteCrud.sites.map((site) =>
        site.orgName || !site.orgId ? site : { ...site, orgName: orgNameById.get(site.orgId) ?? null },
      ),
    [siteCrud.sites, orgNameById],
  );

  // An org-scoped user reaches one org, so the column would only repeat it.
  const showOrgColumn = useMemo(
    () => isFleet && (organizations.length > 1 || new Set(sites.map((s) => s.orgId)).size > 1),
    [isFleet, organizations.length, sites],
  );

  // Fleet view with exactly one reachable org has nothing to choose.
  const soleOrgId = organizations.length === 1 ? organizations[0]!.id : undefined;
  const openAdd = () => siteCrud.openAdd(currentOrgId ?? soleOrgId);

  const orgPicker =
    siteCrud.siteModalMode === 'add' && isFleet
      ? {
          organizations: organizations.map((o) => ({ id: o.id, name: o.name })),
          value: siteCrud.writeOrgId,
          onChange: siteCrud.setWriteOrgId,
        }
      : undefined;

  return (
    <div data-testid="sites-page" className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold">{t('sites.page.title')}</h1>
        <p className="text-muted-foreground">{t('sites.page.description')}</p>
      </div>

      {/* A spinner on every load, like the org record's Sites tab, so an org
          switch never shows the previous org's rows under the new scope. */}
      {siteCrud.sitesLoading ? (
        <div className="flex items-center justify-center py-8">
          <div className="h-6 w-6 animate-spin rounded-full border-4 border-primary border-t-transparent" />
          <span className="ml-3 text-sm text-muted-foreground">{t('organizationsPage.sites.loading')}</span>
        </div>
      ) : siteCrud.sitesFailed ? (
        // `sites` is reset to [] on failure too; a failed load must not read as "no sites".
        <div data-testid="sites-load-error" className="rounded-lg border bg-card p-6 text-sm text-muted-foreground">
          {t('organizationsPage.errors.loadSites')}{' '}
          <button type="button" onClick={() => void refresh()} className="underline hover:text-foreground">
            {t('organizationsPage.actions.tryAgain')}
          </button>
        </div>
      ) : (
        <SiteList
          sites={sites}
          onAddSite={canWrite ? openAdd : undefined}
          onEdit={canWrite ? siteCrud.openEdit : undefined}
          onDelete={canWrite ? siteCrud.openDelete : undefined}
          onSiteClick={(site) => void navigateTo(`/settings/sites/${site.id}`)}
          showOrgColumn={showOrgColumn}
          deviceCountHref={(site) => (site.orgId ? siteDevicesHref(site.orgId, site.id) : null)}
          rowTestIdPrefix="sites-row"
          addButtonTestId="sites-add-button"
          emptyMessage={t('sites.page.empty')}
        />
      )}

      <SiteModals
        mode={siteCrud.siteModalMode}
        selectedSite={siteCrud.selectedSite}
        guidingFirstSite={siteCrud.guidingFirstSite}
        orgName={siteCrud.writeOrgId ? orgNameById.get(siteCrud.writeOrgId) : undefined}
        submitting={siteCrud.siteSubmitting}
        onSubmit={siteCrud.submit}
        onClose={siteCrud.close}
        onConfirmDelete={siteCrud.confirmDelete}
        getSiteFormDefaults={siteCrud.getSiteFormDefaults}
        orgPicker={orgPicker}
      />
    </div>
  );
}
