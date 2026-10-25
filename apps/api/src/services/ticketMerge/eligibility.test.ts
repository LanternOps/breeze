/**
 * #8972 W1 Task 1.3 (spec §3.1, D3): one case per MergeRefusalCode.
 * The rules are pure (`evaluateMergeEligibility`); `checkMergeEligibility`
 * wires the caller's site/device rule into MERGE_SCOPE_DENIED.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  checkMergeEligibility,
  evaluateMergeEligibility,
  assertMergeEligible,
  type MergeEligibilityFacts,
  type MergeTicketRow,
} from './eligibility';
import { MergeRefusedError } from './errors';

vi.mock('../../db', () => ({ db: {} }));

const base = (over: Partial<MergeTicketRow> = {}): MergeTicketRow => ({
  id: 'src', orgId: 'org-1', partnerId: 'p-1', status: 'open', statusId: null, deletedAt: null,
  mergedIntoTicketId: null, workKind: 'support', migrationWindowId: null, budgetMinutes: null,
  budgetAmount: null, deviceId: null, createdAt: new Date('2026-01-01T00:00:00Z'), requesterContactId: null,
  submittedBy: null, submitterEmail: null, internalNumber: 'T-2026-0001', ticketNumber: 'TKT-1', ...over,
});
const SRC = base();
const DST = base({ id: 'dst', internalNumber: 'T-2026-0002', ticketNumber: 'TKT-2' });
const facts = (over: Partial<MergeEligibilityFacts> = {}): MergeEligibilityFacts => ({
  orgStatus: 'active', ticketsWithApprovalRequests: new Set(), pinnedTicketIds: new Set(),
  openOrHiddenWindowIds: new Set(), pendingSourceIntents: 0, ...over,
});
const ok = { sourceAccessible: true, survivorAccessible: true };
const codes = (r: ReturnType<typeof evaluateMergeEligibility>) => r.map((x) => `${x.code}:${x.side}`);

describe('evaluateMergeEligibility (#8972 W1, spec §3.1)', () => {
  it('an ordinary same-org pair is eligible', () => {
    expect(evaluateMergeEligibility(SRC, DST, facts(), ok)).toEqual([]);
  });

  it('MERGE_SAME_TICKET', () => {
    expect(codes(evaluateMergeEligibility(SRC, SRC, facts(), ok))).toEqual(['MERGE_SAME_TICKET:both']);
  });

  it('MERGE_CROSS_ORG', () => {
    expect(codes(evaluateMergeEligibility(SRC, { ...DST, orgId: 'org-2' }, facts(), ok))).toEqual(['MERGE_CROSS_ORG:both']);
  });

  it('MERGE_SOURCE_INELIGIBLE: deleted or already merged; resolved/closed sources are fine', () => {
    expect(codes(evaluateMergeEligibility({ ...SRC, deletedAt: new Date() }, DST, facts(), ok))).toEqual(['MERGE_SOURCE_INELIGIBLE:source']);
    expect(codes(evaluateMergeEligibility({ ...SRC, mergedIntoTicketId: 'x' }, DST, facts(), ok))).toEqual(['MERGE_SOURCE_INELIGIBLE:source']);
    expect(evaluateMergeEligibility({ ...SRC, status: 'closed' }, DST, facts(), ok)).toEqual([]);
    expect(evaluateMergeEligibility({ ...SRC, status: 'resolved' }, DST, facts(), ok)).toEqual([]);
  });

  it('MERGE_SURVIVOR_INELIGIBLE: closed, deleted or merged survivor', () => {
    for (const over of [{ status: 'closed' as const }, { deletedAt: new Date() }, { mergedIntoTicketId: 'x' }]) {
      expect(codes(evaluateMergeEligibility(SRC, { ...DST, ...over }, facts(), ok))).toEqual(['MERGE_SURVIVOR_INELIGIBLE:survivor']);
    }
    expect(evaluateMergeEligibility(SRC, { ...DST, status: 'resolved' }, facts(), ok)).toEqual([]);
  });

  it('MERGE_DELIVERABLE_PINNED on either side', () => {
    expect(codes(evaluateMergeEligibility(SRC, DST, facts({ pinnedTicketIds: new Set(['src']) }), ok))).toEqual(['MERGE_DELIVERABLE_PINNED:source']);
    expect(codes(evaluateMergeEligibility(SRC, DST, facts({ pinnedTicketIds: new Set(['dst']) }), ok))).toEqual(['MERGE_DELIVERABLE_PINNED:survivor']);
  });

  it('MERGE_IMPORT_WINDOW: an open (or invisible) window on either side; a closed one passes', () => {
    const s = { ...SRC, migrationWindowId: 'w1' };
    const d = { ...DST, migrationWindowId: 'w2' };
    expect(codes(evaluateMergeEligibility(s, d, facts({ openOrHiddenWindowIds: new Set(['w1', 'w2']) }), ok))).toEqual(['MERGE_IMPORT_WINDOW:both']);
    expect(codes(evaluateMergeEligibility(s, d, facts({ openOrHiddenWindowIds: new Set(['w2']) }), ok))).toEqual(['MERGE_IMPORT_WINDOW:survivor']);
    expect(evaluateMergeEligibility(s, d, facts(), ok)).toEqual([]);
  });

  describe('MERGE_APPROVAL_STATE (D3: both sides, approvals and each budget column)', () => {
    it.each([
      ['an approval request on the source', SRC, DST, facts({ ticketsWithApprovalRequests: new Set(['src']) }), 'source'],
      ['an approval request on the survivor', SRC, DST, facts({ ticketsWithApprovalRequests: new Set(['dst']) }), 'survivor'],
      ['budget_minutes on the source', { ...SRC, budgetMinutes: 60 }, DST, facts(), 'source'],
      ['budget_minutes on the survivor', SRC, { ...DST, budgetMinutes: 60 }, facts(), 'survivor'],
      ['budget_amount on the source', { ...SRC, budgetAmount: '100.00' }, DST, facts(), 'source'],
      ['budget_amount on the survivor', SRC, { ...DST, budgetAmount: '100.00' }, facts(), 'survivor'],
      ['both sides', { ...SRC, budgetMinutes: 5 }, DST, facts({ ticketsWithApprovalRequests: new Set(['dst']) }), 'both'],
    ] as const)('refuses %s', (_label, s, d, f, side) => {
      expect(codes(evaluateMergeEligibility(s, d, f, ok))).toEqual([`MERGE_APPROVAL_STATE:${side}`]);
    });
  });

  it('MERGE_WORK_KIND_MISMATCH', () => {
    expect(codes(evaluateMergeEligibility(SRC, { ...DST, workKind: 'planned' as MergeTicketRow['workKind'] }, facts(), ok)))
      .toEqual(['MERGE_WORK_KIND_MISMATCH:both']);
  });

  it('MERGE_PENDING_INTENTS (source only)', () => {
    expect(codes(evaluateMergeEligibility(SRC, DST, facts({ pendingSourceIntents: 2 }), ok))).toEqual(['MERGE_PENDING_INTENTS:source']);
  });

  it('ORG_MERGING', () => {
    expect(codes(evaluateMergeEligibility(SRC, DST, facts({ orgStatus: 'merging' }), ok))).toEqual(['ORG_MERGING:both']);
  });

  it('MERGE_SCOPE_DENIED for each side the caller cannot reach', () => {
    expect(codes(evaluateMergeEligibility(SRC, DST, facts(), { sourceAccessible: true, survivorAccessible: false }))).toEqual(['MERGE_SCOPE_DENIED:survivor']);
    expect(codes(evaluateMergeEligibility(SRC, DST, facts(), { sourceAccessible: false, survivorAccessible: false }))).toEqual(['MERGE_SCOPE_DENIED:both']);
  });

  it('returns every refusal at once (the preview lists them all)', () => {
    const r = evaluateMergeEligibility({ ...SRC, budgetMinutes: 1 }, { ...DST, status: 'closed' }, facts({ pendingSourceIntents: 1 }), ok);
    expect(r.map((x) => x.code).sort()).toEqual(['MERGE_APPROVAL_STATE', 'MERGE_PENDING_INTENTS', 'MERGE_SURVIVOR_INELIGIBLE']);
  });
});

describe('checkMergeEligibility / assertMergeEligible', () => {
  /** A select chain that answers each query in call order. */
  function fakeDb(answers: unknown[][]) {
    const next = () => Promise.resolve(answers.shift() ?? []);
    const chain = () => {
      const q: Record<string, unknown> = {};
      q.from = () => q;
      // Lazy: the answer is taken when the query is awaited (directly or via .limit()).
      q.where = () => ({
        limit: () => next(),
        then: (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) => next().then(res, rej),
      });
      return q;
    };
    return { select: chain, selectDistinct: chain } as never;
  }

  it('feeds the caller\'s site/device rule into MERGE_SCOPE_DENIED for BOTH tickets', async () => {
    const db = fakeDb([[{ status: 'active' }], [], [], [{ n: 0 }]]);
    const canAccessTicket = vi.fn(async (t: MergeTicketRow) => t.id === 'src');
    const r = await checkMergeEligibility(db, SRC, DST, { canAccessTicket });
    expect(canAccessTicket).toHaveBeenCalledTimes(2);
    expect(r.map((x) => `${x.code}:${x.side}`)).toEqual(['MERGE_SCOPE_DENIED:survivor']);
  });

  it('reads approval requests and pending intents into the rules', async () => {
    const db = fakeDb([[{ status: 'active' }], [{ ticketId: 'dst' }], [], [{ n: 1 }]]);
    const r = await checkMergeEligibility(db, SRC, DST);
    expect(r.map((x) => `${x.code}:${x.side}`)).toEqual(['MERGE_APPROVAL_STATE:survivor', 'MERGE_PENDING_INTENTS:source']);
  });

  it('assertMergeEligible throws a typed 409 MergeRefusedError with the first refusal', async () => {
    const db = fakeDb([[{ status: 'merging' }], [], [], [{ n: 0 }]]);
    const err = await assertMergeEligible(db, SRC, DST).then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(MergeRefusedError);
    expect(err).toMatchObject({ code: 'ORG_MERGING', side: 'both', status: 409 });
  });
});
