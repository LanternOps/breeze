import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';

// db: every builder method returns the chain; awaiting the chain pops the next queued result.
// Per-line query order inside the sweep: backlog check -> (creator fallback) -> org name.
const { queue, whereArgs, ctx } = vi.hoisted(() => ({
  queue: [] as unknown[][],
  whereArgs: [] as unknown[],
  ctx: { systemEnters: 0 },
}));
vi.mock('../db', () => {
  const chain: Record<string, unknown> = {};
  for (const m of ['select', 'from', 'innerJoin', 'limit']) chain[m] = vi.fn(() => chain);
  chain.where = vi.fn((w: unknown) => { whereArgs.push(w); return chain; });
  (chain as { then: unknown }).then = (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) =>
    Promise.resolve(queue.shift() ?? []).then(resolve, reject);
  return {
    db: chain,
    runOutsideDbContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
    withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => { ctx.systemEnters += 1; return fn(); }),
  };
});

const m = vi.hoisted(() => ({
  compute: vi.fn(), holders: vi.fn(), notify: vi.fn(), emit: vi.fn(), capture: vi.fn(),
  redisSet: vi.fn(), redisDel: vi.fn(), getRedis: vi.fn(),
}));
vi.mock('./contractHourBlockEstimate', () => ({ computeOpenHourBlockPeriod: m.compute }));
vi.mock('./usersWithPermission', () => ({ resolveUsersWithPermissionForOrg: m.holders }));
vi.mock('./userNotifications', () => ({ createNotification: m.notify }));
vi.mock('./contractEvents', () => ({ emitContractEvent: m.emit }));
vi.mock('./sentry', () => ({ captureException: m.capture }));
vi.mock('./redis', () => ({ getRedis: m.getRedis }));
vi.mock('./permissions', () => ({ PERMISSIONS: { CONTRACTS_READ: { resource: 'contracts', action: 'read' } } }));

import { hasCrossedThreshold, runHourBlockAlertSweep } from './contractHourBlockAlerts';

const contract = (id: string, over: Record<string, unknown> = {}) => ({
  id, orgId: `org-${id}`, partnerId: 'p1', createdBy: 'creator-1', ...over,
});
const line = (id: string, pct: number | null = 80) => ({
  id, hourBlockAlertPct: pct, hourBlockFirstPeriodStart: '2026-12-01',
});
const est = (over: Record<string, unknown> = {}) => ({
  periodStart: '2026-12-01', periodEnd: '2027-01-01',
  includedHours: 10, carriedInHours: 0, consumedHours: 8, ...over,
});
const NO_BACKLOG: unknown[] = [];
const BACKLOG = [{ id: 'bp-1' }];
const ASOF = new Date('2026-12-20T12:00:00Z');
const MARKER = 'hour_block_alert:l1:2026-12-01:80';

describe('hasCrossedThreshold (exact integer-cent arithmetic)', () => {
  it.each([
    [8, 10, 80, true],
    [7.99, 10, 80, false],
    [10, 10, 100, true],
    [9.99, 10, 100, false],
    [9.6, 12, 80, true],      // opening includes 2 carried hours: 9.6 / 12 = 80%
    [9.59, 12, 80, false],
    [0, 10, 1, false],
    [25, 10, 100, true],
    [0.1 + 0.2, 1, 30, true], // 0.30000000000000004 must not flip the answer
    [5, 0, 50, false],
  ])('consumed %s of %s at %s%% -> %s', (consumed, opening, pct, expected) => {
    expect(hasCrossedThreshold(consumed, opening, pct)).toBe(expected);
  });
});

describe('runHourBlockAlertSweep', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    queue.length = 0;
    whereArgs.length = 0;
    ctx.systemEnters = 0;
    m.compute.mockResolvedValue(est());
    m.holders.mockResolvedValue(['u1']);
    m.notify.mockResolvedValue('notif-1');
    m.emit.mockResolvedValue(undefined);
    m.redisSet.mockResolvedValue('OK');
    m.redisDel.mockResolvedValue(1);
    m.getRedis.mockReturnValue({ set: m.redisSet, del: m.redisDel });
  });

  it('selects only live, alert-configured blocks on active contracts of automation-eligible orgs (compiled SQL)', async () => {
    await runHourBlockAlertSweep(ASOF);

    const q = new PgDialect().sqlToQuery(whereArgs[0] as SQL);
    expect(q.sql).toContain('"contract_lines"."line_type" = $');
    expect(q.sql).toContain('"contract_lines"."hour_block_retired_at" is null');
    expect(q.sql).toContain('"contract_lines"."hour_block_alert_pct" is not null');
    expect(q.sql).toContain('"contracts"."status" = $');
    expect(q.sql).toContain('automation_eligible_org.id = "contracts"."org_id"');
    expect(q.params).toEqual(expect.arrayContaining(['hour_block', 'active', 'active', 'trial']));
    expect(q.params).not.toContain('archived');
    expect(q.params).not.toContain('purging');
    expect(q.params).not.toContain('merging');
  });

  it('crossing -> claims the durable marker, writes the notification, then emits ONE event after commit', async () => {
    queue.push([{ contract: contract('c1'), line: line('l1', 80) }], NO_BACKLOG, [{ name: 'Acme Dental' }]);

    const result = await runHourBlockAlertSweep(ASOF);

    // SET key 1 EX <ttl to period end + 1 day> NX
    expect(m.redisSet).toHaveBeenCalledWith(MARKER, '1', 'EX', expect.any(Number), 'NX');
    const ttl = m.redisSet.mock.calls[0]![3] as number;
    expect(ttl).toBe(Math.ceil((Date.UTC(2027, 0, 1) - ASOF.getTime()) / 1000) + 86_400);

    expect(m.compute).toHaveBeenCalledWith(expect.objectContaining({ id: 'c1' }), expect.objectContaining({ id: 'l1' }), ASOF);
    expect(m.holders).toHaveBeenCalledWith('org-c1', { resource: 'contracts', action: 'read' });
    expect(m.notify).toHaveBeenCalledTimes(1);
    expect(m.notify).toHaveBeenCalledWith(expect.objectContaining({
      userId: 'u1', orgId: 'org-c1', type: 'system', priority: 'high',
      link: '/contracts/c1', dedupeKey: 'hour_block:l1:2026-12-01:80',
      metadata: expect.objectContaining({ event: 'contract.hour_block_threshold', contractId: 'c1', contractLineId: 'l1', alertPct: 80 }),
    }));
    const call = m.notify.mock.calls[0]![0] as { title: string; message: string };
    expect(call.title).toContain('Acme Dental');
    expect(call.title.length).toBeLessThanOrEqual(255);
    expect(call.message).toContain('8 of 10');
    expect(call.message).toContain('2026-12-01');

    expect(m.emit).toHaveBeenCalledTimes(1);
    expect(m.emit).toHaveBeenCalledWith({
      type: 'contract.hour_block_threshold',
      contractId: 'c1', orgId: 'org-c1', partnerId: 'p1',
      contractLineId: 'l1', periodStart: '2026-12-01', alertPct: 80,
    });
    expect(result).toEqual({ lines: 1, crossed: 1, notified: 1, skippedBacklog: 0, errors: 0 });
  });

  it('marker already set (an earlier sweep alerted, even if the user dismissed the notification): nothing is written or emitted', async () => {
    m.redisSet.mockResolvedValue(null); // SET NX lost
    queue.push([{ contract: contract('c1'), line: line('l1', 80) }], NO_BACKLOG);

    const result = await runHourBlockAlertSweep(ASOF);

    expect(m.holders).not.toHaveBeenCalled();
    expect(m.notify).not.toHaveBeenCalled();
    expect(m.emit).not.toHaveBeenCalled();
    expect(result).toMatchObject({ crossed: 1, notified: 0 });
  });

  it('below the threshold: no marker, nothing resolved, written or emitted', async () => {
    m.compute.mockResolvedValue(est({ consumedHours: 7.99 }));
    queue.push([{ contract: contract('c1'), line: line('l1', 80) }], NO_BACKLOG);

    const result = await runHourBlockAlertSweep(ASOF);

    expect(m.redisSet).not.toHaveBeenCalled();
    expect(m.holders).not.toHaveBeenCalled();
    expect(m.notify).not.toHaveBeenCalled();
    expect(m.emit).not.toHaveBeenCalled();
    expect(result).toMatchObject({ lines: 1, crossed: 0, notified: 0 });
  });

  it('a close backlog (claimed, ended, unclosed period) skips the line BEFORE computing anything', async () => {
    queue.push([{ contract: contract('c1'), line: line('l1', 80) }], BACKLOG);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const result = await runHourBlockAlertSweep(ASOF);

      expect(m.compute).not.toHaveBeenCalled();
      expect(m.redisSet).not.toHaveBeenCalled();
      expect(m.notify).not.toHaveBeenCalled();
      expect(m.emit).not.toHaveBeenCalled();
      expect(warn).toHaveBeenCalled();
      expect(result).toEqual({ lines: 1, crossed: 0, notified: 0, skippedBacklog: 1, errors: 0 });
    } finally {
      warn.mockRestore();
    }
  });

  it('notifies every permission holder, one row each; the event still fires once', async () => {
    m.holders.mockResolvedValue(['u1', 'u2', 'u3']);
    m.notify.mockResolvedValueOnce('n1').mockResolvedValueOnce(null).mockResolvedValueOnce('n3');
    queue.push([{ contract: contract('c1'), line: line('l1') }], NO_BACKLOG, [{ name: 'Acme' }]);

    const result = await runHourBlockAlertSweep(ASOF);

    expect(m.notify.mock.calls.map((c) => (c[0] as { userId: string }).userId)).toEqual(['u1', 'u2', 'u3']);
    expect(result.notified).toBe(2);
    expect(m.emit).toHaveBeenCalledTimes(1);
  });

  it("falls back to the contract's creator when nobody holds contracts:read", async () => {
    m.holders.mockResolvedValue([]);
    queue.push([{ contract: contract('c1'), line: line('l1') }], NO_BACKLOG, [{ id: 'creator-1' }], [{ name: 'Acme' }]);

    await runHourBlockAlertSweep(ASOF);

    expect(m.notify).toHaveBeenCalledTimes(1);
    expect(m.notify).toHaveBeenCalledWith(expect.objectContaining({ userId: 'creator-1' }));
  });

  it('no recipient at all: warns, RELEASES the marker, writes and emits nothing, not an error', async () => {
    m.holders.mockResolvedValue([]);
    queue.push([{ contract: contract('c1', { createdBy: null }), line: line('l1') }], NO_BACKLOG);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const result = await runHourBlockAlertSweep(ASOF);
      expect(m.notify).not.toHaveBeenCalled();
      expect(m.emit).not.toHaveBeenCalled();
      expect(m.redisDel).toHaveBeenCalledWith(MARKER);
      expect(warn).toHaveBeenCalled();
      expect(result).toMatchObject({ crossed: 1, notified: 0, errors: 0 });
    } finally {
      warn.mockRestore();
    }
  });

  it('a failing notification write releases the marker (so the alert is retried) and counts as an error', async () => {
    m.notify.mockRejectedValue(new Error('insert failed'));
    queue.push([{ contract: contract('c1'), line: line('l1') }], NO_BACKLOG, [{ name: 'Acme' }]);
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const result = await runHourBlockAlertSweep(ASOF);
      expect(m.redisDel).toHaveBeenCalledWith(MARKER);
      expect(m.emit).not.toHaveBeenCalled();
      expect(result).toMatchObject({ errors: 1, notified: 0 });
    } finally {
      err.mockRestore();
    }
  });

  it('Redis unavailable: degrades to the notification dedupe_key guard and emits only if a row was newly created', async () => {
    m.getRedis.mockReturnValue(null);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      queue.push([{ contract: contract('c1'), line: line('l1') }], NO_BACKLOG, [{ name: 'Acme' }]);
      await runHourBlockAlertSweep(ASOF);
      expect(m.notify).toHaveBeenCalledTimes(1);
      expect(m.emit).toHaveBeenCalledTimes(1);

      m.emit.mockClear();
      m.notify.mockResolvedValue(null); // dedupe_key hit: row already exists
      queue.push([{ contract: contract('c1'), line: line('l1') }], NO_BACKLOG, [{ name: 'Acme' }]);
      await runHourBlockAlertSweep(ASOF);
      expect(m.emit).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  it('opens one system context per block line (+1 for the candidate read) so one failure cannot poison the rest', async () => {
    queue.push(
      [{ contract: contract('c1'), line: line('l1') }, { contract: contract('c2'), line: line('l2') }],
      NO_BACKLOG, NO_BACKLOG, [{ name: 'Beta' }],
    );
    m.compute.mockRejectedValueOnce(new Error('boom')).mockResolvedValueOnce(est());
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const result = await runHourBlockAlertSweep(ASOF);

      expect(ctx.systemEnters).toBe(3);
      expect(m.notify).toHaveBeenCalledTimes(1);
      expect(m.notify).toHaveBeenCalledWith(expect.objectContaining({ orgId: 'org-c2' }));
      expect(m.capture).toHaveBeenCalledTimes(1);
      expect(result).toMatchObject({ lines: 2, crossed: 1, notified: 1, errors: 1 });
    } finally {
      err.mockRestore();
    }
  });

  it('a changed threshold uses a different marker and dedupe key (so it can alert once more)', async () => {
    queue.push([{ contract: contract('c1'), line: line('l1', 90) }], NO_BACKLOG, [{ name: 'Acme' }]);
    m.compute.mockResolvedValue(est({ consumedHours: 9.5 }));

    await runHourBlockAlertSweep(ASOF);

    expect(m.redisSet).toHaveBeenCalledWith('hour_block_alert:l1:2026-12-01:90', '1', 'EX', expect.any(Number), 'NX');
    expect(m.notify).toHaveBeenCalledWith(expect.objectContaining({ dedupeKey: 'hour_block:l1:2026-12-01:90' }));
  });
});
