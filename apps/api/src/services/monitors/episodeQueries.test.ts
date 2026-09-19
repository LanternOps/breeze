/**
 * #5290 — read-model tests for episodeQueries.ts.
 *
 * Every consumer of this module mocks it away, so its join and pagination
 * logic has never actually run before. The fake `db.select` proxies every
 * chain call (`.from`/`.innerJoin`/`.leftJoin`/`.where`/`.orderBy`/`.limit`)
 * onto a REAL drizzle `QueryBuilder`, so `capturedSql` holds the genuinely
 * compiled SQL text — the same trick used in episodeReset.test.ts /
 * episodeService.test.ts. The mocked rows returned to the caller are supplied
 * separately via `state.selectRows`, so a test can assert BOTH the compiled
 * SQL shape and the mapped output for the same call.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { QueryBuilder } from 'drizzle-orm/pg-core';

const state = vi.hoisted(() => ({
  selectRows: [] as unknown[][],
  capturedSql: [] as string[],
  capturedParams: [] as unknown[][],
}));

function makeSelect() {
  return (fields?: unknown) => {
    const qb = new QueryBuilder();
    let real: unknown = fields ? qb.select(fields as never) : qb.select();
    const proxy: unknown = new Proxy(function () {} as unknown as object, {
      get(_t, prop: string) {
        if (prop === 'then') {
          try {
            const compiled = (real as { toSQL(): { sql: string; params: unknown[] } }).toSQL();
            state.capturedSql.push(compiled.sql.toLowerCase());
            state.capturedParams.push(compiled.params);
          } catch {
            state.capturedSql.push('');
            state.capturedParams.push([]);
          }
          const rows = state.selectRows.shift() ?? [];
          return (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) =>
            Promise.resolve(rows).then(res, rej);
        }
        return (...args: unknown[]) => {
          const target = real as Record<string, unknown>;
          if (typeof target?.[prop] === 'function') {
            try {
              real = (target[prop] as (...a: unknown[]) => unknown).apply(real, args);
            } catch {
              /* a step the standalone builder cannot model — SQL capture degrades, rows still flow */
            }
          }
          return proxy;
        };
      },
    });
    return proxy;
  };
}

const { dbMock } = vi.hoisted(() => ({ dbMock: { select: vi.fn() } }));

vi.mock('../../db', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../db')>()),
  db: dbMock,
}));

import { listMonitorDeviceActivity, listMonitorEpisodes } from './episodeQueries';
import type { AuthContext } from '../../middleware/auth';

const MONITOR = '11111111-1111-4111-8111-111111111111';
const DEVICE = '22222222-2222-4222-8222-222222222222';
const ORG = '33333333-3333-4333-8333-333333333333';

function auth(): AuthContext {
  return { orgCondition: () => undefined } as unknown as AuthContext;
}

beforeEach(() => {
  state.selectRows = [];
  state.capturedSql = [];
  state.capturedParams = [];
  dbMock.select.mockReset();
  dbMock.select.mockImplementation(makeSelect());
});

function activityRow(overrides: Record<string, unknown> = {}) {
  return {
    deviceId: DEVICE,
    orgId: ORG,
    lastState: 'breach',
    lastEvaluatedAt: new Date('2026-09-13T10:00:00.000Z'),
    currentEpisodeId: null,
    episodesInWindow: 2,
    windowStartedAt: new Date('2026-09-10T00:00:00.000Z'),
    escalatedAt: null,
    escalationAlertId: null,
    responsesPaused: false,
    resetAt: null,
    resetBy: null,
    hostname: 'host-1',
    displayName: null,
    openSince: null,
    ...overrides,
  };
}

describe('listMonitorDeviceActivity', () => {
  it('prefers displayName over hostname over deviceId for deviceName', async () => {
    state.selectRows = [[activityRow({ displayName: 'Front Desk', hostname: 'host-1' })]];

    const [row] = await listMonitorDeviceActivity(MONITOR, auth());

    expect(row!.deviceName).toBe('Front Desk');
  });

  it('falls back to hostname when displayName is null', async () => {
    state.selectRows = [[activityRow({ displayName: null, hostname: 'host-1' })]];

    const [row] = await listMonitorDeviceActivity(MONITOR, auth());

    expect(row!.deviceName).toBe('host-1');
  });

  it('falls back to deviceId when both displayName and hostname are null', async () => {
    state.selectRows = [[activityRow({ displayName: null, hostname: null })]];

    const [row] = await listMonitorDeviceActivity(MONITOR, auth());

    expect(row!.deviceName).toBe(DEVICE);
  });

  it('maps timestamps to ISO strings', async () => {
    state.selectRows = [[activityRow({ lastEvaluatedAt: new Date('2026-09-13T10:00:00.000Z') })]];

    const [row] = await listMonitorDeviceActivity(MONITOR, auth());

    expect(row!.lastEvaluatedAt).toBe('2026-09-13T10:00:00.000Z');
  });

  it('reports openSince from the left-joined open episode', async () => {
    state.selectRows = [[activityRow({ openSince: new Date('2026-09-13T07:00:00.000Z') })]];

    const [row] = await listMonitorDeviceActivity(MONITOR, auth());

    expect(row!.openSince).toBe('2026-09-13T07:00:00.000Z');
  });

  it('reports openSince null when the left join found no open episode', async () => {
    state.selectRows = [[activityRow({ openSince: null })]];

    const [row] = await listMonitorDeviceActivity(MONITOR, auth());

    expect(row!.openSince).toBeNull();
  });

  it('gates the episode left join on ended_at IS NULL', async () => {
    state.selectRows = [[activityRow()]];

    await listMonitorDeviceActivity(MONITOR, auth());

    expect(state.capturedSql[0]).toMatch(/ended_at"? is null/);
  });
});

function episodeRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'ep-1',
    deviceId: DEVICE,
    orgId: ORG,
    startedAt: new Date('2026-09-12T00:00:00.000Z'),
    endedAt: null,
    endReason: null,
    alertId: null,
    responseRunId: null,
    responseOutcome: null,
    hostname: 'host-1',
    displayName: null,
    ...overrides,
  };
}

describe('listMonitorEpisodes', () => {
  it('orders newest first', async () => {
    state.selectRows = [[episodeRow()]];

    await listMonitorEpisodes(MONITOR, auth(), { limit: 10 });

    expect(state.capturedSql[0]).toMatch(/order by "monitor_episodes"\."started_at" desc/);
  });

  it('issues limit + 1 and does not return the extra row, but sets nextCursor to the LAST RETURNED row', async () => {
    const rows = [
      episodeRow({ id: 'ep-1', startedAt: new Date('2026-09-12T03:00:00.000Z') }),
      episodeRow({ id: 'ep-2', startedAt: new Date('2026-09-12T02:00:00.000Z') }),
      episodeRow({ id: 'ep-3', startedAt: new Date('2026-09-12T01:00:00.000Z') }), // the extra (limit+1) row
    ];
    state.selectRows = [rows];

    const result = await listMonitorEpisodes(MONITOR, auth(), { limit: 2 });

    expect(result.episodes.map((e) => e.id)).toEqual(['ep-1', 'ep-2']);
    expect(result.nextCursor).toBe('2026-09-12T02:00:00.000Z'); // ep-2's startedAt, not ep-3's
    expect(state.capturedParams[0]).toContain(3); // limit + 1 issued to the DB
  });

  it('sets nextCursor to null when there is no extra row', async () => {
    const rows = [
      episodeRow({ id: 'ep-1', startedAt: new Date('2026-09-12T03:00:00.000Z') }),
      episodeRow({ id: 'ep-2', startedAt: new Date('2026-09-12T02:00:00.000Z') }),
    ];
    state.selectRows = [rows];

    const result = await listMonitorEpisodes(MONITOR, auth(), { limit: 2 });

    expect(result.episodes).toHaveLength(2);
    expect(result.nextCursor).toBeNull();
  });

  it('reaches the WHERE with a deviceId filter', async () => {
    state.selectRows = [[episodeRow()]];

    await listMonitorEpisodes(MONITOR, auth(), { limit: 10, deviceId: DEVICE });

    expect(state.capturedSql[0]).toMatch(/"device_id" = \$/);
  });

  it('adds a started_at < bound for a valid cursor', async () => {
    state.selectRows = [[episodeRow()]];

    await listMonitorEpisodes(MONITOR, auth(), { limit: 10, cursor: '2026-09-12T00:00:00.000Z' });

    expect(state.capturedSql[0]).toMatch(/"started_at" < \$/);
  });

  it('ignores an unparseable cursor instead of throwing or adding a bogus bound', async () => {
    state.selectRows = [[episodeRow()]];

    await expect(
      listMonitorEpisodes(MONITOR, auth(), { limit: 10, cursor: 'not-a-real-date' }),
    ).resolves.toBeDefined();

    // The query must actually compile (a bad Date reaching drizzle throws
    // `RangeError: Invalid time value` at bind time, which would surface here
    // as an empty captured string rather than a clean miss of the bound).
    expect(state.capturedSql[0]).not.toBe('');
    expect(state.capturedSql[0]).not.toMatch(/"started_at" < \$/);
  });
});
