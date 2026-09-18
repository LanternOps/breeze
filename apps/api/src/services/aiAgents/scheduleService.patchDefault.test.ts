/**
 * AI patch agent W01 — `ensureDefaultPatchSchedule`: the default 02:00
 * partner-timezone baseline a partner-wide patch agent gets the first time it
 * is enabled (and via the boot backfill). Driven with a fake EXECUTOR — the
 * function never touches the ambient `db`, because callers run it inside a
 * SAVEPOINT (`db.transaction(tx => …)`) so a failure cannot poison the
 * enclosing request transaction.
 */
import { describe, expect, it, vi } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';

vi.mock('../../db', () => ({
  db: {},
  getCurrentDbAccessContext: vi.fn(),
  runOutsideDbContext: vi.fn((fn: () => unknown) => fn()),
  withSystemDbAccessContext: vi.fn((fn: () => unknown) => fn()),
}));

import { ensureDefaultPatchSchedule } from './scheduleService';

const PARTNER = '00000000-0000-4000-8000-0000000000b1';
const AGENT = '00000000-0000-4000-8000-0000000000c1';
const dialect = new PgDialect();

function fakeExecutor(opts: { existing?: unknown[]; partnerTz?: string | null } = {}) {
  const selects: Array<{ table: string; where?: SQL }> = [];
  const inserted: Record<string, unknown>[] = [];
  const executed: SQL[] = [];
  const queue = [opts.existing ?? [], opts.partnerTz === undefined ? [{ timezone: 'Europe/Berlin' }] : opts.partnerTz === null ? [] : [{ timezone: opts.partnerTz }]];
  const executor = {
    execute: vi.fn(async (stmt: SQL) => { executed.push(stmt); return []; }),
    select: vi.fn(() => ({
      from: vi.fn((table: unknown) => {
        const name = String((table as Record<symbol, unknown>)[Symbol.for('drizzle:Name')]);
        const entry: { table: string; where?: SQL } = { table: name };
        selects.push(entry);
        const builder: Record<string, unknown> = {
          where: vi.fn((w: SQL) => { entry.where = w; return builder; }),
          limit: vi.fn(() => builder),
          then: (resolve: (v: unknown) => unknown) => Promise.resolve(queue.shift() ?? []).then(resolve),
        };
        return builder;
      }),
    })),
    insert: vi.fn(() => ({
      values: vi.fn((v: Record<string, unknown>) => { inserted.push(v); return Promise.resolve([]); }),
    })),
  };
  return { executor, selects, inserted, executed };
}

const agent = (over: Record<string, unknown> = {}) => ({
  id: AGENT, kind: 'patch', orgId: null, partnerId: PARTNER, enabled: true, disabledAt: null, ...over,
});

describe('ensureDefaultPatchSchedule', () => {
  it('creates a 0 2 * * * partner-timezone baseline with no sweep kinds and no creator', async () => {
    const f = fakeExecutor();
    const result = await ensureDefaultPatchSchedule(agent() as never, f.executor as never);
    expect(result).toEqual({ created: true });
    expect(f.inserted).toEqual([expect.objectContaining({
      orgId: null, partnerId: PARTNER, agentId: AGENT, baselineScheduleId: null,
      kind: 'patch', cron: '0 2 * * *', timezone: 'Europe/Berlin', sweepKinds: [], enabled: true, createdBy: null,
    })]);
  });

  it('serialises concurrent callers on a per-agent advisory lock before checking for an existing row', async () => {
    const f = fakeExecutor();
    await ensureDefaultPatchSchedule(agent() as never, f.executor as never);
    expect(f.executed).toHaveLength(1);
    const q = dialect.sqlToQuery(f.executed[0]!);
    expect(q.sql).toContain('pg_advisory_xact_lock');
    expect(q.params.join(' ')).toContain(AGENT);
  });

  it('is idempotent — an existing patch baseline means nothing is created', async () => {
    const f = fakeExecutor({ existing: [{ id: 'sched-1' }] });
    expect(await ensureDefaultPatchSchedule(agent() as never, f.executor as never)).toEqual({ created: false, reason: 'exists' });
    expect(f.inserted).toEqual([]);
    const existingRead = f.selects.find((s) => s.table === 'ai_agent_schedules')!;
    const q = dialect.sqlToQuery(existingRead.where!);
    expect(q.params).toContain(AGENT);
    expect(q.params).toContain('patch');
  });

  it('falls back to UTC when the partner row has no usable timezone', async () => {
    const f = fakeExecutor({ partnerTz: 'Mars/Olympus' });
    await ensureDefaultPatchSchedule(agent() as never, f.executor as never);
    expect(f.inserted[0]).toMatchObject({ timezone: 'UTC' });
  });

  it.each([
    ['an ORG-owned patch agent', { orgId: '00000000-0000-4000-8000-0000000000a1' }],
    ['a triage agent', { kind: 'triage' }],
    ['a designer agent', { kind: 'designer' }],
    ['a helpdesk agent', { kind: 'helpdesk' }],
    ['a disabled agent', { enabled: false }],
    ['a soft-deleted agent', { disabledAt: new Date() }],
  ])('never creates a schedule for %s', async (_label, over) => {
    const f = fakeExecutor();
    const result = await ensureDefaultPatchSchedule(agent(over) as never, f.executor as never);
    expect(result).toEqual({ created: false, reason: 'not_applicable' });
    expect(f.inserted).toEqual([]);
    expect(f.executor.select).not.toHaveBeenCalled();
  });
});
