import { useCallback, useEffect, useMemo, useRef } from 'react';
import { fetchWithAuth, type FetchWithAuthOptions } from '@/stores/auth';

/**
 * Org-pinned fetching for the organization record (#5075 W01).
 *
 * The record's subject is the org in the URL. The OrgSwitcher may point at a
 * different org, or at All organizations — ambient `?orgId=` injection would
 * then fill a page titled "Acme" with another customer's devices, which reads
 * as real data rather than as an error. Every request from inside the record
 * therefore names its org explicitly.
 */
export type OrgFetch = (
  path: string,
  // Both escape hatches are omitted, not just `orgIdOverride`: the two are
  // merged into one options bag below, and `skipOrgIdInjection` un-pins the
  // request just as effectively — silently, since it is the arm `applyOrgId`
  // takes first. Omitting only the obvious one would leave the pin defeatable
  // by the less obvious one, which is the whole guarantee this type exists for.
  init?: Omit<FetchWithAuthOptions, 'orgIdOverride' | 'skipOrgIdInjection'>,
) => Promise<Response>;

/**
 * The organization row as `GET /orgs/organizations/:id` returns it — only the
 * fields the record actually reads. `archived` is set by the API for the whole
 * archive lifecycle (flagged rows and mid-drain `offboarding`), not just for
 * `status === 'archived'`; see `lib/archiveLifecycle.ts`.
 */
export interface OrgRecordOrg {
  id: string;
  name: string;
  status: string;
  type?: string | null;
  archived?: boolean;
  currencyCode?: string | null;
  createdAt?: string;
}

/** `GET /orgs/organizations/:id/summary`. Sections the caller cannot read are
 *  absent, not zeroed — a tile is hidden rather than reporting a false zero. */
export interface OrgSummary {
  orgId: string;
  devices?: { total: number; online: number; offline: number };
  alerts?: { open: number; critical: number; high: number };
  tickets?: { open: number; awaitingCustomer: number };
  contracts?: { active: number; nextRenewalAt: string | null };
  invoices?: {
    outstanding: string;
    currencyCode: string | null;
    nextDueAt: string | null;
    overdueCount: number;
  };
  sites: { count: number };
  contacts?: {
    count: number;
    primary: { id: string; name: string; email: string | null; phone: string | null } | null;
  };
  portalUsers?: { count: number };
  lastActivityAt: string | null;
}

/**
 * A `fetchWithAuth` bound to one org. Callers pass ordinary relative paths; the
 * org is appended (and a path that already names a DIFFERENT org throws — see
 * `applyOrgId`).
 */
export function makeOrgFetch(orgId: string): OrgFetch {
  return (path, init) => fetchWithAuth(path, { ...init, orgIdOverride: orgId });
}

/**
 * Latest-wins guard for async reads.
 *
 * Tab switches and refreshes overlap: a slow first request can land after a
 * fast second one and repaint stale content over fresh content. `run` resolves
 * to `undefined` for any call that has been superseded — or whose component has
 * unmounted — so `if (data === undefined) return;` is the whole caller-side
 * contract. Rejections still propagate for the newest call, so genuine
 * failures stay visible.
 */
export function useLatest<T>(): { run: (p: Promise<T>) => Promise<T | undefined> } {
  const seq = useRef(0);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const run = useCallback(async (p: Promise<T>): Promise<T | undefined> => {
    const mine = ++seq.current;
    const value = await p;
    if (!mounted.current || mine !== seq.current) return undefined;
    return value;
  }, []);

  // The returned object must be referentially stable: callers put it in
  // `useCallback`/`useEffect` dependency arrays, and a fresh object each render
  // makes the loader re-fire on every state update it causes — an infinite
  // render loop that presents as a hung test worker, not as a failed assertion.
  return useMemo(() => ({ run }), [run]);
}
