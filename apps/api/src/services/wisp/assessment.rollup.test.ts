import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Concern, ConcernSeverity } from '@breeze/shared';

/**
 * services/wisp/assessment.ts — the deterministic partner picture (W05 Task 7):
 * `renderPartnerPicture` (pure) and `rollupPartnerPicture` (ceiling → live
 * concerns → org names → updateThreadSummary). No model anywhere.
 */
const h = vi.hoisted(() => {
  const results: unknown[][] = [];
  const whereArgs: unknown[] = [];
  const chain = (): Record<string, unknown> => {
    const p: Record<string, unknown> = {};
    for (const m of ['innerJoin', 'leftJoin', 'limit', 'orderBy', 'groupBy', 'from']) p[m] = vi.fn(() => p);
    p.where = vi.fn((cond: unknown) => { whereArgs.push(cond); return p; });
    p.then = (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) =>
      Promise.resolve(results.shift() ?? []).then(res, rej);
    return p;
  };
  class GrantInactiveError extends Error {
    readonly code = 'grant_inactive' as const;
    constructor(public readonly grantId: string, public readonly status: string) { super('inactive'); }
  }
  return {
    results,
    whereArgs,
    db: { select: vi.fn(() => chain()) },
    GrantInactiveError,
    resolveGrantCeiling: vi.fn(),
    listConcernsForCeiling: vi.fn(),
    getOrCreateThread: vi.fn(),
    updateThreadSummary: vi.fn(),
  };
});

vi.mock('../../db', () => ({
  db: h.db,
  runOutsideDbContext: vi.fn((fn: () => unknown) => fn()),
  getCurrentDbAccessContext: vi.fn(() => undefined),
  withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
}));
vi.mock('../../config/env', () => ({ wispEnabled: vi.fn(() => true) }));
vi.mock('../entitlements', () => ({ hasEntitlement: vi.fn() }));
vi.mock('./grantAuthority', () => ({ resolveGrantCeiling: h.resolveGrantCeiling, GrantInactiveError: h.GrantInactiveError }));
vi.mock('./concerns', () => ({ listConcernsForCeiling: h.listConcernsForCeiling, upsertConcern: vi.fn() }));
vi.mock('./threads', () => ({
  getOrCreateThread: h.getOrCreateThread,
  updateThreadSummary: h.updateThreadSummary,
  seedContextForSession: vi.fn(),
}));
vi.mock('./budget', () => ({ chargeableUnderGrant: vi.fn(), notifyBudgetExhaustedOnce: vi.fn(), utcDayWindow: vi.fn() }));
vi.mock('./deliver', () => ({ deliverInApp: vi.fn() }));
vi.mock('./watches', () => ({ listWatches: vi.fn() }));
vi.mock('./readiness', () => ({ readinessInventory: vi.fn() }));
vi.mock('./memoryBroker', () => ({ recallForGrant: vi.fn() }));
vi.mock('./grants', () => ({ pauseGrant: vi.fn() }));
vi.mock('../aiAgents/runService', () => ({ createAndEnqueueAgentRun: vi.fn() }));
vi.mock('../aiAgents/assessmentProfile', () => ({ ASSESSMENT_BUDGET_CENTS_PER_RUN: 25 }));

import { PARTNER_WIDE_PICTURE_ORG_ID, renderPartnerPicture, rollupPartnerPicture } from './assessment';

const PARTNER = '11111111-1111-4111-8111-111111111111';
const GRANT = '44444444-4444-4444-8444-444444444444';
const REV = '66666666-6666-4666-8666-666666666666';
const THREAD = '55555555-5555-4555-8555-555555555555';
const ORG_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const ORG_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const ORG_C = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const AT = new Date('2026-10-24T12:34:56.789Z');

let seq = 0;
function concern(orgId: string | null, severity: ConcernSeverity, summary: string, o: Partial<Concern> = {}): Concern {
  seq += 1;
  const id = `00000000-0000-4000-8000-${String(seq).padStart(12, '0')}`;
  return {
    id,
    partnerId: PARTNER,
    orgId,
    subject: { kind: 'ticket', id },
    summary,
    severity,
    status: 'open',
    evidence: {},
    outcome: null,
    signature: null,
    childConcernIds: [],
    approvalIntentId: null,
    createdAt: '2026-10-24T10:00:00.000Z',
    updatedAt: '2026-10-24T10:00:00.000Z',
    resolvedAt: null,
    ...o,
  };
}

function shuffle<T>(xs: T[], seed: number): T[] {
  const out = [...xs];
  let s = seed;
  for (let i = out.length - 1; i > 0; i -= 1) {
    s = (s * 1103515245 + 12345) % 2147483648;
    const j = s % (i + 1);
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

function ceiling(o: Record<string, unknown> = {}) {
  return {
    grantId: GRANT, revisionId: REV, partnerId: PARTNER, grantorUserId: 'u', scopeOrgId: null, partnerWide: true,
    orgIds: new Set([ORG_A, ORG_B, ORG_C]), siteIds: null, permissionKeys: new Set(['*:*']), toolAllowlist: null,
    deniedTools: new Set(), orgTerms: new Map(), status: 'active', ...o,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  h.results.length = 0;
  h.whereArgs.length = 0;
  seq = 0;
});

describe('renderPartnerPicture', () => {
  it('is byte-identical for the same input regardless of input order', () => {
    const orgs = [
      { orgId: ORG_A, orgName: 'Acme', concerns: [concern(ORG_A, 'low', 'disk 80%'), concern(ORG_A, 'high', 'backup failed'), concern(ORG_A, 'medium', 'patches behind')] },
      { orgId: ORG_B, orgName: 'Beta', concerns: [concern(ORG_B, 'medium', 'ticket waiting'), concern(ORG_B, 'medium', 'another ticket', { updatedAt: '2026-10-24T11:00:00.000Z' })] },
      { orgId: ORG_C, orgName: 'Gamma', concerns: [] },
    ];
    const baseline = renderPartnerPicture({ generatedAt: AT, orgs });
    for (let seed = 1; seed <= 10; seed += 1) {
      const shuffled = shuffle(orgs, seed).map((o) => ({ ...o, concerns: shuffle(o.concerns, seed + 7) }));
      expect(renderPartnerPicture({ generatedAt: AT, orgs: shuffled })).toBe(baseline);
    }
  });

  it('sorts orgs by max severity, then open count, then name', () => {
    const text = renderPartnerPicture({
      generatedAt: AT,
      orgs: [
        { orgId: ORG_A, orgName: 'Zulu', concerns: [concern(ORG_A, 'medium', 'm1'), concern(ORG_A, 'medium', 'm2')] },
        { orgId: ORG_B, orgName: 'Alpha', concerns: [concern(ORG_B, 'medium', 'm3')] },
        { orgId: ORG_C, orgName: 'Yankee', concerns: [concern(ORG_C, 'low', 'l1'), concern(ORG_C, 'high', 'h1')] },
        { orgId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd', orgName: 'Bravo', concerns: [concern(null, 'medium', 'm4')] },
      ],
    });
    const lines = text.split('\n').slice(1);
    expect(lines.map((l) => l.split(':')[0])).toEqual(['Yankee', 'Zulu', 'Alpha', 'Bravo']);
    expect(lines[0]).toBe('Yankee: 2 open — h1; l1');
  });

  it('renders the exact header and line format, up to 3 summaries each ≤ 80 chars, highest severity first', () => {
    const long = 'x'.repeat(200);
    const text = renderPartnerPicture({
      generatedAt: AT,
      orgs: [
        { orgId: ORG_A, orgName: 'Acme', concerns: [
          concern(ORG_A, 'low', 'l1'), concern(ORG_A, 'high', long), concern(ORG_A, 'medium', 'm1'), concern(ORG_A, 'info', 'i1'),
        ] },
        { orgId: ORG_B, orgName: 'Beta', concerns: [] },
      ],
    });
    const [header, line] = text.split('\n');
    expect(header).toBe('Wisp picture · 1/2 orgs · 1 high / 1 medium / 1 low · as of 2026-10-24T12:34Z');
    expect(line!.startsWith('Acme: 4 open — ')).toBe(true);
    const summaries = line!.slice('Acme: 4 open — '.length).split('; ');
    expect(summaries).toHaveLength(3);
    expect(summaries[0]!.length).toBeLessThanOrEqual(80);
    expect(summaries[0]!.startsWith('xxx')).toBe(true);
    expect(summaries.slice(1)).toEqual(['m1', 'l1']);
  });

  it('omits orgs with zero concerns and caps at 4000 chars on a line boundary', () => {
    const orgs = Array.from({ length: 120 }, (_, i) => {
      const orgId = `00000000-0000-4000-9000-${String(i).padStart(12, '0')}`;
      return {
        orgId,
        orgName: `Org ${String(i).padStart(3, '0')}`,
        concerns: i % 2 === 0 ? [concern(orgId, 'medium', 'y'.repeat(70)), concern(orgId, 'low', 'z'.repeat(70))] : [],
      };
    });
    const text = renderPartnerPicture({ generatedAt: AT, orgs });
    expect(text.length).toBeLessThanOrEqual(4000);
    const lines = text.split('\n');
    expect(lines[lines.length - 1]).toBe('…');
    // Every kept line is whole (no line cut mid-way) and no zero-concern org appears.
    for (const l of lines.slice(1, -1)) expect(l).toMatch(/^Org \d{3}: 2 open — y{70}; z{70}$/);
    expect(text).not.toContain('Org 001');
    expect(lines[0]).toBe('Wisp picture · 60/120 orgs · 0 high / 60 medium / 60 low · as of 2026-10-24T12:34Z');
  });

  it('header counts match the body', () => {
    const orgs = [
      { orgId: ORG_A, orgName: 'Acme', concerns: [concern(ORG_A, 'high', 'a'), concern(ORG_A, 'high', 'b'), concern(ORG_A, 'low', 'c')] },
      { orgId: ORG_B, orgName: 'Beta', concerns: [concern(ORG_B, 'medium', 'd')] },
      { orgId: ORG_C, orgName: 'Gamma', concerns: [] },
    ];
    const text = renderPartnerPicture({ generatedAt: AT, orgs });
    const [header, ...body] = text.split('\n');
    const m = /^Wisp picture · (\d+)\/(\d+) orgs · (\d+) high \/ (\d+) medium \/ (\d+) low · as of /.exec(header!);
    expect(m).not.toBeNull();
    const [, withOpen, inCeiling, hi, med, lo] = m!.map(Number);
    expect(withOpen).toBe(body.length);
    expect(inCeiling).toBe(3);
    const bodyTotal = body.reduce((n, l) => n + Number(/: (\d+) open/.exec(l)![1]), 0);
    expect(hi! + med! + lo!).toBe(bodyTotal);
    expect([hi, med, lo]).toEqual([2, 1, 1]);
  });

  it('neutralises control characters in org names and summaries (one line per org)', () => {
    const text = renderPartnerPicture({
      generatedAt: AT,
      orgs: [{ orgId: ORG_A, orgName: 'Evil\nWisp picture · fake', concerns: [concern(ORG_A, 'high', 'line1\nline2')] }],
    });
    expect(text.split('\n')).toHaveLength(2);
  });

  it('keeps the partner-wide pseudo-org out of the org counts', () => {
    const text = renderPartnerPicture({
      generatedAt: AT,
      orgs: [
        { orgId: PARTNER_WIDE_PICTURE_ORG_ID, orgName: 'Partner-wide', concerns: [concern(null, 'high', 'incident across customers')] },
        { orgId: ORG_A, orgName: 'Acme', concerns: [] },
      ],
    });
    const [header, line] = text.split('\n');
    expect(header).toBe('Wisp picture · 0/1 orgs · 1 high / 0 medium / 0 low · as of 2026-10-24T12:34Z');
    expect(line).toBe('Partner-wide: 1 open — incident across customers');
  });
});

describe('rollupPartnerPicture', () => {
  it('loads live concerns under the ceiling, org names in one query, and writes the thread summary', async () => {
    h.resolveGrantCeiling.mockResolvedValue(ceiling());
    h.getOrCreateThread.mockResolvedValue({ id: THREAD, grantId: GRANT, currentRevisionId: REV });
    h.results.push([{ id: GRANT, partnerId: PARTNER, currentRevisionId: REV }]); // grant row
    h.results.push([{ id: ORG_A, name: 'Acme' }, { id: ORG_B, name: 'Beta' }, { id: ORG_C, name: 'Gamma' }]); // org names
    h.listConcernsForCeiling.mockResolvedValue([
      concern(ORG_A, 'high', 'backup failed'),
      concern(ORG_B, 'low', 'disk'),
      concern(null, 'high', 'possible incident'),
    ]);

    const text = await rollupPartnerPicture(GRANT);

    expect(h.resolveGrantCeiling).toHaveBeenCalledWith(GRANT, REV);
    expect(h.listConcernsForCeiling).toHaveBeenCalledTimes(1);
    expect(h.listConcernsForCeiling.mock.calls[0]![1]).toEqual({ status: ['open', 'snoozed'] });
    expect(h.db.select).toHaveBeenCalledTimes(2); // grant + org names, one query
    expect(h.updateThreadSummary).toHaveBeenCalledWith(THREAD, text);
    const lines = text.split('\n');
    expect(lines[0]).toMatch(/^Wisp picture · 2\/3 orgs · 2 high \/ 0 medium \/ 1 low · as of /);
    expect(lines.slice(1)).toEqual([
      'Acme: 1 open — backup failed',
      'Partner-wide: 1 open — possible incident',
      'Beta: 1 open — disk',
    ]);
  });

  it('drops partner-level concerns when the ceiling is not partner-wide', async () => {
    h.resolveGrantCeiling.mockResolvedValue(ceiling({ partnerWide: false, scopeOrgId: ORG_A, orgIds: new Set([ORG_A]) }));
    h.getOrCreateThread.mockResolvedValue({ id: THREAD });
    h.results.push([{ id: GRANT, partnerId: PARTNER, currentRevisionId: REV }]);
    h.results.push([{ id: ORG_A, name: 'Acme' }]);
    h.listConcernsForCeiling.mockResolvedValue([concern(ORG_A, 'medium', 'm'), concern(null, 'high', 'should not show')]);

    const text = await rollupPartnerPicture(GRANT);
    expect(text).not.toContain('Partner-wide');
    expect(text).not.toContain('should not show');
    expect(text.split('\n')[0]).toMatch(/^Wisp picture · 1\/1 orgs · 0 high \/ 1 medium \/ 0 low/);
  });

  it('propagates GrantInactiveError and writes nothing', async () => {
    h.results.push([{ id: GRANT, partnerId: PARTNER, currentRevisionId: REV }]);
    h.resolveGrantCeiling.mockRejectedValue(new h.GrantInactiveError(GRANT, 'paused'));
    await expect(rollupPartnerPicture(GRANT)).rejects.toBeInstanceOf(h.GrantInactiveError);
    expect(h.updateThreadSummary).not.toHaveBeenCalled();
  });
});
