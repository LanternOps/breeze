import { beforeEach, describe, expect, it, vi } from 'vitest';

const { assertAssigneeEligible, assertCategoryInPartner, getTicketStatusById } = vi.hoisted(() => ({
  assertAssigneeEligible: vi.fn(),
  assertCategoryInPartner: vi.fn(),
  getTicketStatusById: vi.fn(),
}));
vi.mock('../ticketService', () => ({ assertAssigneeEligible, assertCategoryInPartner }));
vi.mock('../ticketConfigService', () => ({ getTicketStatusById }));

import { evaluateRoutingRules, NO_EXPLICIT_CHOICES, type ExplicitChoices } from './evaluate';
import type { RoutingFacts } from './match';

/** Flattens a drizzle sql`` to its static text (bound params dropped). */
function sqlText(q: unknown): string {
  if (q == null) return '';
  if (typeof q === 'string') return q;
  const obj = q as { queryChunks?: unknown[]; value?: unknown };
  if (Array.isArray(obj.queryChunks)) return obj.queryChunks.map(sqlText).join(' ');
  if (Array.isArray(obj.value)) return (obj.value as string[]).join('');
  return '';
}
function sqlParams(q: unknown, out: unknown[] = []): unknown[] {
  const obj = q as { queryChunks?: unknown[]; value?: unknown };
  if (obj && Array.isArray(obj.queryChunks)) {
    for (const c of obj.queryChunks) {
      if (c && typeof c === 'object' && ('queryChunks' in c || ('value' in c && Array.isArray((c as { value: unknown }).value)))) sqlParams(c, out);
      else if (c && typeof c === 'object' && 'value' in c) out.push((c as { value: unknown }).value);
      else if (typeof c !== 'object') out.push(c);
    }
  }
  return out;
}

const owner = { partnerId: 'p-1', orgId: 'o-1' };
const facts = (over: Partial<RoutingFacts> = {}): RoutingFacts => ({
  source: 'email', priority: null, categoryId: null, subject: 'Printer jam', requesterEmail: 'jane@example.com', ...over,
});

type Row = Record<string, unknown>;
let seq = 0;
const row = (over: Row = {}): Row => ({
  id: `00000000-0000-0000-0000-${String(++seq).padStart(12, '0')}`,
  org_id: null, partner_id: 'p-1', name: 'rule', enabled: true, position: 0,
  match_sources: null, match_priorities: null, match_category_id: null,
  match_subject_keywords: null, match_requester_domains: null,
  set_assignee_user_id: null, set_priority: 'high', set_category_id: null, set_status_id: null,
  add_tags: null, org_scoped: false, org_listed: false,
  ...over,
});
const dbReturning = (rows: Row[]) => ({ execute: vi.fn().mockResolvedValue(rows) });

class FakeTicketServiceError extends Error {
  constructor(message: string, public status: number, public code?: string) { super(message); }
}

beforeEach(() => {
  vi.clearAllMocks();
  assertAssigneeEligible.mockResolvedValue(undefined);
  assertCategoryInPartner.mockResolvedValue({ id: 'c', partnerId: 'p-1' });
  getTicketStatusById.mockImplementation(async (id: string) => ({ id, partnerId: 'p-1', coreStatus: 'pending', name: 'Waiting', isActive: true, isSystem: false }));
});

describe('evaluateRoutingRules — which rules', () => {
  it('reads ONE query on the given connection: enabled rules of THIS org, or partner-wide rules of the ticket org\'s PARTNER', async () => {
    const db = dbReturning([]);
    await evaluateRoutingRules(db as never, owner, facts(), NO_EXPLICIT_CHOICES);
    expect(db.execute).toHaveBeenCalledTimes(1);
    const text = sqlText(db.execute.mock.calls[0]![0]).replace(/\s+/g, ' ');
    expect(text).toContain('FROM ticket_routing_rules r');
    expect(text).toContain('r.enabled');
    // Playbook step 5: partner-wide rows by the ticket org's partner, never org_id alone.
    expect(text).toMatch(/r\.org_id = .* OR \( ?r\.org_id IS NULL AND r\.partner_id = /);
    // The org allowlist is read for THIS org only.
    expect(text).toMatch(/l\.rule_id = r\.id AND l\.org_id = /);
    const params = sqlParams(db.execute.mock.calls[0]![0]);
    expect(params).toContain('p-1');
    expect(params).toContain('o-1');
  });

  it('no rule → no outcome', async () => {
    const out = await evaluateRoutingRules(dbReturning([]) as never, owner, facts(), NO_EXPLICIT_CHOICES);
    expect(out).toEqual({ ruleId: null, ruleName: null, applied: {}, skipped: [], appliedStatusCore: null });
  });

  it('org rules before partner-wide rules, each by (position, id); first match wins (D7)', async () => {
    const wide = row({ position: -10, name: 'wide', set_priority: 'low' });
    const orgLate = row({ org_id: 'o-1', partner_id: null, position: 9, name: 'org-late', set_priority: 'urgent' });
    const orgEarly = row({ org_id: 'o-1', partner_id: null, position: 1, name: 'org-early', set_priority: 'high' });
    const out = await evaluateRoutingRules(dbReturning([wide, orgLate, orgEarly]) as never, owner, facts(), NO_EXPLICIT_CHOICES);
    expect(out.ruleName).toBe('org-early');
    expect(out.applied).toEqual({ priority: 'high' });
  });

  it('a non-matching rule is passed over for the next one', async () => {
    const vpn = row({ org_id: 'o-1', partner_id: null, match_subject_keywords: ['vpn'], name: 'vpn' });
    const printer = row({ match_subject_keywords: ['printer'], name: 'printer' });
    const out = await evaluateRoutingRules(dbReturning([vpn, printer]) as never, owner, facts(), NO_EXPLICIT_CHOICES);
    expect(out.ruleName).toBe('printer');
  });

  it('defence in depth: a row of another partner or another org is never applied, even if the read returned it (system scope bypasses RLS)', async () => {
    const foreignPartner = row({ partner_id: 'p-OTHER', name: 'foreign partner', position: -5 });
    const foreignOrg = row({ org_id: 'o-OTHER', partner_id: null, name: 'foreign org', position: -5 });
    const mine = row({ name: 'mine', position: 9 });
    const out = await evaluateRoutingRules(dbReturning([foreignPartner, foreignOrg, mine]) as never, owner, facts(), NO_EXPLICIT_CHOICES);
    expect(out.ruleName).toBe('mine');
    expect((await evaluateRoutingRules(dbReturning([foreignPartner, foreignOrg]) as never, owner, facts(), NO_EXPLICIT_CHOICES)).ruleId).toBeNull();
  });

  it('disabled rules are skipped even if the read returned one', async () => {
    const off = row({ enabled: false, name: 'off' });
    const on = row({ position: 5, name: 'on' });
    const out = await evaluateRoutingRules(dbReturning([off, on]) as never, owner, facts(), NO_EXPLICIT_CHOICES);
    expect(out.ruleName).toBe('on');
  });

  it('an org_scoped partner-wide rule applies only to a listed org; with no links it matches nothing (fail closed)', async () => {
    const notListed = row({ org_scoped: true, org_listed: false, name: 'not-mine', position: 0 });
    const listed = row({ org_scoped: true, org_listed: true, name: 'mine', position: 1 });
    expect((await evaluateRoutingRules(dbReturning([notListed, listed]) as never, owner, facts(), NO_EXPLICIT_CHOICES)).ruleName).toBe('mine');
    expect((await evaluateRoutingRules(dbReturning([notListed]) as never, owner, facts(), NO_EXPLICIT_CHOICES)).ruleId).toBeNull();
  });

  it('parses Postgres array literals defensively (text[] casts arrive as arrays, but a raw literal must still work)', async () => {
    const r = row({ match_sources: '{portal,email}', match_subject_keywords: ['printer'] });
    expect((await evaluateRoutingRules(dbReturning([r]) as never, owner, facts(), NO_EXPLICIT_CHOICES)).ruleId).toBe(r.id);
  });
});

describe('evaluateRoutingRules — actions', () => {
  const allActions = (over: Row = {}) => row({
    set_assignee_user_id: 'u-1', set_priority: 'urgent', set_category_id: 'c-1', set_status_id: 's-1', add_tags: ['vip', 'printer'], ...over,
  });

  it('applies every action the caller did not choose', async () => {
    const out = await evaluateRoutingRules(dbReturning([allActions()]) as never, owner, facts(), NO_EXPLICIT_CHOICES);
    expect(out.applied).toEqual({ assigneeId: 'u-1', priority: 'urgent', categoryId: 'c-1', statusId: 's-1', tags: ['vip', 'printer'] });
    expect(out.appliedStatusCore).toBe('pending');
    expect(out.skipped).toEqual([]);
    expect(assertAssigneeEligible).toHaveBeenCalledWith('u-1', 'p-1', 'o-1', undefined);
    expect(assertCategoryInPartner).toHaveBeenCalledWith('c-1', 'p-1');
  });

  it('explicit choices are never overwritten (and their references are not re-checked)', async () => {
    const explicit: ExplicitChoices = { priority: true, categoryId: true, assigneeId: true, statusId: true };
    const out = await evaluateRoutingRules(dbReturning([allActions()]) as never, owner, facts(), explicit);
    expect(out.applied).toEqual({ tags: ['vip', 'printer'] });
    expect(out.ruleId).not.toBeNull();
    expect(assertAssigneeEligible).not.toHaveBeenCalled();
    expect(assertCategoryInPartner).not.toHaveBeenCalled();
    expect(getTicketStatusById).not.toHaveBeenCalled();
  });

  it('an ineligible assignee is skipped with a reason while the other actions still apply', async () => {
    assertAssigneeEligible.mockRejectedValueOnce(new FakeTicketServiceError('no', 400, 'ASSIGNEE_NOT_ELIGIBLE'));
    const out = await evaluateRoutingRules(dbReturning([allActions()]) as never, { ...owner, deviceId: 'd-1' }, facts(), NO_EXPLICIT_CHOICES);
    expect(out.applied).toEqual({ priority: 'urgent', categoryId: 'c-1', statusId: 's-1', tags: ['vip', 'printer'] });
    expect(out.skipped).toEqual([{ action: 'set_assignee', reason: 'assignee_ineligible' }]);
    expect(assertAssigneeEligible).toHaveBeenCalledWith('u-1', 'p-1', 'o-1', 'd-1');
  });

  it('Review Focus #4: an assignee that is gone is a no-op skip (assignee_deleted), never a broader rule', async () => {
    assertAssigneeEligible.mockRejectedValueOnce(new FakeTicketServiceError('gone', 404, 'ASSIGNEE_NOT_FOUND'));
    const out = await evaluateRoutingRules(dbReturning([allActions()]) as never, owner, facts(), NO_EXPLICIT_CHOICES);
    expect(out.skipped).toEqual([{ action: 'set_assignee', reason: 'assignee_deleted' }]);
    expect(out.applied.assigneeId).toBeUndefined();
  });

  it('a foreign or missing category is skipped (category_foreign)', async () => {
    assertCategoryInPartner.mockRejectedValueOnce(new FakeTicketServiceError('x', 400, 'CATEGORY_WRONG_PARTNER'));
    const out = await evaluateRoutingRules(dbReturning([allActions()]) as never, owner, facts(), NO_EXPLICIT_CHOICES);
    expect(out.skipped).toEqual([{ action: 'set_category', reason: 'category_foreign' }]);
    assertCategoryInPartner.mockRejectedValueOnce(new FakeTicketServiceError('x', 404, 'CATEGORY_NOT_FOUND'));
    const out2 = await evaluateRoutingRules(dbReturning([allActions()]) as never, owner, facts(), NO_EXPLICIT_CHOICES);
    expect(out2.skipped).toEqual([{ action: 'set_category', reason: 'category_foreign' }]);
  });

  it('a status of another partner, an inactive status, or a core outside new/open/pending/on_hold is skipped', async () => {
    getTicketStatusById.mockResolvedValueOnce({ id: 's-1', partnerId: 'p-OTHER', coreStatus: 'open', name: 'x', isActive: true, isSystem: false });
    expect((await evaluateRoutingRules(dbReturning([allActions()]) as never, owner, facts(), NO_EXPLICIT_CHOICES)).skipped)
      .toEqual([{ action: 'set_status', reason: 'status_foreign' }]);
    getTicketStatusById.mockResolvedValueOnce(null);
    expect((await evaluateRoutingRules(dbReturning([allActions()]) as never, owner, facts(), NO_EXPLICIT_CHOICES)).skipped)
      .toEqual([{ action: 'set_status', reason: 'status_foreign' }]);
    getTicketStatusById.mockResolvedValueOnce({ id: 's-1', partnerId: 'p-1', coreStatus: 'resolved', name: 'x', isActive: true, isSystem: false });
    const out = await evaluateRoutingRules(dbReturning([allActions()]) as never, owner, facts(), NO_EXPLICIT_CHOICES);
    expect(out.skipped).toEqual([{ action: 'set_status', reason: 'status_core_not_allowed' }]);
    expect(out.applied.statusId).toBeUndefined();
    expect(out.appliedStatusCore).toBeNull();
    getTicketStatusById.mockResolvedValueOnce({ id: 's-1', partnerId: 'p-1', coreStatus: 'open', name: 'x', isActive: false, isSystem: false });
    expect((await evaluateRoutingRules(dbReturning([allActions()]) as never, owner, facts(), NO_EXPLICIT_CHOICES)).skipped)
      .toEqual([{ action: 'set_status', reason: 'status_inactive' }]);
  });

  it('an unexpected error during re-validation propagates (no silent skip)', async () => {
    assertAssigneeEligible.mockRejectedValueOnce(new Error('connection reset'));
    await expect(evaluateRoutingRules(dbReturning([allActions()]) as never, owner, facts(), NO_EXPLICIT_CHOICES)).rejects.toThrow('connection reset');
  });

  it('a matched rule with no action left (its only assignee was deleted, Gate B13) still records the match', async () => {
    const out = await evaluateRoutingRules(dbReturning([row({ set_priority: null })]) as never, owner, facts(), NO_EXPLICIT_CHOICES);
    expect(out.ruleId).not.toBeNull();
    expect(out.applied).toEqual({});
  });

  it('tags are trimmed and deduped (case kept, as ticket tags are)', async () => {
    const out = await evaluateRoutingRules(dbReturning([row({ set_priority: null, add_tags: ['vip', 'vip', ' printer ', ''] })]) as never, owner, facts(), NO_EXPLICIT_CHOICES);
    expect(out.applied).toEqual({ tags: ['vip', 'printer'] });
  });
});
