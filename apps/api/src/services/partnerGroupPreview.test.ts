import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { FilterConditionGroup } from '@breeze/shared/types/filters';

vi.mock('./partnerGroupEvaluation', () => ({
  PARTNER_GROUP_ORG_PAGE_SIZE: 2,
  listPartnerGroupEvaluationOrgIds: vi.fn(),
}));
vi.mock('./filterEngine', () => ({
  evaluateFilterWithPreview: vi.fn(),
  FilterQueryTimeoutError: class FilterQueryTimeoutError extends Error {},
}));
vi.mock('./filterPreviewTimeout', () => ({ reportFilterPreviewTimeout: vi.fn() }));
import { evaluateFilterWithPreview, FilterQueryTimeoutError } from './filterEngine';
import { listPartnerGroupEvaluationOrgIds } from './partnerGroupEvaluation';
import { reportFilterPreviewTimeout } from './filterPreviewTimeout';
import { previewPartnerGroup } from './partnerGroupPreview';

const filter: FilterConditionGroup = { operator: 'AND', conditions: [] };
const group = { id: 'group', partnerId: 'partner', filterConditions: filter };
const auth = { scope: 'partner' as const, accessibleOrgIds: ['org-a', 'org-b', 'org-c'] };
const device = { id: 'device', hostname: 'Host', displayName: null, osType: 'linux', status: 'online', lastSeenAt: null };

beforeEach(() => { vi.resetAllMocks(); });

describe('previewPartnerGroup', () => {
  it('returns partial when the 5 s budget runs out before the next org', async () => {
    let clock = 0;
    const listOrgIds = vi.fn().mockResolvedValueOnce(['org-a', 'org-b']).mockResolvedValueOnce([]);
    const evaluate = vi.fn<typeof evaluateFilterWithPreview>().mockImplementation(async () => {
      clock = 5000;
      return { totalCount: 3, devices: [device], evaluatedAt: new Date() };
    });
    const result = await previewPartnerGroup(group, auth, { limit: 10, now: () => clock, listOrgIds, evaluate });
    expect(result).toMatchObject({ total: 3, partial: true, partialReason: 'budget', evaluatedOrgs: 1, totalOrgs: 2 });
    expect(result.devices).toEqual([{ ...device, orgId: 'org-a' }]);
    expect(evaluate).toHaveBeenCalledTimes(1);
  });

  it('paginates eligible org discovery and evaluates only accessible orgs, sequentially', async () => {
    const listOrgIds = vi.fn().mockResolvedValueOnce(['org-a', 'org-b']).mockResolvedValueOnce(['org-c']);
    const evaluate = vi.fn<typeof evaluateFilterWithPreview>().mockResolvedValue({ totalCount: 1, devices: [device], evaluatedAt: new Date() });
    const result = await previewPartnerGroup(group, { scope: 'partner', accessibleOrgIds: ['org-b', 'org-c'] }, { limit: 1, listOrgIds, evaluate });
    expect(listOrgIds.mock.calls).toEqual([['partner', null, 2], ['partner', 'org-b', 2]]);
    expect(evaluate.mock.calls.map(([, options]) => options)).toEqual([
      { orgId: 'org-b', allowedSiteIds: null, previewLimit: 1 },
      { orgId: 'org-c', allowedSiteIds: null, previewLimit: 0 },
    ]);
    expect(result).toMatchObject({ total: 2, partial: false, partialReason: null, evaluatedOrgs: 2, totalOrgs: 2 });
    expect(result.devices).toHaveLength(1);
  });

  it('uses discovery excluding Quick Support and holding orgs and lets system preview every eligible org', async () => {
    vi.mocked(listPartnerGroupEvaluationOrgIds).mockResolvedValueOnce(['org-a']);
    vi.mocked(evaluateFilterWithPreview).mockResolvedValue({ totalCount: 1, devices: [device], evaluatedAt: new Date() });
    const result = await previewPartnerGroup(group, { scope: 'system', accessibleOrgIds: null }, { limit: 5 });
    expect(listPartnerGroupEvaluationOrgIds).toHaveBeenCalledWith('partner', null, 2);
    expect(evaluateFilterWithPreview).toHaveBeenCalledWith(filter, { orgId: 'org-a', allowedSiteIds: null, previewLimit: 5 });
    expect(result).toMatchObject({ partial: false, partialReason: null, totalOrgs: 1 });
  });

  it('marks a first-org filter timeout as timeout with no evaluated orgs', async () => {
    const evaluate = vi.fn<typeof evaluateFilterWithPreview>().mockRejectedValue(new FilterQueryTimeoutError());
    const result = await previewPartnerGroup(group, auth, { limit: 10, listOrgIds: vi.fn().mockResolvedValue(['org-a']), evaluate });
    expect(result).toMatchObject({ total: 0, partial: true, partialReason: 'timeout', evaluatedOrgs: 0, totalOrgs: 1 });
    expect(reportFilterPreviewTimeout).toHaveBeenCalledWith('org-a');
  });

  it('retains successful progress when a later org times out', async () => {
    const listOrgIds = vi.fn().mockResolvedValueOnce(['org-a', 'org-b']).mockResolvedValueOnce(['org-c']);
    const evaluate = vi.fn<typeof evaluateFilterWithPreview>()
      .mockResolvedValueOnce({ totalCount: 3, devices: [device], evaluatedAt: new Date() })
      .mockRejectedValueOnce(new FilterQueryTimeoutError());
    const result = await previewPartnerGroup(group, auth, { limit: 10, listOrgIds, evaluate });
    expect(result).toEqual({ devices: [{ ...device, orgId: 'org-a' }], total: 3,
      partial: true, partialReason: 'timeout', evaluatedOrgs: 1, totalOrgs: 3 });
    expect(evaluate.mock.calls.map(([, options]) => options.orgId)).toEqual(['org-a', 'org-b']);
    expect(reportFilterPreviewTimeout).toHaveBeenCalledExactlyOnceWith('org-b');
  });

  it('distinguishes budget exhaustion before the first org from a query timeout', async () => {
    const evaluate = vi.fn<typeof evaluateFilterWithPreview>();
    const result = await previewPartnerGroup(group, auth, {
      limit: 10, budgetMs: 0, now: () => 0, listOrgIds: vi.fn().mockResolvedValue(['org-a']), evaluate,
    });
    expect(result).toEqual({ devices: [], total: 0, partial: true, partialReason: 'budget', evaluatedOrgs: 0, totalOrgs: 1 });
    expect(evaluate).not.toHaveBeenCalled();
    expect(reportFilterPreviewTimeout).not.toHaveBeenCalled();
  });

  it('rethrows other errors', async () => {
    const error = new Error('database unavailable');
    await expect(previewPartnerGroup(group, auth, { limit: 10, listOrgIds: vi.fn().mockResolvedValue(['org-a']), evaluate: vi.fn().mockRejectedValue(error) })).rejects.toBe(error);
  });

  it('fails closed with an empty accessible-org set', async () => {
    const evaluate = vi.fn();
    expect(await previewPartnerGroup(group, { scope: 'partner', accessibleOrgIds: [] }, { limit: 5, listOrgIds: vi.fn().mockResolvedValue(['org-a']), evaluate })).toMatchObject({ total: 0, totalOrgs: 0, evaluatedOrgs: 0, partial: false, partialReason: null });
    expect(evaluate).not.toHaveBeenCalled();
  });
});
