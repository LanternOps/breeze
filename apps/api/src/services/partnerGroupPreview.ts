import type { FilterConditionGroup, FilterPreviewDevice } from '@breeze/shared/types/filters';
import type { AuthContext } from '../middleware/auth';
import { evaluateFilterWithPreview, FilterQueryTimeoutError } from './filterEngine';
import { reportFilterPreviewTimeout } from './filterPreviewTimeout';
import { listPartnerGroupEvaluationOrgIds, PARTNER_GROUP_ORG_PAGE_SIZE } from './partnerGroupEvaluation';

interface PartnerGroupPreviewOptions {
  budgetMs?: number;
  limit: number;
  now?: () => number;
  listOrgIds?: typeof listPartnerGroupEvaluationOrgIds;
  evaluate?: typeof evaluateFilterWithPreview;
}

/** Read-only fan-out: discovery excludes Quick Support/holding orgs; evaluations
 * retain the caller's request context and explicit accessible-org intersection. */
export async function previewPartnerGroup(
  group: { id: string; partnerId: string; filterConditions: FilterConditionGroup },
  auth: Pick<AuthContext, 'scope' | 'accessibleOrgIds'>,
  { budgetMs = 5000, limit, now = () => performance.now(), listOrgIds = listPartnerGroupEvaluationOrgIds,
    evaluate = evaluateFilterWithPreview }: PartnerGroupPreviewOptions,
): Promise<{
  devices: Array<FilterPreviewDevice & { orgId: string }>;
  total: number;
  partial: boolean;
  evaluatedOrgs: number;
  totalOrgs: number;
}> {
  const started = now();
  const orgIds: string[] = [];
  const accessible = new Set(auth.accessibleOrgIds ?? []);
  let after: string | null = null;
  for (;;) {
    const page = await listOrgIds(group.partnerId, after, PARTNER_GROUP_ORG_PAGE_SIZE);
    orgIds.push(...page.filter((orgId) => auth.scope === 'system' || accessible.has(orgId)));
    if (page.length < PARTNER_GROUP_ORG_PAGE_SIZE) break;
    const last = page.at(-1);
    if (!last) break;
    after = last;
  }

  const devices: Array<FilterPreviewDevice & { orgId: string }> = [];
  const result = { devices, total: 0,
    partial: false, evaluatedOrgs: 0, totalOrgs: orgIds.length };
  const previewLimit = Math.max(0, limit);
  for (const orgId of orgIds) {
    if (now() - started >= budgetMs) {
      result.partial = true;
      break;
    }
    try {
      const preview = await evaluate(group.filterConditions, {
        orgId, allowedSiteIds: null, previewLimit: Math.max(0, previewLimit - result.devices.length),
      });
      result.total += preview.totalCount;
      result.devices.push(...preview.devices.slice(0, previewLimit - result.devices.length).map((device) => ({ ...device, orgId })));
      result.evaluatedOrgs++;
    } catch (error) {
      if (!(error instanceof FilterQueryTimeoutError)) throw error;
      reportFilterPreviewTimeout(orgId);
      result.partial = true;
      break;
    }
  }
  return result;
}
