import { beforeEach, describe, expect, it, vi } from 'vitest';
import { QueryBuilder } from 'drizzle-orm/pg-core';

/**
 * #5290 — episode state machine unit tests.
 *
 * The fake `tx.select` proxies every chain call onto a REAL drizzle
 * `QueryBuilder`, so `capturedSelectSql` holds the genuinely compiled SQL. That
 * is what makes the `FOR UPDATE` assertion meaningful: a call-shape assertion
 * cannot tell a locking read from a plain one, and the lock is the whole
 * idempotency argument for this service.
 */

interface ChainRecord {
  method: string;
  args: unknown[];
}

const state = vi.hoisted(() => ({
  selectRows: [] as unknown[][],
  insertRows: [] as unknown[][],
  updateRows: [] as unknown[][],
  capturedSelectSql: [] as string[],
  inserts: [] as ChainRecord[][],
  updates: [] as ChainRecord[][],
  /** Date bound values passed to the window query's gte(), in call order. */
  windowCutoffs: [] as Date[],
  /** When set, the NEXT episode insert rejects with this error. */
  insertThrow: null as unknown,
}));

/** Every Date reachable inside a drizzle condition tree, depth-limited. */
function collectDates(node: unknown, depth = 0, seen = new Set<unknown>()): Date[] {
  if (depth > 20 || node === null || typeof node !== 'object') return [];
  if (node instanceof Date) return [node];
  if (seen.has(node)) return [];
  seen.add(node);
  const out: Date[] = [];
  for (const value of Object.values(node as Record<string, unknown>)) {
    out.push(...collectDates(value, depth + 1, seen));
  }
  return out;
}

function makeSelect() {
  return (fields?: unknown) => {
    const qb = new QueryBuilder();
    let real: unknown = fields ? qb.select(fields as never) : qb.select();
    const proxy: unknown = new Proxy(function () {} as unknown as object, {
      get(_t, prop: string) {
        if (prop === 'then') {
          try {
            const compiled = (real as { toSQL(): { sql: string; params: unknown[] } }).toSQL();
            state.capturedSelectSql.push(compiled.sql.toLowerCase());
            // Dates may already be serialised by the time the query compiles,
            // so the cutoff is captured from the `where` condition tree instead
            // (see collectDates below); params are scanned only as a fallback.
            for (const param of compiled.params) {
              if (param instanceof Date) state.windowCutoffs.push(param);
            }
          } catch {
            state.capturedSelectSql.push('');
          }
          const rows = state.selectRows.shift() ?? [];
          return (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) =>
            Promise.resolve(rows).then(res, rej);
        }
        return (...args: unknown[]) => {
          // The window query's only Date bound is its started_at cutoff, so
          // capturing it lets a test assert the cutoff VALUE rather than merely
          // that some cutoff exists.
          if (prop === 'where') for (const d of collectDates(args[0])) state.windowCutoffs.push(d);
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

function makeWriter(sink: ChainRecord[][], rowQueue: unknown[][], throwOnSecond = false) {
  return (..._args: unknown[]) => {
    const calls: ChainRecord[] = [];
    sink.push(calls);
    const isEpisodeInsert = throwOnSecond && sink.length === 2;
    const proxy: unknown = new Proxy(function () {} as unknown as object, {
      get(_t, prop: string) {
        if (prop === 'then') {
          if (isEpisodeInsert && state.insertThrow) {
            const err = state.insertThrow;
            state.insertThrow = null;
            return (_res: (v: unknown) => unknown, rej: (e: unknown) => unknown) =>
              Promise.reject(err).catch(rej);
          }
          const rows = rowQueue.shift() ?? [];
          return (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) =>
            Promise.resolve(rows).then(res, rej);
        }
        return (...args: unknown[]) => {
          calls.push({ method: prop, args });
          return proxy;
        };
      },
    });
    return proxy;
  };
}

const { dbMock } = vi.hoisted(() => ({
  dbMock: {
    transaction: vi.fn(),
    select: vi.fn(),
    insert: vi.fn(),
    update: vi.fn(),
  },
}));

vi.mock('../../db', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../db')>()),
  db: dbMock,
}));

import {
  recordMonitorEvaluation,
  detachMonitorFromDevice,
  linkEpisodeAlert,
  recordEpisodeResponse,
} from './episodeService';
import { monitorEpisodes } from '../../db/schema';

const MONITOR = '11111111-1111-4111-8111-111111111111';
const DEVICE = '22222222-2222-4222-8222-222222222222';
const ORG = '33333333-3333-4333-8333-333333333333';
const EPISODE = '44444444-4444-4444-8444-444444444444';

function tx() {
  return {
    select: makeSelect(),
    insert: makeWriter(state.inserts, state.insertRows, true),
    update: makeWriter(state.updates, state.updateRows),
  };
}

beforeEach(() => {
  state.selectRows = [];
  state.insertRows = [];
  state.updateRows = [];
  state.capturedSelectSql = [];
  state.inserts = [];
  state.updates = [];
  state.windowCutoffs = [];
  state.insertThrow = null;
  dbMock.transaction.mockReset();
  dbMock.transaction.mockImplementation(
    async (cb: (t: ReturnType<typeof tx>) => Promise<unknown>) => cb(tx()),
  );
  // Non-transactional helpers write through the same recorders.
  dbMock.select.mockReset();
  dbMock.insert.mockReset();
  dbMock.update.mockReset();
  dbMock.select.mockImplementation(makeSelect());
  dbMock.insert.mockImplementation(makeWriter(state.inserts, state.insertRows));
  dbMock.update.mockImplementation(makeWriter(state.updates, state.updateRows));
});

function stateRow(overrides: Record<string, unknown> = {}) {
  return {
    monitorId: MONITOR,
    deviceId: DEVICE,
    orgId: ORG,
    currentEpisodeId: null,
    episodesInWindow: 0,
    windowStartedAt: null,
    escalatedAt: null,
    escalationAlertId: null,
    responsesPaused: false,
    resetAt: null,
    resetBy: null,
    lastEvaluatedAt: null,
    lastState: 'unknown',
    ...overrides,
  };
}

function monitor(overrides: Record<string, unknown> = {}) {
  return {
    id: MONITOR,
    recurrenceThreshold: null,
    recurrenceWindowHours: null,
    pauseResponsesOnEscalation: true,
    ...overrides,
  } as never;
}

/** Every `update(...)` chain's `.set(...)` payload, flattened. */
function updateSets(): Record<string, unknown>[] {
  return state.updates
    .map((calls) => calls.find((c) => c.method === 'set')?.args[0])
    .filter((v): v is Record<string, unknown> => !!v);
}

/**
 * Compile the `n`th `update(...)` call's WHERE clause as real SQL, by replaying
 * the captured condition through a standalone `QueryBuilder` SELECT over the
 * same table (a bare builder cannot compile an UPDATE) — same trick as
 * episodeReset.test.ts, adapted for a call-recording (not SQL-compiling)
 * `update` mock.
 */
function compiledUpdateWhereSql(n = 0): string {
  const whereArgs = state.updates[n]?.find((c) => c.method === 'where')?.args[0];
  if (!whereArgs) return '';
  try {
    return new QueryBuilder()
      .select()
      .from(monitorEpisodes)
      .where(whereArgs as never)
      .toSQL()
      .sql.toLowerCase();
  } catch {
    return '';
  }
}

describe('recordMonitorEvaluation', () => {
  it('opens an episode on the first breach and reports episodeOpened', async () => {
    state.selectRows = [[stateRow()]];
    state.insertRows = [[], [{ id: EPISODE, startedAt: new Date() }]];

    const result = await recordMonitorEvaluation({
      monitor: monitor(),
      deviceId: DEVICE,
      orgId: ORG,
      observation: 'breach',
    });

    expect(result.episodeOpened).toBe(true);
    expect(result.episodeId).toBe(EPISODE);
    expect(result.episodeClosed).toBe(false);
  });

  it('does not open a second episode while one is open', async () => {
    state.selectRows = [[stateRow({ currentEpisodeId: EPISODE, lastState: 'breach' })]];
    state.insertRows = [[]];

    const result = await recordMonitorEvaluation({
      monitor: monitor(),
      deviceId: DEVICE,
      orgId: ORG,
      observation: 'breach',
    });

    expect(result.episodeOpened).toBe(false);
    expect(result.episodeId).toBe(EPISODE);
    // Only the upsert insert ran; no episode row was inserted.
    expect(state.inserts).toHaveLength(1);
  });

  it('closes the open episode with end_reason recovered on ok', async () => {
    state.selectRows = [[stateRow({ currentEpisodeId: EPISODE, lastState: 'breach' })]];
    state.insertRows = [[]];

    const result = await recordMonitorEvaluation({
      monitor: monitor(),
      deviceId: DEVICE,
      orgId: ORG,
      observation: 'ok',
    });

    expect(result.episodeClosed).toBe(true);
    expect(result.episodeId).toBeNull();
    const sets = updateSets();
    expect(sets.some((s) => s.endReason === 'recovered' && s.endedAt instanceof Date)).toBe(true);
    expect(sets.some((s) => s.currentEpisodeId === null && s.lastState === 'ok')).toBe(true);
  });

  it('does NOT close an open episode on unknown', async () => {
    state.selectRows = [[stateRow({ currentEpisodeId: EPISODE, lastState: 'breach' })]];
    state.insertRows = [[]];

    const result = await recordMonitorEvaluation({
      monitor: monitor(),
      deviceId: DEVICE,
      orgId: ORG,
      observation: 'unknown',
    });

    expect(result.episodeClosed).toBe(false);
    expect(result.episodeId).toBe(EPISODE);
    expect(updateSets().every((s) => s.endReason === undefined)).toBe(true);
  });

  it('does NOT open an episode on unknown', async () => {
    state.selectRows = [[stateRow()]];
    state.insertRows = [[]];

    const result = await recordMonitorEvaluation({
      monitor: monitor(),
      deviceId: DEVICE,
      orgId: ORG,
      observation: 'unknown',
    });

    expect(result.episodeOpened).toBe(false);
    expect(result.episodeId).toBeNull();
    expect(state.inserts).toHaveLength(1);
    expect(updateSets().some((s) => s.lastState === 'unknown')).toBe(true);
  });

  it('recomputes episodes_in_window from started_at, ignoring episodes older than the window', async () => {
    const now = new Date('2026-09-13T12:00:00Z');
    const oldest = new Date('2026-09-13T02:00:00Z');
    state.selectRows = [
      [stateRow()],
      // The window query is filtered in SQL; these are the rows inside it.
      [{ startedAt: oldest }, { startedAt: new Date('2026-09-13T09:00:00Z') }],
    ];
    state.insertRows = [[], [{ id: EPISODE, startedAt: now }]];

    const result = await recordMonitorEvaluation({
      monitor: monitor({ recurrenceThreshold: 3, recurrenceWindowHours: 24 }),
      deviceId: DEVICE,
      orgId: ORG,
      observation: 'breach',
      now,
    });

    expect(result.episodesInWindow).toBe(2);
    // The count must be bounded in SQL by started_at, not by a client-side filter.
    const windowSql = state.capturedSelectSql[1] ?? '';
    expect(windowSql).toContain('started_at');
    expect(windowSql).toMatch(/>=/);
    expect(updateSets().some((s) => s.windowStartedAt instanceof Date)).toBe(true);
  });

  it('latches when episodes_in_window reaches the threshold', async () => {
    state.selectRows = [
      [stateRow()],
      [{ startedAt: new Date() }, { startedAt: new Date() }, { startedAt: new Date() }],
    ];
    state.insertRows = [[], [{ id: EPISODE, startedAt: new Date() }]];

    const result = await recordMonitorEvaluation({
      monitor: monitor({ recurrenceThreshold: 3, recurrenceWindowHours: 24 }),
      deviceId: DEVICE,
      orgId: ORG,
      observation: 'breach',
    });

    expect(result.latched).toBe(true);
    expect(result.responsesPaused).toBe(true);
    expect(updateSets().some((s) => s.escalatedAt instanceof Date && s.responsesPaused === true)).toBe(true);
  });

  it('does not re-latch when escalated_at is already set', async () => {
    state.selectRows = [
      [stateRow({ escalatedAt: new Date('2026-09-01T00:00:00Z'), responsesPaused: true })],
      [{ startedAt: new Date() }, { startedAt: new Date() }, { startedAt: new Date() }],
    ];
    state.insertRows = [[], [{ id: EPISODE, startedAt: new Date() }]];

    const result = await recordMonitorEvaluation({
      monitor: monitor({ recurrenceThreshold: 3, recurrenceWindowHours: 24 }),
      deviceId: DEVICE,
      orgId: ORG,
      observation: 'breach',
    });

    expect(result.latched).toBe(false);
    expect(result.responsesPaused).toBe(true);
    expect(updateSets().every((s) => s.escalatedAt === undefined)).toBe(true);
  });

  it('never latches when recurrenceThreshold is null', async () => {
    state.selectRows = [[stateRow()]];
    state.insertRows = [[], [{ id: EPISODE, startedAt: new Date() }]];

    const result = await recordMonitorEvaluation({
      monitor: monitor(),
      deviceId: DEVICE,
      orgId: ORG,
      observation: 'breach',
    });

    expect(result.latched).toBe(false);
    expect(result.episodesInWindow).toBe(0);
    // No window query ran: only the locking state read.
    expect(state.capturedSelectSql).toHaveLength(1);
  });

  it('leaves responsesPaused false when pauseResponsesOnEscalation is false', async () => {
    state.selectRows = [
      [stateRow()],
      [{ startedAt: new Date() }, { startedAt: new Date() }],
    ];
    state.insertRows = [[], [{ id: EPISODE, startedAt: new Date() }]];

    const result = await recordMonitorEvaluation({
      monitor: monitor({
        recurrenceThreshold: 2,
        recurrenceWindowHours: 12,
        pauseResponsesOnEscalation: false,
      }),
      deviceId: DEVICE,
      orgId: ORG,
      observation: 'breach',
    });

    expect(result.latched).toBe(true);
    expect(result.responsesPaused).toBe(false);
  });

  it('floors the recurrence window at reset_at, so a reset really does restart it', async () => {
    const now = new Date('2026-09-13T12:00:00Z');
    const resetAt = new Date('2026-09-13T11:00:00Z');
    state.selectRows = [
      [stateRow({ resetAt })],
      // Only the episodes started AFTER the reset come back; the SQL cutoff is
      // what must enforce that, so assert the compiled predicate too.
      [{ startedAt: new Date('2026-09-13T11:30:00Z') }],
    ];
    state.insertRows = [[], [{ id: EPISODE, startedAt: now }]];

    const result = await recordMonitorEvaluation({
      monitor: monitor({ recurrenceThreshold: 3, recurrenceWindowHours: 24 }),
      deviceId: DEVICE,
      orgId: ORG,
      observation: 'breach',
      now,
    });

    // Without the reset floor the 24h cutoff would be 2026-09-12T12:00:00Z and
    // every pre-reset episode would still be counted — re-latching on the very
    // next breach and making the human reset useless.
    expect(state.windowCutoffs[0]?.getTime()).toBe(resetAt.getTime());
    expect(result.episodesInWindow).toBe(1);
    expect(result.latched).toBe(false);
  });

  it('uses the plain window cutoff when the pair has never been reset', async () => {
    const now = new Date('2026-09-13T12:00:00Z');
    state.selectRows = [[stateRow()], [{ startedAt: now }]];
    state.insertRows = [[], [{ id: EPISODE, startedAt: now }]];

    await recordMonitorEvaluation({
      monitor: monitor({ recurrenceThreshold: 3, recurrenceWindowHours: 24 }),
      deviceId: DEVICE,
      orgId: ORG,
      observation: 'breach',
      now,
    });

    expect(state.windowCutoffs[0]?.getTime()).toBe(
      new Date('2026-09-12T12:00:00Z').getTime(),
    );
  });

  it('adopts the concurrent winner\'s episode when the open-episode unique fires', async () => {
    state.selectRows = [[stateRow()], [{ id: EPISODE }]];
    state.insertRows = [[]];
    state.insertThrow = Object.assign(new Error('duplicate key'), { code: '23505' });

    const result = await recordMonitorEvaluation({
      monitor: monitor(),
      deviceId: DEVICE,
      orgId: ORG,
      observation: 'breach',
    });

    // The racing sweep already opened it: adopt, do not throw (an uncaught
    // 23505 inside a request transaction surfaces as a 500).
    expect(result.episodeId).toBe(EPISODE);
    expect(result.episodeOpened).toBe(false);
  });

  it('rethrows an insert error that is NOT a unique violation', async () => {
    state.selectRows = [[stateRow()]];
    state.insertRows = [[]];
    state.insertThrow = Object.assign(new Error('connection lost'), { code: '08006' });

    await expect(
      recordMonitorEvaluation({
        monitor: monitor(),
        deviceId: DEVICE,
        orgId: ORG,
        observation: 'breach',
      }),
    ).rejects.toThrow('connection lost');
  });

  it('reports that the latch needs its alert when escalated_at is set but the alert id is not', async () => {
    state.selectRows = [
      [stateRow({ escalatedAt: new Date('2026-09-13T11:00:00Z'), escalationAlertId: null, responsesPaused: true })],
      [{ startedAt: new Date() }, { startedAt: new Date() }, { startedAt: new Date() }],
    ];
    state.insertRows = [[], [{ id: EPISODE, startedAt: new Date() }]];

    const result = await recordMonitorEvaluation({
      monitor: monitor({ recurrenceThreshold: 3, recurrenceWindowHours: 24 }),
      deviceId: DEVICE,
      orgId: ORG,
      observation: 'breach',
    });

    // Not a re-latch — the state is untouched — but the requires-human alert
    // never got created, so the sweep must retry it.
    expect(result.latched).toBe(false);
    expect(result.needsEscalationAlert).toBe(true);
  });

  it('asks for the escalation alert on a CONTINUING breach too, not just a new episode', async () => {
    // The latch fires as an episode OPENS, so the pair is left with an open
    // episode immediately afterwards. If only the new-episode branch reported
    // needsEscalationAlert, a device stuck in continuous breach whose alert
    // failed would wait for a recover + re-breach before anything retried it.
    state.selectRows = [
      [stateRow({
        currentEpisodeId: EPISODE,
        lastState: 'breach',
        escalatedAt: new Date('2026-09-13T11:00:00Z'),
        escalationAlertId: null,
        responsesPaused: true,
      })],
    ];
    state.insertRows = [[]];

    const result = await recordMonitorEvaluation({
      monitor: monitor({ recurrenceThreshold: 3, recurrenceWindowHours: 24 }),
      deviceId: DEVICE,
      orgId: ORG,
      observation: 'breach',
    });

    expect(result.episodeOpened).toBe(false);
    expect(result.episodeId).toBe(EPISODE);
    expect(result.needsEscalationAlert).toBe(true);
    // Still not a re-latch: the state is untouched.
    expect(result.latched).toBe(false);
    expect(updateSets().every((s) => s.escalatedAt === undefined)).toBe(true);
  });

  it('does not ask for an escalation alert on a continuing breach once one exists', async () => {
    state.selectRows = [
      [stateRow({
        currentEpisodeId: EPISODE,
        lastState: 'breach',
        escalatedAt: new Date(),
        escalationAlertId: 'alert-1',
        responsesPaused: true,
      })],
    ];
    state.insertRows = [[]];

    const result = await recordMonitorEvaluation({
      monitor: monitor({ recurrenceThreshold: 3, recurrenceWindowHours: 24 }),
      deviceId: DEVICE,
      orgId: ORG,
      observation: 'breach',
    });

    expect(result.needsEscalationAlert).toBe(false);
  });

  it('does not ask for an escalation alert once one exists', async () => {
    state.selectRows = [
      [stateRow({ escalatedAt: new Date(), escalationAlertId: 'alert-1', responsesPaused: true })],
      [{ startedAt: new Date() }, { startedAt: new Date() }, { startedAt: new Date() }],
    ];
    state.insertRows = [[], [{ id: EPISODE, startedAt: new Date() }]];

    const result = await recordMonitorEvaluation({
      monitor: monitor({ recurrenceThreshold: 3, recurrenceWindowHours: 24 }),
      deviceId: DEVICE,
      orgId: ORG,
      observation: 'breach',
    });

    expect(result.needsEscalationAlert).toBe(false);
  });

  it('takes FOR UPDATE on the state row before reading it', async () => {
    state.selectRows = [[stateRow()]];
    state.insertRows = [[]];

    await recordMonitorEvaluation({
      monitor: monitor(),
      deviceId: DEVICE,
      orgId: ORG,
      observation: 'ok',
    });

    expect(state.capturedSelectSql[0]).toMatch(/for update/i);
    expect(state.capturedSelectSql[0]).toContain('monitor_device_state');
  });

  it('always writes the DEVICE org onto the upserted state row', async () => {
    state.selectRows = [[stateRow()]];
    state.insertRows = [[]];

    await recordMonitorEvaluation({
      monitor: monitor(),
      deviceId: DEVICE,
      orgId: ORG,
      observation: 'ok',
    });

    const values = state.inserts[0]!.find((c) => c.method === 'values')?.args[0] as Record<
      string,
      unknown
    >;
    expect(values.orgId).toBe(ORG);
    expect(values.deviceId).toBe(DEVICE);
  });
});

describe('detachMonitorFromDevice', () => {
  it('closes the open episode with end_reason monitor_detached and clears current_episode_id', async () => {
    state.updateRows = [[{ id: EPISODE }], []];

    await detachMonitorFromDevice(MONITOR, DEVICE);

    const sets = updateSets();
    expect(sets.some((s) => s.endReason === 'monitor_detached')).toBe(true);
    expect(sets.some((s) => s.currentEpisodeId === null)).toBe(true);
  });

  it('is a no-op when no episode is open', async () => {
    state.updateRows = [[]];

    await detachMonitorFromDevice(MONITOR, DEVICE);

    // Only the episode-close attempt ran; no state write followed it.
    expect(state.updates).toHaveLength(1);
  });
});

describe('linkEpisodeAlert', () => {
  it('stamps the alert id onto the episode', async () => {
    state.updateRows = [[]];

    await linkEpisodeAlert(EPISODE, 'alert-1');

    expect(updateSets()[0]?.alertId).toBe('alert-1');
  });
});

describe('recordEpisodeResponse', () => {
  it('guards a queued write so it cannot walk a terminal outcome backwards', async () => {
    state.updateRows = [[]];

    await recordEpisodeResponse({ monitorId: MONITOR, deviceId: DEVICE, outcome: 'queued' });

    const sql = compiledUpdateWhereSql();
    expect(sql).toContain('response_outcome');
    expect(sql).toMatch(/response_outcome"? is null or .*response_outcome"? = 'queued'/);
  });

  it('does NOT guard a completed write', async () => {
    state.updateRows = [[]];

    await recordEpisodeResponse({ monitorId: MONITOR, deviceId: DEVICE, outcome: 'completed' });

    expect(compiledUpdateWhereSql()).not.toMatch(/is null or/);
  });

  it('does NOT guard a failed write', async () => {
    state.updateRows = [[]];

    await recordEpisodeResponse({ monitorId: MONITOR, deviceId: DEVICE, outcome: 'failed' });

    expect(compiledUpdateWhereSql()).not.toMatch(/is null or/);
  });

  it('writes response_run_id only when runId is provided', async () => {
    state.updateRows = [[]];

    await recordEpisodeResponse({
      monitorId: MONITOR,
      deviceId: DEVICE,
      outcome: 'completed',
      runId: 'run-1',
    });

    expect(updateSets()[0]?.responseRunId).toBe('run-1');
  });

  it('omits response_run_id when runId is not provided', async () => {
    state.updateRows = [[]];

    await recordEpisodeResponse({ monitorId: MONITOR, deviceId: DEVICE, outcome: 'completed' });

    expect(updateSets()[0]).not.toHaveProperty('responseRunId');
  });

  it('scopes the update to the OPEN episode for the (monitor, device) pair', async () => {
    state.updateRows = [[]];

    await recordEpisodeResponse({ monitorId: MONITOR, deviceId: DEVICE, outcome: 'completed' });

    const sql = compiledUpdateWhereSql();
    expect(sql).toMatch(/"monitor_id" = \$/);
    expect(sql).toMatch(/"device_id" = \$/);
    expect(sql).toMatch(/"ended_at" is null/);
  });
});
