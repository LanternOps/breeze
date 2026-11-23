import { useEffect, useState } from 'react';
import { fetchWithAuth } from '../../../stores/auth';
import type { FeatureLink, ParentPolicySummary } from '../featureTabs/types';
import type { DraftParent } from './usePolicyDraft';

/**
 * The parent chosen under "Start from" on the create page, with its feature
 * links, so the rail can say *From parent* before anything is saved. Until the
 * read answers, and after a failed read, the parent is named with no links;
 * `failed` lets the page say it could not read what the parent sets.
 */
export function useDraftParent(parent: DraftParent | null): { summary: ParentPolicySummary | null; failed: boolean } {
  const [summary, setSummary] = useState<ParentPolicySummary | null>(null);
  const [failed, setFailed] = useState(false);
  const parentId = parent?.id ?? null;
  const parentName = parent?.name ?? '';
  useEffect(() => {
    setFailed(false);
    if (!parentId) {
      setSummary(null);
      return;
    }
    let cancelled = false;
    // Named until the read answers; no features are claimed before it does.
    setSummary({ id: parentId, name: parentName, status: 'active', orgId: null, featureLinks: [] });
    const fail = () => {
      if (!cancelled) setFailed(true);
    };
    void (async () => {
      try {
        const response = await fetchWithAuth(`/configuration-policies/${parentId}`);
        if (!response.ok) return fail();
        const body = (await response.json().catch(() => null)) as Record<string, unknown> | null;
        if (cancelled) return;
        if (!body || body.id !== parentId) return fail();
        const status = body.status === 'inactive' || body.status === 'archived' ? body.status : 'active';
        setSummary({
          id: parentId,
          name: typeof body.name === 'string' ? body.name : parentName,
          status,
          orgId: typeof body.orgId === 'string' ? body.orgId : null,
          featureLinks: Array.isArray(body.featureLinks) ? (body.featureLinks as FeatureLink[]) : [],
        });
      } catch (err) {
        console.warn('[configuration policies] parent read failed', err);
        fail();
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [parentId, parentName]);
  return { summary, failed };
}
