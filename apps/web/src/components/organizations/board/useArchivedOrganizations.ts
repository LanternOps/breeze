import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import '@/lib/i18n';
import type { Organization } from '@/components/settings/organizationTypes';
import { fetchWithAuth, handleSessionExpired } from '@/stores/auth';
import { fetchAllOrganizations } from '@/lib/fetchAllOrganizations';
import { useStableT } from '@/lib/i18n/useStableT';

/** Debounce for the search-driven refetch: a full page walk is real network
 *  work, slow enough to still be in flight when the next keystroke fires. */
export const ARCHIVED_SEARCH_DEBOUNCE_MS = 300;

export interface ArchivedOrganizationsApi {
  archivedOrgs: Organization[];
  loading: boolean;
  error?: string;
  /** Mirrors the list endpoint's `archivedTruncated` (archived rows are capped at the page limit, not paginated). */
  truncated: boolean;
  /** True once any fetch has landed — the Archived filter chip shows its count from then on. */
  loaded: boolean;
  /** Drop a row locally (after a restore) without waiting for a refetch. */
  remove: (orgId: string) => void;
}

/**
 * The Archived filter's rows. Fetched ONLY while `enabled` (the filter is
 * active) with `includeArchived=true` — deliberately not threaded through the
 * org store's page walk, which stays on the plain unarchived query every other
 * reader relies on. Walks every page (archived rows ride along on the LAST live
 * page only) and forwards `search` server-side, so an archived org past the
 * truncation cap stays reachable. A monotonic request id makes an older
 * response inert even when it resolves last.
 */
export function useArchivedOrganizations({ enabled, search }: { enabled: boolean; search: string }): ArchivedOrganizationsApi {
  const { t } = useTranslation('organizations');
  const stableT = useStableT(t); // #3632: effect-safe translator; JSX keeps `t`
  const [archivedOrgs, setArchivedOrgs] = useState<Organization[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string>();
  const [truncated, setTruncated] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const requestIdRef = useRef(0);

  const fetchArchived = useCallback(
    async (term: string) => {
      const requestId = ++requestIdRef.current;
      setLoading(true);
      setError(undefined);
      let wasTruncated = false;
      try {
        const all = await fetchAllOrganizations<Organization>(async (page, limit) => {
          const searchParam = term ? `&search=${encodeURIComponent(term)}` : '';
          const response = await fetchWithAuth(`/orgs/organizations?page=${page}&limit=${limit}&includeArchived=true${searchParam}`);
          if (!response.ok) {
            if (response.status === 401) {
              handleSessionExpired();
              return null;
            }
            throw new Error(stableT('orgBoard.archived.fetchError'));
          }
          const body = await response.json();
          // Present only on the page that carries the archived block; a page
          // that never looked must not overwrite a `true` from an earlier page.
          if (typeof body?.archivedTruncated === 'boolean') wasTruncated = body.archivedTruncated;
          return body;
        }, { order: 'server' });
        if (requestId !== requestIdRef.current || all === null) return;
        setArchivedOrgs(all.filter((org) => org.archived === true));
        setTruncated(wasTruncated);
        setLoaded(true);
      } catch (err) {
        if (requestId !== requestIdRef.current) return;
        setError(err instanceof Error ? err.message : stableT('orgBoard.errors.generic'));
      } finally {
        if (requestId === requestIdRef.current) setLoading(false);
      }
    },
    [stableT],
  );

  useEffect(() => {
    if (!enabled) return;
    const timer = setTimeout(() => {
      void fetchArchived(search.trim());
    }, ARCHIVED_SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [enabled, search, fetchArchived]);

  const remove = useCallback((orgId: string) => setArchivedOrgs((prev) => prev.filter((o) => o.id !== orgId)), []);

  return { archivedOrgs, loading, error, truncated, loaded, remove };
}
