import { useCallback, useRef, useState } from 'react';
import type { TFunction } from 'i18next';
import { fetchWithAuth } from '../../stores/auth';
import { fetchAllSites } from '@/lib/fetchAllSites';
import { runAction, ActionError } from '@/lib/runAction';
import { showToast } from '../shared/Toast';
import type { Site } from './SiteList';

// Site address/contact are untyped jsonb on the wire. Strings prefill the form;
// finite numbers (e.g. an API-written postal code) are kept as text so saving the
// form does not blank them; anything else prefills empty.
const str = (value: unknown): string =>
  typeof value === 'string' ? value : typeof value === 'number' && Number.isFinite(value) ? String(value) : '';

/**
 * Site CRUD state + handlers, extracted verbatim from `OrganizationsPage`
 * (#5075 W02) so the organization record's Sites tab (`OrgSitesTab`) can share
 * the exact same behaviour instead of re-implementing it.
 *
 * Same URLs, same `runAction` error fallbacks, same `ActionError` catch
 * pattern as the page it was extracted from. The one addition is
 * `orgIdOverride: orgId` on every request this hook issues (GET, POST, PATCH,
 * DELETE), so a caller inside the record page (whose org can differ from the
 * OrgSwitcher's ambient scope) always targets the RIGHT org rather than
 * whatever the switcher happens to point at. The three site mutation routes
 * (`POST /orgs/sites`, `PATCH /orgs/sites/:id`, `DELETE /orgs/sites/:id`)
 * derive their org from the request body / the site's own DB row, never from
 * the query string, so an ambient-scope `orgId` there was already inert
 * rather than a live cross-tenant risk (verified: `apps/api/src/routes/orgs.ts`
 * — the site mutation handlers never read `c.req.query('orgId')`). Pinning it
 * anyway removes the need for that "verified harmless today" reasoning and
 * matches `refresh`'s guarantee exactly, so nothing about this hook's
 * behavior depends on a fact about the API surface staying true.
 * `OrganizationsPage` is unaffected: there, `orgId` passed in already IS the
 * organization being managed, so pinning it explicitly is a no-op change in
 * observable behaviour.
 *
 * Fleet mode (#9794, `opts.fleet`): with no bound org, `refresh()` lists every
 * site the caller can reach (`GET /orgs/sites` with no `organizationId`, and
 * `orgIdOverride: null` so no ambient org is injected) — the server narrows by
 * org access and `allowedSiteIds`; this hook never widens or re-filters. Every
 * write targets `writeOrgId`, which is captured when the modal OPENS: the
 * caller's org for `openAdd(orgId)` (or the bound org), the row's own org for
 * `openEdit`/`openDelete`. An org switch while the modal is open therefore
 * cannot retarget the write. With no org to capture, add waits for
 * `setWriteOrgId` (the Sites page's org picker) and `submit` issues nothing.
 */
export type SiteModalMode = 'closed' | 'add' | 'edit' | 'delete';

export interface SiteFormDefaults {
  name: string;
  timezone?: string;
  addressLine1: string;
  addressLine2: string;
  city: string;
  state: string;
  postalCode: string;
  country: string;
  contactName: string;
  contactEmail: string;
  contactPhone: string;
}

export interface UseSiteCrud {
  sites: Site[];
  sitesLoading: boolean;
  /**
   * True when the most recent `refresh()` did not resolve a real site list
   * (failed request or a malformed 200 body) — distinct from `sites` being
   * genuinely empty. `sites` is reset to `[]` in that case too (existing
   * first-site-guidance callers rely on it), so a caller that wants to avoid
   * rendering "No sites yet" for what was actually a load failure must check
   * this flag rather than `sites.length === 0`.
   */
  sitesFailed: boolean;
  siteSubmitting: boolean;
  siteModalMode: SiteModalMode;
  selectedSite: Site | null;
  guidingFirstSite: boolean;
  setGuidingFirstSite: (v: boolean) => void;
  /**
   * Returns the fetched site list, or null when the count couldn't be
   * determined (failed request or a malformed 200 body) — see
   * `OrganizationsPage`'s original `fetchSites` for why this distinction
   * matters to first-site guidance callers.
   *
   * Accepts an optional org id override for the one caller that must fetch a
   * DIFFERENT org's sites than the one this hook was instantiated with: right
   * after creating an organization, `OrganizationsPage` fetches the brand-new
   * org's sites before its own `setSelectedOrg` state update has re-rendered
   * this hook with the new id.
   */
  refresh: (orgIdOverride?: string) => Promise<Site[] | null>;
  /** Resets the visible list to empty without a network request — used when
   *  switching to an org whose sites must not be fetched (an archive-lifecycle
   *  org, or no org selected at all). */
  clear: () => void;
  /** Opens the add modal, capturing the org the new site belongs to. A
   *  non-string argument (a click event, when passed straight to `onClick`) is
   *  ignored and the bound org is used. */
  openAdd: (orgId?: string) => void;
  /** The org the open modal writes to, captured at open time; null until an
   *  org is chosen (fleet view add). */
  writeOrgId: string | null;
  /** Sets the add modal's target org — the fleet view's org picker. */
  setWriteOrgId: (orgId: string | null) => void;
  openEdit: (site: Site) => void;
  openDelete: (site: Site) => void;
  close: () => void;
  submit: (values: Record<string, unknown>) => Promise<void>;
  confirmDelete: () => Promise<void>;
  getSiteFormDefaults: (site: Site) => SiteFormDefaults;
}

export interface UseSiteCrudOptions {
  onUnauthorized: () => void;
  t: TFunction;
  /** With no bound org, list every accessible site instead of nothing (the
   *  Sites page's fleet view, #9794). */
  fleet?: boolean;
}

export function useSiteCrud(orgId: string | null, opts: UseSiteCrudOptions): UseSiteCrud {
  const { onUnauthorized, t, fleet = false } = opts;
  const [sites, setSites] = useState<Site[]>([]);
  const [sitesLoading, setSitesLoading] = useState(false);
  const [sitesFailed, setSitesFailed] = useState(false);
  const [siteModalMode, setSiteModalMode] = useState<SiteModalMode>('closed');
  const [selectedSite, setSelectedSite] = useState<Site | null>(null);
  const [siteSubmitting, setSiteSubmitting] = useState(false);
  const [guidingFirstSite, setGuidingFirstSite] = useState(false);
  const [writeOrgId, setWriteOrgId] = useState<string | null>(null);
  // The org whose listing last loaded successfully: an empty `sites` only means
  // "no sites yet" once that org's list has actually come back.
  const [listedOrgId, setListedOrgId] = useState<string | null>(null);
  // Only the most recent refresh may write list state: an org switch starts a
  // new listing while the previous (possibly multi-page) one is in flight, and
  // that older response must not land under the new scope.
  const refreshSeq = useRef(0);

  const refresh = useCallback(
    async (orgIdOverride?: string): Promise<Site[] | null> => {
      const targetOrgId = orgIdOverride ?? orgId;
      if (!targetOrgId && !fleet) return null;
      const seq = ++refreshSeq.current;
      const isLatest = () => seq === refreshSeq.current;
      setSitesLoading(true);
      setSitesFailed(false);
      try {
        // `strictShape`: a 200 OK body that isn't a parseable list throws
        // instead of failing closed to `[]`, so the catch below still sets
        // `sitesFailed` and callers keep suppressing the first-site nag rather
        // than treating an unreadable response as a confirmed zero.
        const siteList = targetOrgId
          ? await fetchAllSites<Site>(
              `/orgs/sites?organizationId=${targetOrgId}`,
              { orgIdOverride: targetOrgId },
              { strictShape: true },
            )
          : await fetchAllSites<Site>('/orgs/sites', { orgIdOverride: null }, { strictShape: true });
        if (isLatest()) {
          setSites(siteList);
          setListedOrgId(targetOrgId ?? null);
        }
        return siteList;
      } catch (err) {
        console.warn('[useSiteCrud] failed to fetch sites', targetOrgId ?? '(fleet)', err);
        if (isLatest()) {
          setSites([]);
          setSitesFailed(true);
          setListedOrgId(null);
        }
        return null;
      } finally {
        if (isLatest()) setSitesLoading(false);
      }
    },
    [orgId, fleet],
  );

  const clear = useCallback(() => {
    refreshSeq.current += 1; // an in-flight refresh must not repopulate a cleared list
    setSitesLoading(false);
    setSites([]);
    setSitesFailed(false);
    setListedOrgId(null);
  }, []);

  const openAdd = useCallback(
    (targetOrgId?: unknown) => {
      const target = typeof targetOrgId === 'string' && targetOrgId ? targetOrgId : orgId;
      setWriteOrgId(target);
      setSelectedSite(null);
      // An org confirmed to have no sites gets the "Add the first site" dialog
      // (#9868) — the destination of the org board's "No site" chip.
      setGuidingFirstSite(
        !fleet && !sitesLoading && !sitesFailed && sites.length === 0 && !!target && target === listedOrgId,
      );
      setSiteModalMode('add');
    },
    [orgId, fleet, sitesLoading, sitesFailed, sites.length, listedOrgId],
  );

  const openEdit = useCallback(
    (site: Site) => {
      setWriteOrgId(site.orgId ?? orgId);
      setSelectedSite(site);
      setSiteModalMode('edit');
    },
    [orgId],
  );

  const openDelete = useCallback(
    (site: Site) => {
      setWriteOrgId(site.orgId ?? orgId);
      setSelectedSite(site);
      setSiteModalMode('delete');
    },
    [orgId],
  );

  const close = useCallback(() => {
    setSiteModalMode('closed');
    setSelectedSite(null);
    setWriteOrgId(null);
    setGuidingFirstSite(false);
  }, []);

  const surfaceUnexpectedError = useCallback(
    (err: unknown) => {
      // runAction already surfaced an ActionError as a toast, and onUnauthorized
      // handles 401. Only a non-ActionError escape is unsurfaced here — see
      // OrganizationsPage's original handlers for the full reasoning (the page
      // banner these once fell back to renders behind the still-open modal).
      if (!(err instanceof ActionError)) {
        showToast({
          message: err instanceof Error ? err.message : t('settings:organizationsPage.errors.generic'),
          type: 'error',
        });
      }
    },
    [t],
  );

  const refuseNoOrg = useCallback(() => {
    console.warn('[useSiteCrud] write refused: no organization resolved for this site');
    showToast({ message: t('settings:organizationsPage.errors.generic'), type: 'error' });
  }, [t]);

  const submit = useCallback(
    async (values: Record<string, unknown>) => {
      // The org captured when the modal opened — never the bound org at submit
      // time, which an org switch may have moved since.
      const targetOrgId = writeOrgId;
      if (!targetOrgId) {
        // Fleet-view add is stopped earlier by the dialog's org picker; this
        // only trips on a row that carries no org — refuse visibly.
        refuseNoOrg();
        return;
      }
      setSiteSubmitting(true);
      try {
        const payload = {
          orgId: targetOrgId,
          name: values.name,
          timezone: values.timezone,
          address: {
            line1: values.addressLine1,
            line2: values.addressLine2,
            city: values.city,
            state: values.state,
            postalCode: values.postalCode,
            country: values.country,
          },
          contact: {
            name: values.contactName,
            email: values.contactEmail,
            phone: values.contactPhone,
          },
        };

        const url = siteModalMode === 'edit' && selectedSite ? `/orgs/sites/${selectedSite.id}` : '/orgs/sites';
        const method = siteModalMode === 'edit' ? 'PATCH' : 'POST';

        await runAction({
          request: () => fetchWithAuth(url, { method, body: JSON.stringify(payload), orgIdOverride: targetOrgId }),
          // `organizationsPage.errors.saveSite` interpolates {{status}}, which
          // runAction does not expose when building the fallback — this is the
          // existing status-free sibling, present in all 8 locales.
          errorFallback: t('settings:siteDetailPage.errors.saveSite'),
          onUnauthorized,
        });

        await refresh();
        close();
      } catch (err) {
        surfaceUnexpectedError(err);
      } finally {
        setSiteSubmitting(false);
      }
    },
    [writeOrgId, siteModalMode, selectedSite, refresh, close, onUnauthorized, t, surfaceUnexpectedError, refuseNoOrg],
  );

  const confirmDelete = useCallback(async () => {
    const targetOrgId = writeOrgId;
    if (!selectedSite) return;
    if (!targetOrgId) {
      refuseNoOrg();
      return;
    }
    setSiteSubmitting(true);
    try {
      await runAction({
        request: () => fetchWithAuth(`/orgs/sites/${selectedSite.id}`, { method: 'DELETE', orgIdOverride: targetOrgId }),
        errorFallback: t('settings:organizationsPage.errors.deleteSite'),
        onUnauthorized,
      });

      await refresh();
      close();
    } catch (err) {
      surfaceUnexpectedError(err);
    } finally {
      setSiteSubmitting(false);
    }
  }, [selectedSite, writeOrgId, refresh, close, onUnauthorized, t, surfaceUnexpectedError, refuseNoOrg]);

  const getSiteFormDefaults = useCallback(
    (site: Site): SiteFormDefaults => ({
      name: site.name,
      timezone: site.timezone,
      addressLine1: str(site.address?.line1),
      addressLine2: str(site.address?.line2),
      city: str(site.address?.city),
      state: str(site.address?.state),
      postalCode: str(site.address?.postalCode),
      country: str(site.address?.country),
      contactName: str(site.contact?.name),
      contactEmail: str(site.contact?.email),
      contactPhone: str(site.contact?.phone),
    }),
    [],
  );

  return {
    sites,
    sitesLoading,
    sitesFailed,
    siteSubmitting,
    siteModalMode,
    selectedSite,
    guidingFirstSite,
    setGuidingFirstSite,
    refresh,
    clear,
    openAdd,
    writeOrgId,
    setWriteOrgId,
    openEdit,
    openDelete,
    close,
    submit,
    confirmDelete,
    getSiteFormDefaults,
  };
}
