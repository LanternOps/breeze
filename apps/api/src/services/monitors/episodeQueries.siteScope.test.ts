/**
 * Audit 2026-09-17 §1.1 — both episode read models applied `deviceScopeCondition`
 * and NOTHING else, so `get_monitor_activity` (whose `deviceId` is optional, and
 * therefore un-gated by `enforceDeviceArgs` on exactly the call that omits it)
 * handed a site-restricted technician every device's breach/escalation state and
 * full episode history for a monitor, org-wide.
 *
 * The site axis is applied in SQL against the JOINED `devices.site_id`, so it
 * costs a site-restricted caller no extra query and an unrestricted caller
 * nothing at all. Same real-QueryBuilder capture as episodeQueries.test.ts: the
 * assertions are on genuinely compiled SQL + bound params.
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
const SITE_A = '44444444-4444-4444-8444-444444444444';

/** A HUMAN technician: `canAccessSite` is ALWAYS defined; a site-restricted one
 *  never carries `allowedDeviceIds`. */
function human(allowedSiteIds?: string[]): AuthContext {
  return {
    orgCondition: () => undefined,
    allowedSiteIds,
    canAccessSite: (s: string | null | undefined) => (!allowedSiteIds ? true : !!s && allowedSiteIds.includes(s)),
  } as unknown as AuthContext;
}

/** A device-bound agent run: exact devices, NO site axis. */
function agentRun(allowedDeviceIds: string[]): AuthContext {
  return { orgCondition: () => undefined, allowedDeviceIds } as unknown as AuthContext;
}

beforeEach(() => {
  state.selectRows = [];
  state.capturedSql = [];
  state.capturedParams = [];
  dbMock.select.mockReset();
  dbMock.select.mockImplementation(makeSelect());
});

describe('listMonitorDeviceActivity — site axis', () => {
  it('binds devices.site_id to the allowlist for a site-restricted human', async () => {
    await listMonitorDeviceActivity(MONITOR, human([SITE_A]));
    expect(state.capturedSql[0]).toContain('"site_id"');
    expect(state.capturedParams[0]).toContain(SITE_A);
  });

  it('adds NO site predicate for an unrestricted human', async () => {
    await listMonitorDeviceActivity(MONITOR, human(undefined));
    expect(state.capturedSql[0]).not.toContain('"site_id"');
  });

  it('leaves the exact-device axis alone for a device-bound agent run (no site predicate)', async () => {
    await listMonitorDeviceActivity(MONITOR, agentRun([DEVICE]));
    expect(state.capturedSql[0]).not.toContain('"site_id"');
    expect(state.capturedParams[0]).toContain(DEVICE);
  });
});

describe('listMonitorEpisodes — site axis', () => {
  it('binds devices.site_id to the allowlist for a site-restricted human with NO deviceId', async () => {
    await listMonitorEpisodes(MONITOR, human([SITE_A]), { limit: 10 });
    expect(state.capturedSql[0]).toContain('"site_id"');
    expect(state.capturedParams[0]).toContain(SITE_A);
  });

  it('still binds the site allowlist when a deviceId filter IS supplied (filter is not a bound)', async () => {
    await listMonitorEpisodes(MONITOR, human([SITE_A]), { deviceId: DEVICE, limit: 10 });
    expect(state.capturedParams[0]).toContain(SITE_A);
    expect(state.capturedParams[0]).toContain(DEVICE);
  });

  it('adds NO site predicate for an unrestricted human', async () => {
    await listMonitorEpisodes(MONITOR, human(undefined), { limit: 10 });
    expect(state.capturedSql[0]).not.toContain('"site_id"');
  });

  it('leaves the exact-device axis alone for a device-bound agent run (no site predicate)', async () => {
    await listMonitorEpisodes(MONITOR, agentRun([DEVICE]), { limit: 10 });
    expect(state.capturedSql[0]).not.toContain('"site_id"');
    expect(state.capturedParams[0]).toContain(DEVICE);
  });
});
