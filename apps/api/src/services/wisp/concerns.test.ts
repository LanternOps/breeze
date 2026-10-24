/**
 * Wisp W05a Task 3 — the concern service. Drizzle is mocked with queue-fed
 * chains (selects / inserts / updates / executes resolve from FIFO queues);
 * the memory broker, Sentry and `resolveGrantCeiling` are mocked;
 * `GrantInactiveError` / `CeilingViolationError` are the real W02 classes,
 * with only `inSystemContext` replaced by a pass-through recorder.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';

const h = vi.hoisted(() => ({
  calls: [] as string[],
  selectRows: [] as unknown[][],
  insertReturning: [] as Array<unknown[] | Error>,
  updateReturning: [] as unknown[][],
  executeRows: [] as unknown[][],
  inserts: [] as Array<{ values: Record<string, unknown>; conflict: 'nothing' | 'update'; opts: Record<string, unknown> }>,
  updates: [] as Array<{ set: Record<string, unknown>; where: unknown }>,
  executes: [] as unknown[],
  rememberForGrant: vi.fn(),
  resolveGrantCeiling: vi.fn(),
  captureException: vi.fn(),
}));

vi.mock('../../db', () => {
  const select = vi.fn(() => {
    h.calls.push('select');
    const chain: Record<string, unknown> = {};
    for (const m of ['from', 'leftJoin', 'innerJoin', 'where', 'orderBy', 'limit']) chain[m] = () => chain;
    chain.then = (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) =>
      Promise.resolve(h.selectRows.shift() ?? []).then(res, rej);
    return chain;
  });
  const insert = vi.fn(() => ({
    values: (values: Record<string, unknown>) => {
      const run = (conflict: 'nothing' | 'update', opts: Record<string, unknown>) => {
        h.calls.push(`insert:${conflict}`);
        h.inserts.push({ values, conflict, opts });
        const next = async () => {
          const r = h.insertReturning.shift() ?? [];
          if (r instanceof Error) throw r;
          return r;
        };
        return {
          returning: next,
          then: (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) => next().then(res, rej),
        };
      };
      return {
        onConflictDoNothing: (opts: Record<string, unknown> = {}) => run('nothing', opts),
        onConflictDoUpdate: (opts: Record<string, unknown> = {}) => run('update', opts),
      };
    },
  }));
  const update = vi.fn(() => ({
    set: (set: Record<string, unknown>) => ({
      where: (where: unknown) => {
        h.calls.push('update');
        h.updates.push({ set, where });
        return Object.assign(Promise.resolve(undefined), { returning: async () => h.updateReturning.shift() ?? [] });
      },
    }),
  }));
  const execute = vi.fn(async (q: unknown) => { h.calls.push('execute'); h.executes.push(q); return h.executeRows.shift() ?? []; });
  return {
    db: { select, insert, update, execute },
    withDbTransaction: vi.fn((fn: () => Promise<unknown>) => fn()),
    getCurrentDbAccessContext: vi.fn(() => undefined),
    runOutsideDbContext: vi.fn((fn: () => unknown) => fn()),
    withSystemDbAccessContext: vi.fn((fn: () => unknown) => fn()),
  };
});

vi.mock('./grantAuthority', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./grantAuthority')>();
  return {
    ...actual,
    inSystemContext: vi.fn((fn: () => Promise<unknown>) => { h.calls.push('system'); return fn(); }),
    resolveGrantCeiling: h.resolveGrantCeiling,
  };
});
vi.mock('./memoryBroker', () => ({ rememberForGrant: h.rememberForGrant }));
vi.mock('../sentry', () => ({ captureException: h.captureException }));

import { CeilingViolationError, GrantInactiveError, type GrantCeiling } from './grantAuthority';
import {
  ConcernNotFoundError,
  isDigestOnly,
  listConcernsForCeiling,
  nextBackoff,
  recordNudge,
  resolveConcern,
  upsertConcern,
} from './concerns';

const P1 = '11111111-1111-4111-8111-111111111111';
const O1 = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const O2 = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const C1 = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
const G1 = '99999999-9999-4999-8999-999999999999';
const R1 = '88888888-8888-4888-8888-888888888888';
const S1 = '77777777-7777-4777-8777-777777777777';

const ceiling = (over: Partial<GrantCeiling> = {}): GrantCeiling => ({
  grantId: G1, revisionId: R1, partnerId: P1, grantorUserId: 'u', scopeOrgId: null, partnerWide: false,
  orgIds: new Set([O1]), siteIds: null, permissionKeys: new Set(), toolAllowlist: null,
  deniedTools: new Set(), orgTerms: new Map(), status: 'active', ...over,
});

const baseInput = {
  partnerId: P1, orgId: O1, subject: { kind: 'ticket' as const, id: S1 },
  summary: '  Ticket waiting 3 days  ', severity: 'medium' as const, evidence: { waitingDays: 3 },
};

const resolvedRow = { id: C1, orgId: O1, subjectKind: 'ticket', subjectId: S1, summary: 'waiting', severity: 'medium' };

beforeEach(() => {
  h.calls.length = 0;
  h.selectRows.length = 0;
  h.insertReturning.length = 0;
  h.updateReturning.length = 0;
  h.executeRows.length = 0;
  h.inserts.length = 0;
  h.updates.length = 0;
  h.executes.length = 0;
  h.rememberForGrant.mockReset().mockResolvedValue({ id: 'block' });
  h.resolveGrantCeiling.mockReset().mockResolvedValue(ceiling());
  h.captureException.mockReset();
});

describe('nextBackoff', () => {
  it.each([[0, 30], [1, 60], [2, 120], [3, 1440], [9, 1440]])('nudgeCount %i → %i minutes', (n, minutes) => {
    expect(nextBackoff(n)).toBe(minutes);
  });
});

describe('isDigestOnly', () => {
  const t0 = new Date('2026-10-24T10:00:00Z');
  const t1 = new Date('2026-10-24T11:00:00Z');
  it('false after one unanswered nudge, true after two', () => {
    expect(isDigestOnly({ nudgeCount: 1, answeredAt: null, lastNudgedAt: t0 })).toBe(false);
    expect(isDigestOnly({ nudgeCount: 2, answeredAt: null, lastNudgedAt: t1 })).toBe(true);
  });
  it('false when answered after the last nudge', () => {
    expect(isDigestOnly({ nudgeCount: 2, answeredAt: t1, lastNudgedAt: t0 })).toBe(false);
    expect(isDigestOnly({ nudgeCount: 2, answeredAt: t0, lastNudgedAt: t1 })).toBe(true);
  });
});

describe('upsertConcern', () => {
  it('returns created:true on insert and created:false with the existing id when the live row exists', async () => {
    h.insertReturning.push([{ id: C1 }]);
    await expect(upsertConcern(baseInput)).resolves.toEqual({ id: C1, created: true });
    expect(h.inserts[0]!.values.summary).toBe('Ticket waiting 3 days');
    expect(h.inserts[0]!.conflict).toBe('nothing');

    h.insertReturning.push([]);
    h.selectRows.push([{ id: 'existing' }]);
    await expect(upsertConcern(baseInput)).resolves.toEqual({ id: 'existing', created: false });
  });

  it('never writes status (no update) on the created:false path', async () => {
    h.insertReturning.push([]);
    h.selectRows.push([{ id: 'existing' }]);
    await upsertConcern({ ...baseInput, signature: 'sig' });
    expect(h.calls).not.toContain('update');
    expect(h.updates).toEqual([]);
  });

  it('a unique violation on the other live index returns created:false instead of throwing', async () => {
    const err = Object.assign(new Error('duplicate key'), { code: '23505', constraint_name: 'wisp_concerns_live_subject_uq' });
    h.insertReturning.push(err);
    h.selectRows.push([]); // no live row by signature
    h.selectRows.push([{ id: 'by-subject' }]);
    await expect(upsertConcern({ ...baseInput, signature: 'readiness:x' })).resolves.toEqual({ id: 'by-subject', created: false });
    expect(h.updates).toEqual([]);
  });

  it('a non-unique error escapes', async () => {
    h.insertReturning.push(Object.assign(new Error('boom'), { code: '23503' }));
    await expect(upsertConcern(baseInput)).rejects.toThrow('boom');
  });
});

describe('resolveConcern', () => {
  it('calls rememberForGrant with blockType concern_outcome and the org owner when grantId is present', async () => {
    h.updateReturning.push([resolvedRow]);
    h.selectRows.push([{ currentRevisionId: R1 }]);
    await resolveConcern(C1, { grantId: G1, userId: 'u1' }, 'customer replied');
    expect(h.resolveGrantCeiling).toHaveBeenCalledWith(G1, R1);
    expect(h.rememberForGrant).toHaveBeenCalledTimes(1);
    const [, block] = h.rememberForGrant.mock.calls[0]!;
    expect(block).toMatchObject({
      owner: { kind: 'org', orgId: O1 },
      blockType: 'concern_outcome',
      subjectKey: `concern:ticket:${S1}`,
      content: { summary: 'waiting', outcome: 'customer replied', severity: 'medium', resolvedBy: 'wisp' },
      confidence: 'medium',
    });
    expect(h.updates[0]!.set).toMatchObject({ status: 'resolved', outcome: 'customer replied', resolvedByUserId: 'u1' });
  });

  it('uses the partner owner for a partner-level concern', async () => {
    h.updateReturning.push([{ ...resolvedRow, orgId: null, subjectKind: 'incident' }]);
    h.selectRows.push([{ currentRevisionId: R1 }]);
    await resolveConcern(C1, { grantId: G1 }, 'auto_closed');
    expect(h.rememberForGrant.mock.calls[0]![1]).toMatchObject({ owner: { kind: 'partner' } });
  });

  it('writes no memory block when only userId is given', async () => {
    h.updateReturning.push([resolvedRow]);
    await resolveConcern(C1, { userId: 'u1' }, 'fixed');
    expect(h.rememberForGrant).not.toHaveBeenCalled();
    expect(h.resolveGrantCeiling).not.toHaveBeenCalled();
  });

  it('is a no-op (no memory write) when the concern is not live', async () => {
    h.updateReturning.push([]);
    await resolveConcern(C1, { grantId: G1 }, 'fixed');
    expect(h.rememberForGrant).not.toHaveBeenCalled();
  });

  it('a GrantInactiveError from the ceiling does not throw out of resolveConcern', async () => {
    h.updateReturning.push([resolvedRow]);
    h.selectRows.push([{ currentRevisionId: R1 }]);
    h.resolveGrantCeiling.mockRejectedValueOnce(new GrantInactiveError(G1, 'paused'));
    await expect(resolveConcern(C1, { grantId: G1 }, 'fixed')).resolves.toEqual({ resolved: true, remembered: false });
    expect(h.rememberForGrant).not.toHaveBeenCalled();
    expect(h.captureException).not.toHaveBeenCalled();
  });

  it('a CeilingViolationError from the broker is skipped; any other error is captured, never thrown', async () => {
    h.updateReturning.push([resolvedRow]);
    h.selectRows.push([{ currentRevisionId: R1 }]);
    h.rememberForGrant.mockRejectedValueOnce(new CeilingViolationError('org', 'out'));
    await expect(resolveConcern(C1, { grantId: G1 }, 'fixed')).resolves.toEqual({ resolved: true, remembered: false });
    expect(h.captureException).not.toHaveBeenCalled();

    h.updateReturning.push([resolvedRow]);
    h.selectRows.push([{ currentRevisionId: R1 }]);
    h.rememberForGrant.mockRejectedValueOnce(new Error('db down'));
    await expect(resolveConcern(C1, { grantId: G1 }, 'fixed')).resolves.toEqual({ resolved: true, remembered: false });
    expect(h.captureException).toHaveBeenCalledTimes(1);
  });
});

describe('listConcernsForCeiling', () => {
  it('returns [] without querying for an orgId outside the ceiling', async () => {
    await expect(listConcernsForCeiling(ceiling(), { orgId: O2 })).resolves.toEqual([]);
    expect(h.calls).not.toContain('select');
  });

  it('returns [] without querying for an empty, non-partner-wide ceiling', async () => {
    await expect(listConcernsForCeiling(ceiling({ orgIds: new Set() }))).resolves.toEqual([]);
    expect(h.calls).not.toContain('select');
  });

  it('maps rows to the Concern DTO with recipient state and approvalIntentId', async () => {
    const at = new Date('2026-10-24T10:00:00Z');
    h.selectRows.push([
      {
        c: {
          id: C1, partnerId: P1, orgId: O1, subjectKind: 'ticket', subjectId: S1, summary: 's', severity: 'high',
          status: 'open', evidence: { approvalIntentId: 'intent-1' }, outcome: null, signature: null,
          childConcernIds: [], createdAt: at, updatedAt: at, resolvedAt: null,
        },
        r: {
          nudgeCount: 2, lastNudgedAt: at, nextEligibleNudgeAt: at, snoozedUntil: null, dismissedAt: null,
          answeredAt: null, feedback: null,
        },
      },
      {
        c: {
          id: 'c2', partnerId: P1, orgId: O1, subjectKind: 'device', subjectId: S1, summary: 's', severity: 'low',
          status: 'open', evidence: { approvalIntentId: 7 }, outcome: null, signature: null,
          childConcernIds: [], createdAt: at, updatedAt: at, resolvedAt: null,
        },
        r: null,
      },
    ]);
    const out = await listConcernsForCeiling(ceiling());
    expect(out[0]).toMatchObject({
      id: C1, subject: { kind: 'ticket', id: S1 }, approvalIntentId: 'intent-1', createdAt: at.toISOString(),
      recipient: { nudgeCount: 2, digestOnly: true, lastNudgedAt: at.toISOString() },
    });
    expect(out[1]!.approvalIntentId).toBeNull();
    expect(out[1]).not.toHaveProperty('recipient');
  });
});

describe('recordNudge', () => {
  it('runs one statement and returns the new count + next eligible', async () => {
    h.executeRows.push([{ nudge_count: 1, next_eligible_nudge_at: '2026-10-24T10:30:00.000Z' }]);
    const out = await recordNudge(C1, G1, new Date('2026-10-24T10:00:00Z'));
    expect(out).toEqual({ nudgeCount: 1, nextEligibleNudgeAt: new Date('2026-10-24T10:30:00Z') });
    expect(h.calls.filter((c) => c === 'execute')).toHaveLength(1);
  });

  it('the SQL backoff CASE mirrors nextBackoff (both the insert and the conflict branch)', async () => {
    h.executeRows.push([{ nudge_count: 1, next_eligible_nudge_at: new Date() }]);
    await recordNudge(C1, G1, new Date());
    const text = new PgDialect().sqlToQuery(h.executes[0] as SQL).sql;
    const cases = [...text.matchAll(/\(CASE GREATEST\(([^,]+), 0\) ((?:WHEN \d+ THEN \d+ ?)+)ELSE (\d+) END\)/g)];
    expect(cases.map((m) => m[1])).toEqual(['0', 'wisp_concern_recipients.nudge_count']);
    for (const m of cases) {
      const table = new Map([...m[2]!.matchAll(/WHEN (\d+) THEN (\d+)/g)].map((w) => [Number(w[1]), Number(w[2])]));
      const evalCase = (n: number) => table.get(Math.max(n, 0)) ?? Number(m[3]);
      for (let n = 0; n <= 9; n++) expect(evalCase(n)).toBe(nextBackoff(n));
    }
  });

  it('throws ConcernNotFoundError when the concern does not exist', async () => {
    h.executeRows.push([]);
    await expect(recordNudge(C1, G1, new Date())).rejects.toBeInstanceOf(ConcernNotFoundError);
  });
});
