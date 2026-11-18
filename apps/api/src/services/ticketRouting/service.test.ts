import { beforeEach, describe, expect, it, vi } from 'vitest';

const { repo, refs, evaluate } = vi.hoisted(() => ({
  repo: {
    findRule: vi.fn(),
    findRules: vi.fn(),
    findOrg: vi.fn(),
    orgIdsOfPartner: vi.fn(),
    listRuleRows: vi.fn(),
    linksFor: vi.fn(),
    nextPosition: vi.fn(),
    insertRule: vi.fn(),
    updateRule: vi.fn(),
    deleteRule: vi.fn(),
    replaceLinks: vi.fn(),
    setPositions: vi.fn(),
  },
  refs: {
    assertCategoryInPartner: vi.fn(),
    getAssigneeForValidation: vi.fn(),
    getTicketStatusById: vi.fn(),
  },
  evaluate: vi.fn(),
}));
vi.mock('./repository', () => repo);
vi.mock('../ticketService', () => ({
  assertCategoryInPartner: refs.assertCategoryInPartner,
  getAssigneeForValidation: refs.getAssigneeForValidation,
}));
vi.mock('../ticketConfigService', () => ({ getTicketStatusById: refs.getTicketStatusById }));
vi.mock('./evaluate', () => ({
  evaluateRoutingRules: evaluate,
  NO_EXPLICIT_CHOICES: { priority: false, categoryId: false, assigneeId: false, statusId: false },
  ROUTABLE_STATUS_CORES: ['new', 'open', 'pending', 'on_hold'],
}));
vi.mock('../../db', () => ({ db: { execute: vi.fn() } }));

import {
  createRoutingRule,
  deleteRoutingRule,
  listRoutingRules,
  reorderRoutingRules,
  testRoutingRules,
  TicketRoutingError,
  updateRoutingRule,
  type RoutingAuth,
} from './service';
import { PartnerWideWriteDeniedError } from '../partnerWideAccess';

const P = 'p-1';
const O1 = 'o-1';
const O2 = 'o-2';

const partnerAll: RoutingAuth = {
  scope: 'partner', partnerId: P, orgId: null, partnerOrgAccess: 'all', accessibleOrgIds: [O1, O2],
  canAccessOrg: (id: string) => [O1, O2].includes(id), user: { id: 'u-admin' },
};
const partnerSelected: RoutingAuth = { ...partnerAll, partnerOrgAccess: 'selected', accessibleOrgIds: [O1], canAccessOrg: (id) => id === O1 };
const orgScope: RoutingAuth = {
  scope: 'organization', partnerId: P, orgId: O1, partnerOrgAccess: undefined, accessibleOrgIds: [O1], canAccessOrg: (id) => id === O1, user: { id: 'u-org' },
} as RoutingAuth;

const row = (over: Record<string, unknown> = {}) => ({
  id: 'r-1', orgId: null, partnerId: P, name: 'Rule', enabled: true, position: 0,
  matchSources: null, matchPriorities: null, matchCategoryId: null, matchSubjectKeywords: null, matchRequesterDomains: null,
  setAssigneeUserId: null, setPriority: 'high', setCategoryId: null, setStatusId: null, addTags: null, orgScoped: false,
  createdByUserId: null, createdAt: new Date('2026-01-01T00:00:00Z'), updatedAt: new Date('2026-01-01T00:00:00Z'),
  ...over,
});

beforeEach(() => {
  vi.resetAllMocks();
  repo.findOrg.mockImplementation(async (id: string) => ({ id, partnerId: P }));
  repo.nextPosition.mockResolvedValue(3);
  repo.insertRule.mockImplementation(async (v: Record<string, unknown>) => row({ id: 'r-new', ...v }));
  repo.updateRule.mockImplementation(async (id: string, set: Record<string, unknown>) => row({ id, ...set }));
  repo.linksFor.mockResolvedValue(new Map());
  repo.orgIdsOfPartner.mockImplementation(async (ids: string[]) => ids.filter((i) => [O1, O2].includes(i)));
  repo.deleteRule.mockResolvedValue(true);
  repo.setPositions.mockImplementation(async (ids: string[]) => ids.length);
  refs.assertCategoryInPartner.mockResolvedValue({ id: 'c', partnerId: P });
  refs.getAssigneeForValidation.mockImplementation(async (id: string) => ({ id, partnerId: P, status: 'active' }));
  refs.getTicketStatusById.mockImplementation(async (id: string) => ({ id, partnerId: P, coreStatus: 'pending', name: 'Waiting', isActive: true, isSystem: false }));
});

const expectCode = async (p: Promise<unknown>, status: number, code: string) => {
  const err = await p.then(() => null, (e: unknown) => e);
  expect(err).toBeInstanceOf(TicketRoutingError);
  expect(err).toMatchObject({ status, code });
};

describe('writer gates', () => {
  it('an organization-scope caller writes nothing (403)', async () => {
    await expectCode(createRoutingRule(orgScope, { name: 'x', ownerScope: 'organization', orgId: O1, setPriority: 'high' }), 403, 'ACCESS_DENIED');
    await expectCode(updateRoutingRule(orgScope, 'r-1', { enabled: false }), 403, 'ACCESS_DENIED');
    await expectCode(deleteRoutingRule(orgScope, 'r-1'), 403, 'ACCESS_DENIED');
    await expectCode(reorderRoutingRules(orgScope, ['r-1']), 403, 'ACCESS_DENIED');
    expect(repo.insertRule).not.toHaveBeenCalled();
  });

  it('partner-wide create / update / delete / reorder are refused IN THE SERVICE without canManagePartnerWidePolicies', async () => {
    const denied = (p: Promise<unknown>) => expect(p).rejects.toBeInstanceOf(PartnerWideWriteDeniedError);
    await denied(createRoutingRule(partnerSelected, { name: 'x', ownerScope: 'partner', setPriority: 'high' }));
    repo.findRule.mockResolvedValue(row());
    repo.findRules.mockResolvedValue([row()]);
    await denied(updateRoutingRule(partnerSelected, 'r-1', { enabled: false }));
    await denied(deleteRoutingRule(partnerSelected, 'r-1'));
    await denied(reorderRoutingRules(partnerSelected, ['r-1']));
    expect(repo.insertRule).not.toHaveBeenCalled();
    expect(repo.updateRule).not.toHaveBeenCalled();
    expect(repo.deleteRule).not.toHaveBeenCalled();
    expect(repo.setPositions).not.toHaveBeenCalled();
  });

  it('a selected-access partner user manages org rules of orgs it can reach, and nothing else', async () => {
    const created = await createRoutingRule(partnerSelected, { name: 'x', ownerScope: 'organization', orgId: O1, setPriority: 'high' });
    expect(created.orgId).toBe(O1);
    await expectCode(createRoutingRule(partnerSelected, { name: 'x', ownerScope: 'organization', orgId: O2, setPriority: 'high' }), 404, 'NOT_FOUND');
    repo.findRule.mockResolvedValue(row({ orgId: O2, partnerId: null }));
    await expectCode(updateRoutingRule(partnerSelected, 'r-1', { enabled: false }), 404, 'NOT_FOUND');
  });

  it("another partner's partner-wide rule reads as missing", async () => {
    repo.findRule.mockResolvedValue(row({ partnerId: 'p-OTHER' }));
    await expectCode(updateRoutingRule(partnerAll, 'r-1', { enabled: false }), 404, 'NOT_FOUND');
  });
});

describe('Gate B13: a rule must set at least one action', () => {
  it('create with no action is 400 ROUTING_RULE_NO_ACTION', async () => {
    await expectCode(createRoutingRule(partnerAll, { name: 'x', ownerScope: 'partner', matchSubjectKeywords: ['printer'] }), 400, 'ROUTING_RULE_NO_ACTION');
    await expectCode(createRoutingRule(partnerAll, { name: 'x', ownerScope: 'partner', addTags: [] }), 400, 'ROUTING_RULE_NO_ACTION');
  });

  it('an update that would leave the MERGED row without an action is 400', async () => {
    repo.findRule.mockResolvedValue(row({ setPriority: 'high' }));
    await expectCode(updateRoutingRule(partnerAll, 'r-1', { setPriority: null }), 400, 'ROUTING_RULE_NO_ACTION');
    // A field-only update on a rule that has an action is fine.
    await expect(updateRoutingRule(partnerAll, 'r-1', { enabled: false })).resolves.toMatchObject({ enabled: false });
  });

  it('a rule emptied by a user deletion stays editable as long as the edit adds an action', async () => {
    repo.findRule.mockResolvedValue(row({ setPriority: null }));
    await expectCode(updateRoutingRule(partnerAll, 'r-1', { name: 'renamed' }), 400, 'ROUTING_RULE_NO_ACTION');
    await expect(updateRoutingRule(partnerAll, 'r-1', { setPriority: 'low' })).resolves.toMatchObject({ setPriority: 'low' });
  });
});

describe('references and org links', () => {
  it('a category, status or assignee of another partner is 400 ROUTING_RULE_REFERENCE_INVALID', async () => {
    refs.assertCategoryInPartner.mockRejectedValueOnce(Object.assign(new Error('x'), { code: 'CATEGORY_WRONG_PARTNER' }));
    await expectCode(createRoutingRule(partnerAll, { name: 'x', ownerScope: 'partner', setCategoryId: 'c-foreign' }), 400, 'ROUTING_RULE_REFERENCE_INVALID');
    refs.getTicketStatusById.mockResolvedValueOnce({ id: 's', partnerId: 'p-OTHER', coreStatus: 'open', name: 's', isActive: true, isSystem: false });
    await expectCode(createRoutingRule(partnerAll, { name: 'x', ownerScope: 'partner', setStatusId: 's' }), 400, 'ROUTING_RULE_REFERENCE_INVALID');
    refs.getAssigneeForValidation.mockResolvedValueOnce({ id: 'u', partnerId: 'p-OTHER', status: 'active' });
    await expectCode(createRoutingRule(partnerAll, { name: 'x', ownerScope: 'partner', setAssigneeUserId: 'u' }), 400, 'ROUTING_RULE_REFERENCE_INVALID');
    refs.getAssigneeForValidation.mockResolvedValueOnce(null);
    await expectCode(createRoutingRule(partnerAll, { name: 'x', ownerScope: 'partner', setAssigneeUserId: 'u' }), 400, 'ROUTING_RULE_REFERENCE_INVALID');
  });

  it('a status whose core is not new/open/pending/on_hold is 400 ROUTING_RULE_STATUS_NOT_ALLOWED', async () => {
    refs.getTicketStatusById.mockResolvedValueOnce({ id: 's', partnerId: P, coreStatus: 'resolved', name: 's', isActive: true, isSystem: false });
    await expectCode(createRoutingRule(partnerAll, { name: 'x', ownerScope: 'partner', setStatusId: 's' }), 400, 'ROUTING_RULE_STATUS_NOT_ALLOWED');
  });

  it('a partner-wide rule limited to orgs stores org_scoped + links; orgs must belong to the partner', async () => {
    await createRoutingRule(partnerAll, { name: 'x', ownerScope: 'partner', setPriority: 'high', orgIds: [O1, O2] });
    expect(repo.insertRule.mock.calls[0]![0]).toMatchObject({ orgScoped: true, partnerId: P, orgId: null, position: 3, createdByUserId: 'u-admin' });
    expect(repo.replaceLinks).toHaveBeenCalledWith('r-new', [O1, O2]);
    await expectCode(createRoutingRule(partnerAll, { name: 'x', ownerScope: 'partner', setPriority: 'high', orgIds: [O1, 'o-foreign'] }), 400, 'ROUTING_RULE_ORG_INVALID');
  });

  it('an org rule cannot carry org links; clearing a partner-wide rule\'s list makes it apply to all orgs', async () => {
    repo.findRule.mockResolvedValue(row({ orgId: O1, partnerId: null }));
    await expectCode(updateRoutingRule(partnerAll, 'r-1', { orgIds: [O1] }), 400, 'ROUTING_RULE_ORG_LINKS_NOT_ALLOWED');
    repo.findRule.mockResolvedValue(row({ orgScoped: true }));
    await updateRoutingRule(partnerAll, 'r-1', { orgIds: null });
    expect(repo.updateRule.mock.calls.at(-1)![1]).toMatchObject({ orgScoped: false });
    expect(repo.replaceLinks).toHaveBeenCalledWith('r-1', []);
  });
});

describe('reorder', () => {
  it('rejects ids spanning two owners, and unknown ids', async () => {
    repo.findRules.mockResolvedValue([row({ id: 'a' }), row({ id: 'b', orgId: O1, partnerId: null })]);
    await expectCode(reorderRoutingRules(partnerAll, ['a', 'b']), 400, 'ROUTING_RULE_REORDER_MIXED_OWNERS');
    repo.findRules.mockResolvedValue([row({ id: 'a' })]);
    await expectCode(reorderRoutingRules(partnerAll, ['a', 'missing']), 404, 'NOT_FOUND');
    expect(repo.setPositions).not.toHaveBeenCalled();
  });

  it('writes positions in the given order for one owner', async () => {
    repo.findRules.mockResolvedValue([row({ id: 'a' }), row({ id: 'b' })]);
    expect(await reorderRoutingRules(partnerAll, ['b', 'a'])).toEqual({ updated: 2 });
    expect(repo.setPositions).toHaveBeenCalledWith(['b', 'a']);
  });
});

describe('list', () => {
  it('a partner caller gets its partner-wide rules plus the org rules it can reach (app-layer dual-axis filter)', async () => {
    repo.listRuleRows.mockResolvedValue([]);
    await listRoutingRules(partnerSelected, {});
    expect(repo.listRuleRows).toHaveBeenCalledWith({ orgIds: [O1], partnerId: P });
    await listRoutingRules(partnerSelected, { orgId: O1 });
    expect(repo.listRuleRows).toHaveBeenLastCalledWith({ orgIds: [O1], partnerId: P });
    await expectCode(listRoutingRules(partnerSelected, { orgId: O2 }), 404, 'NOT_FOUND');
  });

  it('an org caller reads through RLS for its own org only; an org_scoped rule that does not list it is hidden', async () => {
    repo.listRuleRows.mockResolvedValue([
      row({ id: 'own', orgId: O1, partnerId: null }),
      row({ id: 'all-orgs' }),
      row({ id: 'listed', orgScoped: true }),
      row({ id: 'not-listed', orgScoped: true }),
    ]);
    repo.linksFor.mockResolvedValue(new Map([['listed', [O1]]]));
    const out = await listRoutingRules(orgScope, {});
    expect(repo.listRuleRows).toHaveBeenCalledWith({ orgIds: [O1], partnerId: P });
    expect(out.map((r) => r.id)).toEqual(['own', 'all-orgs', 'listed']);
    expect(out.find((r) => r.id === 'all-orgs')!.orgIds).toBeNull();
    expect(out.find((r) => r.id === 'listed')!.orgIds).toEqual([O1]);
    await expectCode(listRoutingRules(orgScope, { orgId: O2 }), 404, 'NOT_FOUND');
  });
});

describe('test (dry run)', () => {
  it('runs the same evaluator for the org and its partner and writes nothing', async () => {
    evaluate.mockResolvedValue({ ruleId: 'r-1', ruleName: 'Rule', applied: { priority: 'high' }, skipped: [], appliedStatusCore: null });
    const out = await testRoutingRules(orgScope, { orgId: O1, source: 'email', subject: 'Printer', requesterEmail: 'a@b.com', priority: 'low' });
    expect(out).toEqual({ ruleId: 'r-1', ruleName: 'Rule', applied: { priority: 'high' }, skipped: [] });
    const [, owner, facts, explicit] = evaluate.mock.calls[0]!;
    expect(owner).toEqual({ partnerId: P, orgId: O1, deviceId: null });
    expect(facts).toEqual({ source: 'email', priority: 'low', categoryId: null, subject: 'Printer', requesterEmail: 'a@b.com' });
    expect(explicit).toEqual({ priority: true, categoryId: false, assigneeId: false, statusId: false });
    for (const write of [repo.insertRule, repo.updateRule, repo.deleteRule, repo.replaceLinks, repo.setPositions]) {
      expect(write).not.toHaveBeenCalled();
    }
  });

  it('an org the caller cannot reach is 404', async () => {
    await expectCode(testRoutingRules(orgScope, { orgId: O2, source: 'email', subject: 'x', requesterEmail: null }), 404, 'NOT_FOUND');
    await expectCode(testRoutingRules(partnerSelected, { orgId: O2, source: 'email', subject: 'x', requesterEmail: null }), 404, 'NOT_FOUND');
  });
});
