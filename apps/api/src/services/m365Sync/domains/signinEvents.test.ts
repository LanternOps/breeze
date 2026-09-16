import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';

const { executeMock, contextMock } = vi.hoisted(() => ({
  executeMock: vi.fn(),
  contextMock: vi.fn(async (fn: () => Promise<unknown>) => fn()),
}));

vi.mock('../../../db', () => ({
  db: { execute: executeMock },
  withSystemDbAccessContext: contextMock,
  runOutsideDbContext: vi.fn((fn: () => unknown) => fn()),
}));

import {
  persistSigninEvents,
  signinEventsWindow,
  SIGNIN_EVENTS_OVERLAP_MINUTES,
} from './signinEvents';

const ORG = '11111111-1111-4111-8111-111111111111';
const TENANT = '22222222-2222-4222-8222-222222222222';
const NOW = new Date('2026-09-08T12:00:00.000Z');

function compiled(call: number): { sql: string; params: unknown[] } {
  const out = new PgDialect().sqlToQuery(executeMock.mock.calls[call]![0] as never);
  return { sql: out.sql, params: out.params };
}

function ctx() {
  return {
    orgId: ORG,
    tenantId: TENANT,
    connectionId: '33333333-3333-4333-8333-333333333333',
    generation: 7,
    existing: new Map<string, { coreHash: string; isStale: boolean }>(),
    now: NOW,
  };
}

function ev(id: string, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id,
    createdDateTime: '2026-09-02T09:00:00.000Z',
    userId: '44444444-4444-4444-8444-444444444444',
    userPrincipalName: 'ada@contoso.com',
    appId: 'app-1',
    appDisplayName: 'Outlook',
    clientAppUsed: 'Browser',
    ipAddress: '203.0.113.7',
    location: { city: 'Austin', countryOrRegion: 'US' },
    conditionalAccessStatus: 'success',
    status: { errorCode: 0 },
    riskLevelAggregated: 'none',
    riskState: 'none',
    isInteractive: true,
    ...over,
  };
}

function result(items: unknown[], extra: Record<string, unknown> = {}) {
  return {
    success: true as const,
    kind: 'sync' as const,
    items: items as Record<string, unknown>[],
    truncated: false,
    fetchedAt: '2026-09-08T12:00:00.000Z',
    sources: { signinEvents: 'ok' as const },
    ...extra,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  executeMock.mockResolvedValue([{ inserted: 0, updated: 0 }]);
});

describe('persistSigninEvents (#5784 W05)', () => {
  it('upserts on (org_id, graph_id) so a re-fetched event is not duplicated', async () => {
    await persistSigninEvents(ctx(), result([ev('g1'), ev('g1')]));
    expect(executeMock).toHaveBeenCalledOnce();
    const { sql, params } = compiled(0);
    expect(sql).toContain('insert into m365_signin_events');
    expect(sql).toContain('on conflict (org_id, graph_id) do update set');
    // Two copies of the same Graph id collapse in memory: one VALUES row.
    expect(params.filter((p) => p === 'g1')).toHaveLength(1);
  });

  it('NEVER marks unreturned rows stale', async () => {
    await persistSigninEvents(ctx(), result([ev('g2')]));
    // Entity-domain reconciliation would corrupt every closed reporting period.
    const { sql } = compiled(0);
    expect(sql).not.toContain('is_stale');
    expect(sql).not.toContain('stale_since');
    expect(sql).not.toContain('update m365_signin_events set');
  });

  it('reports complete=false and keeps the watermark when a continuation remains', async () => {
    const res = await persistSigninEvents(ctx(), result([ev('g3')], { continuation: 'c1' }));
    expect(res.complete).toBe(false);
    expect(res.continuation).toBe('c1');
  });

  it('reports complete=true for an unlicensed tenant with zero items', async () => {
    // An unlicensed tenant IS complete: there is nothing to enumerate. Same rule
    // signinActivity.ts states for its own sibling.
    const res = await persistSigninEvents(ctx(), {
      ...result([]), sources: { signinEvents: 'unlicensed' as const },
    });
    expect(res.unlicensed).toBe(true);
    expect(res.complete).toBe(true);
    expect(res.inserted).toBe(0);
    expect(executeMock).not.toHaveBeenCalled();
  });

  it('is NOT complete when the source throttled, even with no continuation', async () => {
    // An empty token bucket on a fresh (non-continuation) call mints no
    // continuation and returns zero items, so `continuation === null` and
    // `!truncated` both hold. Only the `=== 'ok'` check stops that run from
    // stamping last_complete_snapshot_at and claiming a freshness for W06 that
    // the data does not have.
    const res = await persistSigninEvents(ctx(), {
      ...result([]), sources: { signinEvents: 'throttled' as const },
    });
    expect(res.complete).toBe(false);
    expect(res.unlicensed).toBe(false);
  });

  it('is not complete when the window was truncated', async () => {
    const res = await persistSigninEvents(ctx(), result([ev('g7')], { truncated: true }));
    expect(res.complete).toBe(false);
  });

  it('stores the Graph `hidden` sentinel for risk fields rather than inventing a level', async () => {
    await persistSigninEvents(ctx(), result([
      ev('g4', { riskLevelAggregated: 'hidden', riskState: 'hidden' }),
    ]));
    const { params } = compiled(0);
    expect(params).toContain('hidden');
  });

  it('flattens location and status into their own columns and keeps no payload', async () => {
    await persistSigninEvents(ctx(), result([
      ev('g5', {
        location: { city: 'Austin', countryOrRegion: 'US' },
        status: { errorCode: 50126, failureReason: 'Invalid username or password' },
      }),
    ]));
    const { sql, params } = compiled(0);
    expect(params).toContain('Austin');
    expect(params).toContain('US');
    expect(params).toContain(50126);
    expect(params).toContain('Invalid username or password');
    // No column may carry the raw sub-object.
    expect(sql).not.toContain('jsonb');
    for (const p of params) expect(typeof p === 'object' && p !== null && !(p instanceof Date)).toBe(false);
  });

  it('binds signed_in_at as an ISO string cast in SQL, and never sets ingested_at', async () => {
    // A JS Date inside a raw drizzle fragment throws at bind time in postgres.js.
    await persistSigninEvents(ctx(), result([ev('g6', { createdDateTime: '2026-09-01T00:00:00.000Z' })]));
    const { sql, params } = compiled(0);
    expect(params).toContain('2026-09-01T00:00:00.000Z');
    expect(sql).not.toContain('ingested_at');   // DB default now() — late arrivals stay detectable
  });

  it('drops an event with no id or no usable event time rather than inventing one, and SAYS SO', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      await persistSigninEvents(ctx(), result([
        ev('ok1'),
        ev('', {}),
        { ...ev('bad-time'), createdDateTime: 'not a date' },
      ]));
      const { params } = compiled(0);
      expect(params).toContain('ok1');
      expect(params).not.toContain('bad-time');
      // Silently shrinking a compliance evidence set is the failure mode here.
      const line = log.mock.calls.find((c) => String(c[0]).includes('malformed_items'));
      expect(line, 'malformed items were dropped with no log line').toBeDefined();
      expect(JSON.parse(String(line![1]))).toMatchObject({ received: 3, malformed: 2 });
    } finally { log.mockRestore(); }
  });

  it('does not report ordinary de-duplication as malformed', async () => {
    // The overlapping window re-fetches recent events on purpose; that is not a
    // data-quality signal and must not cry wolf in the logs.
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      await persistSigninEvents(ctx(), result([ev('dup'), ev('dup')]));
      expect(log.mock.calls.filter((c) => String(c[0]).includes('malformed_items'))).toHaveLength(0);
    } finally { log.mockRestore(); }
  });

  it('counts inserted and updated from the upsert, not from the item count', async () => {
    executeMock.mockResolvedValueOnce([{ inserted: 2, updated: 1 }]);
    const res = await persistSigninEvents(ctx(), result([ev('a'), ev('b'), ev('c')]));
    expect(res.inserted).toBe(2);
    expect(res.updated).toBe(1);
    expect(res.stale).toBe(0);
    expect(res.counts.signin_events).toBe(3);
  });
});

describe('signinEventsWindow (#5784 W05)', () => {
  it('cold start: an org with no events pulls a bounded 7-day window', async () => {
    executeMock.mockResolvedValueOnce([{ watermark: null }]);
    const window = await signinEventsWindow(ORG, NOW);
    expect(window.until).toBe(NOW.toISOString());
    expect(window.since).toBe(new Date(NOW.getTime() - 7 * 24 * 3600_000).toISOString());
  });

  it('steady state: since is MAX(signed_in_at) MINUS the overlap, not the bare watermark', async () => {
    // A bare watermark would permanently skip anything Graph surfaced late.
    const watermark = new Date('2026-09-08T10:00:00.000Z');
    executeMock.mockResolvedValueOnce([{ watermark: watermark.toISOString() }]);
    const window = await signinEventsWindow(ORG, NOW);
    expect(window.since)
      .toBe(new Date(watermark.getTime() - SIGNIN_EVENTS_OVERLAP_MINUTES * 60_000).toISOString());
    expect(window.until).toBe(NOW.toISOString());
    expect(SIGNIN_EVENTS_OVERLAP_MINUTES).toBeGreaterThan(0);
  });

  it('walks forward from an OLD watermark instead of clamping past the gap', async () => {
    // The load-bearing one. An org whose sync was down for a fortnight has a
    // watermark older than any fixed lookback. Clamping `since` forward to
    // `now - 7d` would move the window PAST the gap, and no later run would
    // ever come back for it (each recomputes the clamp against a newer `now`
    // while the watermark now sits inside it) — Graph purges at ~30 days, so
    // those events would be gone, silently, with no error and no truncation.
    const watermark = new Date(NOW.getTime() - 21 * 24 * 3600_000);
    executeMock.mockResolvedValueOnce([{ watermark: watermark.toISOString() }]);
    const window = await signinEventsWindow(ORG, NOW);
    expect(window.since)
      .toBe(new Date(watermark.getTime() - SIGNIN_EVENTS_OVERLAP_MINUTES * 60_000).toISOString());
    // The window covers the whole gap; the per-run item cap and the executor's
    // continuation are what bound the WALK, not a silent truncation in time.
    expect(Date.parse(window.until) - Date.parse(window.since))
      .toBeGreaterThan(20 * 24 * 3600_000);
  });

  it('scopes the watermark read to the org', async () => {
    executeMock.mockResolvedValueOnce([{ watermark: null }]);
    await signinEventsWindow(ORG, NOW);
    const { sql, params } = compiled(0);
    expect(sql).toContain('max(signed_in_at)');
    expect(sql).toContain('m365_signin_events');
    expect(params).toContain(ORG);
  });
});
