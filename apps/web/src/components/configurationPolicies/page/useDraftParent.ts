import { useEffect, useState } from 'react';
import { fetchWithAuth } from '../../../stores/auth';
import type { FeatureLink, ParentPolicySummary } from '../featureTabs/types';
import type { DraftParent } from './usePolicyDraft';

/**
 * The parent chosen under "Start from" on the create page, with its feature
 * links, so the rail can say *From parent* before anything is saved. A failed
 * read keeps the parent named, with no links: the page claims nothing it
 * did not read.
 */
export function useDraftParent(parent: DraftParent | null): ParentPolicySummary | null {
  const [summary, setSummary] = useState<ParentPolicySummary | null>(null);
  const parentId = parent?.id ?? null;
  const parentName = parent?.name ?? '';
  useEffect(() => {
    if (!parentId) {
      setSummary(null);
      return;
    }
    let cancelled = false;
    setSummary({ id: parentId, name: parentName, status: 'active', orgId: null, featureLinks: [] });
    void (async () => {
      try {
        const response = await fetchWithAuth(`/configuration-policies/${parentId}`);
        if (!response.ok) return;
        const body = (await response.json().catch(() => null)) as Record<string, unknown> | null;
        if (cancelled || !body || body.id !== parentId) return;
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
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [parentId, parentName]);
  return summary;
}
