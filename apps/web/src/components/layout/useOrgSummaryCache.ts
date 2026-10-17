import { useEffect, useRef, useState } from 'react';
import { useJwtClaims } from '@/lib/authScope';
import { makeOrgFetch, type OrgSummary } from '@/components/organizations/record/orgRecordFetch';

/** How long a highlight must rest on one org before its summary is fetched. */
export const SUMMARY_INTENT_DELAY_MS = 120;

export type OrgSummaryStatus = 'idle' | 'loading' | 'ready' | 'error';

export interface OrgSummaryLookup {
  summary: OrgSummary | undefined;
  status: OrgSummaryStatus;
}

/**
 * Lazy, intent-delayed read of `GET /orgs/organizations/:id/summary` for the
 * org switcher's pane. Results are cached for the lifetime of one panel open
 * (`active`); a highlight that merely passes over a row never fetches; an
 * org-scoped session (or one the API has refused with 403) never fetches at
 * all. Failures are silent — the pane just shows no counts.
 */
export function useOrgSummaryCache(orgId: string | null, active: boolean): OrgSummaryLookup {
  const claims = useJwtClaims();
  const cacheRef = useRef<Map<string, OrgSummary | 'error'>>(new Map());
  const inflightRef = useRef<Set<string>>(new Set());
  // A session fact (the caller's token cannot read summaries), so it outlives
  // panel closes. A ref, not state: it only ever flips once, alongside a bump.
  const forbiddenRef = useRef(false);
  // Bumped on every close so a response that lands after the panel closed (and
  // reopened) is discarded instead of repopulating the fresh cache.
  const epochRef = useRef(0);
  const [, setVersion] = useState(0);

  const scopeAllowed = claims.status === 'resolved' && claims.claims.scope !== 'organization';
  const allowed = active && scopeAllowed && !forbiddenRef.current;

  useEffect(() => {
    if (active) return;
    cacheRef.current.clear();
    inflightRef.current.clear();
    epochRef.current += 1;
  }, [active]);

  useEffect(() => {
    if (!allowed || !orgId) return;
    if (cacheRef.current.has(orgId) || inflightRef.current.has(orgId)) return;
    const timer = setTimeout(async () => {
      const epoch = epochRef.current;
      inflightRef.current.add(orgId);
      let result: OrgSummary | 'error' = 'error';
      try {
        const res = await makeOrgFetch(orgId)(`/orgs/organizations/${orgId}/summary`);
        if (res.ok) {
          const body = (await res.json()) as unknown;
          // A 200 that is not a summary (null, {success:false}, …) is an error,
          // not a pane that skeletons forever or throws on `sites.count`.
          const valid =
            typeof body === 'object' && body !== null && typeof (body as OrgSummary).sites?.count === 'number';
          if (valid) result = body as OrgSummary;
        }
        else if (res.status === 403) forbiddenRef.current = true;
      } catch {
        result = 'error';
      }
      if (epoch !== epochRef.current) return;
      inflightRef.current.delete(orgId);
      cacheRef.current.set(orgId, result);
      // Re-render so the hook re-reads the cache for the CURRENT orgId; a
      // response for another org only fills the cache.
      setVersion((v) => v + 1);
    }, SUMMARY_INTENT_DELAY_MS);
    return () => clearTimeout(timer);
  }, [orgId, allowed]);

  if (!active || !orgId) return { summary: undefined, status: 'idle' };
  const cached = cacheRef.current.get(orgId);
  if (cached === 'error') return { summary: undefined, status: 'error' };
  if (cached) return { summary: cached, status: 'ready' };
  return { summary: undefined, status: allowed ? 'loading' : 'idle' };
}
