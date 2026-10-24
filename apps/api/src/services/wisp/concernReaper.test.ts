/**
 * Wisp W05b Task 10 — the concern retention reaper. `db.execute` is mocked and
 * every statement is rendered through the real Postgres dialect, so assertions
 * read the SQL and its bound parameters (cutoffs, kinds, limits) rather than a
 * call count. `resolveConcern` (W05a, frozen) is mocked: its own suite proves
 * that `{}` (no grantId) writes no memory block.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';

const h = vi.hoisted(() => ({
  statements: [] as Array<{ text: string; params: unknown[] }>,
  /** Rows returned by the subject-reconciliation SELECT, keyed by subject kind. */
  goneByKind: {} as Record<string, string[]>,
  /** Row counts returned by successive DELETE batches. */
  deleteCounts: [] as number[],
  failOn: null as null | RegExp,
  contexts: [] as string[],
  resolveConcern: vi.fn(async (_id: string, _by: Record<string, unknown>, _outcome: string) => {}),
  captureException: vi.fn(),
}));

const dialect = new PgDialect();

vi.mock('../../db', () => ({
  db: {
    execute: vi.fn(async (query: SQL) => {
      const { sql: text, params } = dialect.sqlToQuery(query);
      h.statements.push({ text, params });
      if (h.failOn && h.failOn.test(text)) throw new Error('boom');
      if (/^\s*DELETE FROM wisp_concerns/.test(text)) return { count: h.deleteCounts.shift() ?? 0 };
      if (/NOT EXISTS/.test(text)) {
        const kind = params.find((p) => typeof p === 'string' && p in h.goneByKind) as string | undefined;
        return (kind ? h.goneByKind[kind]! : []).map((id) => ({ id }));
      }
      return [];
    }),
  },
  runOutsideDbContext: (fn: () => unknown) => fn(),
  withSystemDbAccessContext: async (fn: () => Promise<unknown>, label?: string) => {
    h.contexts.push(label ?? '');
    return fn();
  },
}));

vi.mock('./concerns', () => ({
  resolveConcern: (id: string, by: Record<string, unknown>, outcome: string) => h.resolveConcern(id, by, outcome),
}));

vi.mock('../sentry', () => ({
  captureException: (...args: unknown[]) => h.captureException(...args),
  captureMessage: vi.fn(),
}));

import { RECONCILED_SUBJECT_KINDS, reapConcerns, reconcileConcernSubjects } from './concernReaper';

const NOW = new Date('2026-10-24T21:23:00.000Z');
const DAY = 24 * 60 * 60 * 1000;

function deletes() {
  return h.statements.filter((s) => /^\s*DELETE FROM wisp_concerns/.test(s.text));
}
function reconciliations() {
  return h.statements.filter((s) => /NOT EXISTS/.test(s.text));
}
function reconciliationFor(kind: string) {
  const hit = reconciliations().find((s) => s.params.includes(kind));
  expect(hit, `no reconciliation query for ${kind}`).toBeDefined();
  return hit!;
}
function cutoffOf(stmt: { params: unknown[] }): Date {
  const iso = stmt.params.find((p) => typeof p === 'string' && /^\d{4}-\d\d-\d\dT/.test(p)) as string;
  return new Date(iso);
}

beforeEach(() => {
  h.statements = [];
  h.goneByKind = {};
  h.deleteCounts = [];
  h.failOn = null;
  h.contexts = [];
  h.resolveConcern.mockReset();
  h.resolveConcern.mockImplementation(async () => {});
  h.captureException.mockReset();
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'log').mockImplementation(() => {});
});

describe('reapConcerns — pass 1: closed-concern retention', () => {
  it('deletes resolved/dismissed rows last touched before now − 90 d (91 d old goes, 89 d old stays)', async () => {
    h.deleteCounts = [3];
    const result = await reapConcerns(NOW);

    const [del] = deletes();
    expect(del).toBeDefined();
    expect(del!.text).toMatch(/"wisp_concerns"\."status" IN \('resolved','dismissed'\)/);
    expect(del!.text).toMatch(/"wisp_concerns"\."updated_at" < \$\d+::timestamptz/);
    const cutoff = cutoffOf(del!);
    expect(cutoff.getTime()).toBe(NOW.getTime() - 90 * DAY);
    // The predicate is `updated_at < cutoff`:
    expect(new Date(NOW.getTime() - 91 * DAY) < cutoff).toBe(true);   // deleted
    expect(new Date(NOW.getTime() - 89 * DAY) < cutoff).toBe(false);  // kept
    expect(result.deleted).toBe(3);
  });

  it('never deletes a live concern, whatever its age', async () => {
    await reapConcerns(NOW);
    for (const d of deletes()) expect(d.text).not.toMatch(/'open'|'snoozed'/);
  });

  it('batches at `limit` and stops after a short batch; each batch in its own system context', async () => {
    h.deleteCounts = [2, 2, 1];
    const result = await reapConcerns(NOW, { limit: 2 });
    expect(deletes()).toHaveLength(3);
    expect(deletes()[0]!.params).toContain(2);
    expect(result.deleted).toBe(5);
    expect(h.contexts.filter((l) => l.includes('wisp.concernReaper.prune'))).toHaveLength(3);
  });

  it('honours resolvedRetentionDays', async () => {
    await reapConcerns(NOW, { resolvedRetentionDays: 30 });
    expect(cutoffOf(deletes()[0]!).getTime()).toBe(NOW.getTime() - 30 * DAY);
  });
});

describe('reapConcerns — pass 2: subject reconciliation (Review Focus 3)', () => {
  it('resolves a live concern whose ticket row is gone with subject_gone and no memory block', async () => {
    h.goneByKind = { ticket: ['c-ticket-1'] };
    const result = await reapConcerns(NOW);

    expect(h.resolveConcern).toHaveBeenCalledTimes(1);
    expect(h.resolveConcern).toHaveBeenCalledWith('c-ticket-1', {}, 'subject_gone');
    expect(result.subjectGone).toBe(1);

    const q = reconciliationFor('ticket');
    expect(q.text).toMatch(/"wisp_concerns"\."status" IN \('open','snoozed'\)/);
    expect(q.text).toMatch(/FROM "tickets" WHERE "tickets"\."id" = "wisp_concerns"\."subject_id"/);
    // A soft-deleted ticket is hidden from every staff list: gone.
    expect(q.text).toMatch(/"tickets"\."deleted_at" IS NULL/);
  });

  it('pins the subject to the concern org: a ticket moved to another org counts as gone', async () => {
    h.goneByKind = { ticket: ['c-moved'] };
    await reapConcerns(NOW);
    expect(reconciliationFor('ticket').text).toMatch(/"tickets"\."org_id" = "wisp_concerns"\."org_id"/);
    expect(h.resolveConcern).toHaveBeenCalledWith('c-moved', {}, 'subject_gone');
  });

  it('skips partner-level (org_id NULL) concerns', async () => {
    await reapConcerns(NOW);
    expect(reconciliations().length).toBeGreaterThan(0);
    for (const q of reconciliations()) expect(q.text).toMatch(/"wisp_concerns"\."org_id" IS NOT NULL/);
  });

  it('never reconciles incident concerns (correlator-owned, no subject table)', async () => {
    await reapConcerns(NOW);
    expect(RECONCILED_SUBJECT_KINDS).not.toContain('incident');
    for (const q of reconciliations()) expect(q.params).not.toContain('incident');
  });

  it('runs one bounded NOT EXISTS query per reconciled kind against its own table', async () => {
    await reapConcerns(NOW, { limit: 7 });
    const expected: Record<string, string> = {
      ticket: 'tickets', device: 'devices', alert: 'alerts', org: 'organizations',
      integration: 'connection_health_incidents', run: 'ai_agent_runs', task: 'ai_operator_tasks',
      quote: 'quotes', invoice: 'invoices', contract: 'contracts', site: 'sites',
    };
    expect([...RECONCILED_SUBJECT_KINDS].sort()).toEqual(Object.keys(expected).sort());
    expect(reconciliations()).toHaveLength(Object.keys(expected).length);
    for (const [kind, table] of Object.entries(expected)) {
      const q = reconciliationFor(kind);
      expect(q.text).toContain(`NOT EXISTS (SELECT 1 FROM "${table}" WHERE "${table}"."id" = "wisp_concerns"."subject_id"`);
      expect(q.text).toMatch(/LIMIT \$\d+/);
      expect(q.params).toContain(7);
    }
  });

  it('treats a decommissioned device and a soft-deleted org as gone', async () => {
    await reapConcerns(NOW);
    expect(reconciliationFor('device').text).toMatch(/"devices"\."status" <> 'decommissioned'/);
    const org = reconciliationFor('org').text;
    expect(org).toMatch(/"organizations"\."id" = "wisp_concerns"\."org_id"/);
    expect(org).toMatch(/"organizations"\."deleted_at" IS NULL/);
  });

  it('keeps going when one resolution throws', async () => {
    h.goneByKind = { ticket: ['c-1', 'c-2'] };
    h.resolveConcern.mockImplementationOnce(async () => { throw new Error('nope'); });
    const result = await reconcileConcernSubjects();
    expect(h.resolveConcern).toHaveBeenCalledTimes(2);
    expect(result.subjectGone).toBe(1);
    expect(h.captureException).toHaveBeenCalled();
  });

  it('keeps going when one kind query throws', async () => {
    h.failOn = /FROM "tickets"/;
    h.goneByKind = { device: ['c-dev'] };
    const result = await reconcileConcernSubjects();
    expect(h.resolveConcern).toHaveBeenCalledWith('c-dev', {}, 'subject_gone');
    expect(result.subjectGone).toBe(1);
    expect(h.captureException).toHaveBeenCalled();
  });
});

describe('reapConcerns — pass isolation', () => {
  it('a throwing delete pass is logged and reconciliation still runs', async () => {
    h.failOn = /^\s*DELETE FROM wisp_concerns/;
    h.goneByKind = { alert: ['c-alert'] };
    const result = await reapConcerns(NOW);
    expect(result).toEqual({ deleted: 0, subjectGone: 1 });
    expect(h.captureException).toHaveBeenCalled();
    expect(console.error).toHaveBeenCalled();
  });
});
