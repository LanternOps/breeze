import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../db', () => ({
  runOutsideDbContext: vi.fn((fn: any) => fn()),
  withDbAccessContext: vi.fn(async (_ctx: unknown, fn: () => Promise<unknown>) => fn()),
  withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
  db: { select: vi.fn(), insert: vi.fn(), update: vi.fn(), delete: vi.fn(), transaction: vi.fn() },
}));
vi.mock('../jobs/cisJobs', () => ({ scheduleCisRemediationWithResult: vi.fn() }));
vi.mock('./cisHardening', () => ({ extractFailedCheckIds: vi.fn(() => new Set()) }));

import { db } from '../db';
import { registerCisBenchmarkTools } from './aiToolsCisBenchmark';
import { compactToolResultForChat } from './aiToolOutput';
import { GENERIC_TOOL_ERROR_MESSAGE } from './aiToolErrors';
import type { AuthContext } from '../middleware/auth';
import type { AiTool } from './aiTools';

const mockDb = db as unknown as { select: ReturnType<typeof vi.fn> };

function handlerFor(name: string): AiTool['handler'] {
  const reg = new Map<string, AiTool>();
  registerCisBenchmarkTools(reg);
  return reg.get(name)!.handler;
}

function makeAuth(): AuthContext {
  return {
    user: { id: 'u1', email: 'a@b.c', name: 'A', isPlatformAdmin: false },
    token: {} as any,
    partnerId: null,
    orgId: 'org-1',
    scope: 'organization',
    accessibleOrgIds: ['org-1'],
    orgCondition: () => undefined,
    canAccessOrg: () => true,
    allowedSiteIds: undefined,
    canAccessSite: () => true,
  } as unknown as AuthContext;
}

function chain(result: unknown): any {
  const p: any = Promise.resolve(result);
  for (const m of ['from', 'innerJoin', 'leftJoin', 'where', 'orderBy', 'limit', 'groupBy', 'offset', 'as']) {
    p[m] = () => p;
  }
  return p;
}

/**
 * Resolve the name a selection field will take in the emitted SQL:
 * a bare Drizzle column keeps its DB column name; `sql\`…\`.as('x')` uses `x`.
 */
function outputNameOf(field: unknown): string | null {
  if (!field || typeof field !== 'object') return null;
  const f = field as Record<string, unknown>;
  if (typeof f.fieldAlias === 'string') return f.fieldAlias;
  if (typeof f.name === 'string') return f.name;
  return null;
}

describe('get_cis_compliance', () => {
  beforeEach(() => vi.clearAllMocks());

  /**
   * Regression for #2603. Drizzle names a subquery's output columns after the
   * underlying DB column, so selecting both `cis_baselines.os_type` and
   * `devices.os_type` emitted TWO columns named "os_type". The outer SELECT then
   * failed with `column reference "os_type" is ambiguous` (42702) on EVERY call,
   * with or without CIS data — which is what produced the raw-SQL chat error.
   */
  it('builds the ranked subquery with unique output column names', async () => {
    const selections: unknown[] = [];
    mockDb.select.mockImplementation((cols?: unknown) => {
      if (cols) selections.push(cols);
      return chain([]);
    });

    await handlerFor('get_cis_compliance')({}, makeAuth());

    const ranked = selections.find(
      (cols) => !!cols && typeof cols === 'object' && 'rn' in (cols as object),
    ) as Record<string, unknown> | undefined;
    expect(ranked, 'ranked subquery selection should have been built').toBeDefined();

    const names = Object.values(ranked!)
      .map(outputNameOf)
      .filter((n): n is string => n !== null);

    expect(names.length).toBeGreaterThan(5);
    expect(new Set(names).size, `duplicate output columns: ${names.join(', ')}`).toBe(names.length);

    // The two that actually collided must now be explicitly disambiguated.
    expect(names).toContain('baseline_os_type');
    expect(names).toContain('device_os_type');
  });

  it('returns a graceful empty result when the stack has no CIS data', async () => {
    let call = 0;
    mockDb.select.mockImplementation(() => {
      call += 1;
      if (call === 1) return chain(null); // ranked subquery -> .as()
      if (call === 2) return chain([{ total: 0, averageScore: 100, failingDevices: 0 }]);
      return chain([]); // no rows
    });

    const parsed = JSON.parse(await handlerFor('get_cis_compliance')({}, makeAuth()));

    expect(parsed.error).toBeUndefined();
    expect(parsed.message).toBe('No CIS compliance data available yet');
    expect(parsed.count).toBe(0);
    expect(parsed.totalMatched).toBe(0);
    expect(parsed.results).toEqual([]);
    expect(parsed.summary).toEqual({
      averageScore: 100,
      devicesAudited: 0,
      failingDevices: 0,
      compliantDevices: 0,
    });
  });

  it('still returns real results when CIS data exists', async () => {
    let call = 0;
    mockDb.select.mockImplementation(() => {
      call += 1;
      if (call === 1) return chain(null);
      if (call === 2) return chain([{ total: 1, averageScore: 50, failingDevices: 1 }]);
      return chain([
        {
          orgId: 'org-1', baselineId: 'b1', baselineName: 'CIS', baselineBenchmarkVersion: '1',
          baselineLevel: 1, baselineIsActive: true, baselineOsType: 'windows', deviceId: 'd1',
          deviceHostname: 'h1', deviceStatus: 'online', deviceOsType: 'windows',
          checkedAt: new Date(), score: 50, totalChecks: 10, passedChecks: 5, failedChecks: 5, summary: {},
        },
      ]);
    });

    const parsed = JSON.parse(await handlerFor('get_cis_compliance')({}, makeAuth()));

    expect(parsed.message).toBeUndefined();
    expect(parsed.count).toBe(1);
    expect(parsed.results[0].hostname).toBe('h1');
  });

  /**
   * The second half of #2603: even if a tool does throw, the raw driver text must
   * not reach the chat. Every tool result passes through compactToolResultForChat,
   * which is where the scrub is wired.
   */
  it('never streams the raw Drizzle error text to the chat', () => {
    const rawDriverError =
      'Failed query: select "org_id", "baseline_id", "name", "benchmark_version", "level", ' +
      '"is_active", "os_type", "device_id", "hostname", "status", "os_type", "checked_at" ' +
      'from (select "cis_baseline_results"."id" ...) "ranked_cis_tool_results" where "rn" = $1';

    const streamed = compactToolResultForChat(
      'get_cis_compliance',
      JSON.stringify({ error: rawDriverError }),
    );

    expect(JSON.parse(streamed).error).toBe(GENERIC_TOOL_ERROR_MESSAGE);
    // No fragment of the query or schema survives into the stream.
    for (const leak of [
      'Failed query',
      'benchmark_version',
      'cis_baseline_results',
      'ranked_cis_tool_results',
      'org_id',
      'select "',
    ]) {
      expect(streamed).not.toContain(leak);
    }
  });
});
