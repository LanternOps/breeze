import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Coverage for the get_script_execution tier-1 tool (script-editor test loop):
 * single-execution lookup with the script-org condition applied and the site
 * axis enforced after the row loads. The tool exists so the AI can read the
 * output of a run started outside the current tool call (the editor's Test Run
 * button, or an id from get_script_execution_history), so the shape of the
 * returned JSON is part of the contract. It is NOT a recovery path for a
 * run_script that hit its 60s wait: that timeout terminalizes the command row,
 * so the agent's late result loses the CAS in routes/agentWs.ts and never
 * reaches handleScriptResult — stdout/exitCode stay null forever.
 */

vi.mock('../db', () => ({
  runOutsideDbContext: vi.fn((fn: any) => fn()),
  withDbAccessContext: vi.fn(async (_ctx: unknown, fn: () => Promise<unknown>) => fn()),
  withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
  db: { select: vi.fn() },
}));

import { eq } from 'drizzle-orm';
import { db } from '../db';
import { scriptExecutions } from '../db/schema';
import { registerScriptTools } from './aiToolsScripts';
import type { AiTool } from './aiTools';
import type { AuthContext } from '../middleware/auth';

const EXECUTION_ID = '11111111-1111-1111-1111-111111111111';
const SCRIPT_ID = '22222222-2222-2222-2222-222222222222';
const DEVICE_ID = '33333333-3333-3333-3333-333333333333';
const SITE_ID = '44444444-4444-4444-4444-444444444444';

function getTool(): AiTool {
  const map = new Map<string, AiTool>();
  registerScriptTools(map);
  return map.get('get_script_execution')!;
}

function makeAuth(overrides: Partial<Record<'canAccessSite', (siteId: string | null) => boolean>> = {}): AuthContext {
  return {
    user: { id: 'u1', email: 'a@b.c', name: 'A', isPlatformAdmin: false },
    token: {} as any,
    partnerId: null,
    orgId: 'org-1',
    scope: 'organization',
    accessibleOrgIds: ['org-1'],
    orgCondition: () => undefined,
    canAccessOrg: () => true,
    canAccessSite: overrides.canAccessSite ?? (() => true),
  } as unknown as AuthContext;
}

const executionRow = {
  id: EXECUTION_ID,
  scriptId: SCRIPT_ID,
  scriptName: 'Disk cleanup',
  deviceId: DEVICE_ID,
  deviceHostname: 'dev1',
  deviceSiteId: SITE_ID,
  status: 'completed',
  exitCode: 0,
  stdout: 'cleaned 12 files',
  stderr: '',
  errorMessage: null,
  startedAt: '2026-08-15T10:00:00Z',
  completedAt: '2026-08-15T10:00:05Z',
  createdAt: '2026-08-15T10:00:00Z',
};

function mockExecutionRows(rows: unknown[], capturedWhere?: unknown[]) {
  (db.select as ReturnType<typeof vi.fn>).mockReturnValue({
    from: () => ({
      innerJoin: () => ({
        leftJoin: () => ({
          where: (cond: unknown) => {
            capturedWhere?.push(cond);
            return { limit: () => Promise.resolve(rows) };
          },
        }),
      }),
    }),
  });
}

/** Flatten a drizzle SQL condition tree to lowercase text tokens so tests can
 *  assert on actual clause structure instead of vacuously trusting the mock
 *  (a token-scan on the built condition, per the where-clause testing rule). */
function flattenSql(node: unknown, out: string[] = []): string[] {
  if (node == null) return out;
  const anyNode = node as Record<string, unknown>;
  if (Array.isArray(node)) {
    for (const child of node) flattenSql(child, out);
  } else if (Array.isArray(anyNode.queryChunks)) {
    flattenSql(anyNode.queryChunks, out);
  } else if (Array.isArray(anyNode.value)) {
    for (const v of anyNode.value) out.push(String(v).toLowerCase());
  } else if (typeof anyNode.name === 'string') {
    out.push(String(anyNode.name).toLowerCase());
  } else if ('value' in anyNode) {
    out.push(String(anyNode.value).toLowerCase());
  }
  return out;
}

/** Token stream of a condition tree, joined with a separator that cannot occur
 *  inside a column name or a uuid — so `toContain` on it is a contiguous
 *  subsequence check (column adjacent to its bound param), not a loose
 *  "the string appears somewhere" check. */
function sqlTokenText(node: unknown): string {
  return flattenSql(node).join('|');
}

/** The bound parameter values drizzle carries in the clause (drizzle `Param`
 *  nodes surface through flattenSql's `'value' in node` branch). Asserting on
 *  these is what makes a where-clause test non-vacuous: a predicate that was
 *  deleted takes its bound value with it. */
function boundParamValues(node: unknown): string[] {
  return flattenSql(node).filter((t) => /^[0-9a-f-]{36}$/.test(t));
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('get_script_execution', () => {
  it('is registered as tier 1 (read-only, auto-executes)', () => {
    expect(getTool().tier).toBe(1);
  });

  it('returns the execution with output fields and without the internal site id', async () => {
    const captured: unknown[] = [];
    mockExecutionRows([executionRow], captured);
    const result = JSON.parse(await getTool().handler({ executionId: EXECUTION_ID }, makeAuth()));

    // Without an id predicate the query is `.limit(1)` over an unfiltered join
    // and would return an ARBITRARY execution — including another org's, since
    // the org condition is absent on a partner/system session. The clause must
    // therefore BIND the requested id, not merely mention an `id` column.
    expect(boundParamValues(captured[0])).toContain(EXECUTION_ID);
    expect(sqlTokenText(captured[0])).toContain(sqlTokenText(eq(scriptExecutions.id, EXECUTION_ID)));

    expect(result.execution).toMatchObject({
      id: EXECUTION_ID,
      scriptId: SCRIPT_ID,
      scriptName: 'Disk cleanup',
      status: 'completed',
      exitCode: 0,
      stdout: 'cleaned 12 files',
      stderr: '',
      deviceHostname: 'dev1',
    });
    expect(result.execution).not.toHaveProperty('deviceSiteId');
  });

  // Renamed from "...when the org-scoped query matches nothing (cross-org
  // lookup)": this test mocks an empty result set, so it exercises the
  // no-row branch only and says nothing about scoping. The clause itself is
  // asserted by the happy path (executionId binding) and by the org-condition
  // test below; duplicating those here would only re-hide what this covers.
  it('returns "Execution not found" when the query matches no row', async () => {
    mockExecutionRows([]);
    const result = JSON.parse(await getTool().handler({ executionId: EXECUTION_ID }, makeAuth()));

    expect(result.error).toBe('Execution not found');
    expect(result.execution).toBeUndefined();
  });

  it('denies the row when the device is outside the caller site allowlist — same error as not-found', async () => {
    mockExecutionRows([executionRow]);
    const auth = makeAuth({ canAccessSite: (siteId) => siteId !== SITE_ID });
    const result = JSON.parse(await getTool().handler({ executionId: EXECUTION_ID }, auth));

    expect(result.error).toBe('Execution not found');
  });

  it('org condition admits org-less (partner-wide/system) scripts via IS NULL, not a bare org match', async () => {
    const captured: unknown[] = [];
    mockExecutionRows([executionRow], captured);
    const auth = makeAuth();
    // Simulate an org-scoped session: orgCondition returns a real condition.
    (auth as unknown as Record<string, unknown>).orgCondition =
      (col: unknown) => eq(col as Parameters<typeof eq>[0], 'org-1');
    await getTool().handler({ executionId: EXECUTION_ID }, auth);

    const tokens = flattenSql(captured[0]).join(' ');
    // The clause must OR the org match with IS NULL so partner-wide scripts
    // (org_id NULL — the repo default ownership shape) stay readable.
    expect(tokens).toContain('is null');
    expect(tokens).toContain(' or ');
  });

  it('tolerates a deleted device (left join) — output still returned', async () => {
    mockExecutionRows([{ ...executionRow, deviceHostname: null, deviceSiteId: null }]);
    const result = JSON.parse(await getTool().handler({ executionId: EXECUTION_ID }, makeAuth()));

    expect(result.execution.stdout).toBe('cleaned 12 files');
    expect(result.execution.deviceHostname).toBeNull();
  });
});
