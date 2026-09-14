/**
 * #5290 — the human reset that clears a recurrence escalation.
 *
 * The update is asserted through its COMPILED SQL as well as its `set` payload:
 * the `escalated_at IS NOT NULL` guard is what makes the "was never escalated"
 * case report `{ reset: false }` instead of silently stamping reset_at on a
 * healthy pair, and a payload-only assertion cannot see a WHERE clause.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { QueryBuilder } from 'drizzle-orm/pg-core';

const state = vi.hoisted(() => ({
  updateRows: [] as unknown[][],
  capturedSets: [] as Record<string, unknown>[],
  capturedSql: [] as string[],
}));

function makeUpdate() {
  return (table: unknown) => {
    const qb = new QueryBuilder();
    let real: unknown = null;
    try {
      // A standalone builder cannot compile an UPDATE, so compile an equivalent
      // SELECT over the same table to capture the WHERE clause text.
      real = qb.select().from(table as never);
    } catch {
      real = null;
    }
    const proxy: unknown = new Proxy(function () {} as unknown as object, {
      get(_t, prop: string) {
        if (prop === 'then') {
          try {
            state.capturedSql.push(
              (real as { toSQL(): { sql: string } }).toSQL().sql.toLowerCase(),
            );
          } catch {
            state.capturedSql.push('');
          }
          const rows = state.updateRows.shift() ?? [];
          return (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) =>
            Promise.resolve(rows).then(res, rej);
        }
        return (...args: unknown[]) => {
          if (prop === 'set') state.capturedSets.push(args[0] as Record<string, unknown>);
          if (prop === 'where' && real) {
            try {
              real = (real as { where(a: unknown): unknown }).where(args[0]);
            } catch {
              /* ignore */
            }
          }
          return proxy;
        };
      },
    });
    return proxy;
  };
}

const { dbMock } = vi.hoisted(() => ({ dbMock: { update: vi.fn() } }));

vi.mock('../../db', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../db')>()),
  db: dbMock,
}));

import { resetMonitorEscalation } from './episodeReset';
import type { AuthContext } from '../../middleware/auth';

const MONITOR = '11111111-1111-4111-8111-111111111111';
const DEVICE = '22222222-2222-4222-8222-222222222222';

function auth(): AuthContext {
  return {
    user: { id: 'user-1' },
    orgCondition: () => undefined,
  } as unknown as AuthContext;
}

beforeEach(() => {
  state.updateRows = [];
  state.capturedSets = [];
  state.capturedSql = [];
  dbMock.update.mockReset();
  dbMock.update.mockImplementation(makeUpdate());
});

describe('resetMonitorEscalation', () => {
  it('clears escalated_at, escalation_alert_id and responses_paused', async () => {
    state.updateRows = [[{ monitorId: MONITOR }]];

    await resetMonitorEscalation({ monitorId: MONITOR, deviceId: DEVICE, auth: auth() });

    const set = state.capturedSets[0]!;
    expect(set.escalatedAt).toBeNull();
    expect(set.escalationAlertId).toBeNull();
    expect(set.responsesPaused).toBe(false);
  });

  it('zeroes the window and clears window_started_at', async () => {
    state.updateRows = [[{ monitorId: MONITOR }]];

    await resetMonitorEscalation({ monitorId: MONITOR, deviceId: DEVICE, auth: auth() });

    const set = state.capturedSets[0]!;
    expect(set.episodesInWindow).toBe(0);
    expect(set.windowStartedAt).toBeNull();
  });

  it('records reset_at and reset_by from the auth context', async () => {
    state.updateRows = [[{ monitorId: MONITOR }]];

    await resetMonitorEscalation({ monitorId: MONITOR, deviceId: DEVICE, auth: auth() });

    const set = state.capturedSets[0]!;
    expect(set.resetAt).toBeInstanceOf(Date);
    expect(set.resetBy).toBe('user-1');
  });

  it('does NOT close the open episode and does not touch the alert', async () => {
    state.updateRows = [[{ monitorId: MONITOR }]];

    await resetMonitorEscalation({ monitorId: MONITOR, deviceId: DEVICE, auth: auth() });

    // Exactly one write, and it is on monitor_device_state.
    expect(state.capturedSets).toHaveLength(1);
    expect(state.capturedSets[0]).not.toHaveProperty('currentEpisodeId');
    expect(state.capturedSets[0]).not.toHaveProperty('endedAt');
    expect(state.capturedSql[0]).toContain('monitor_device_state');
  });

  it('guards the update on escalated_at IS NOT NULL', async () => {
    state.updateRows = [[{ monitorId: MONITOR }]];

    await resetMonitorEscalation({ monitorId: MONITOR, deviceId: DEVICE, auth: auth() });

    expect(state.capturedSql[0]).toMatch(/escalated_at"? is not null/i);
  });

  it('returns { reset: false } when the pair was never escalated', async () => {
    state.updateRows = [[]];

    const result = await resetMonitorEscalation({
      monitorId: MONITOR,
      deviceId: DEVICE,
      auth: auth(),
    });

    expect(result).toEqual({ reset: false });
  });

  it('returns { reset: true } when a row was cleared', async () => {
    state.updateRows = [[{ monitorId: MONITOR }]];

    const result = await resetMonitorEscalation({
      monitorId: MONITOR,
      deviceId: DEVICE,
      auth: auth(),
    });

    expect(result).toEqual({ reset: true });
  });
});
