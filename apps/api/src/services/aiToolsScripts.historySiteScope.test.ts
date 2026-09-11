import { beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';

vi.mock('../db', () => ({
  runOutsideDbContext: vi.fn((fn: any) => fn()),
  withDbAccessContext: vi.fn(async (_ctx: unknown, fn: () => Promise<unknown>) => fn()),
  withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
  db: { select: vi.fn() },
}));

import { db } from '../db';
import { scriptExecutions } from '../db/schema';
import type { AuthContext } from '../middleware/auth';
import type { AiTool } from './aiTools';
import { registerScriptTools } from './aiToolsScripts';

const SCRIPT_ID = '11111111-1111-4111-8111-111111111111';
const ORG_ID = '22222222-2222-4222-8222-222222222222';
const SITE_ID = '33333333-3333-4333-8333-333333333333';

function tool(): AiTool {
  const tools = new Map<string, AiTool>();
  registerScriptTools(tools);
  return tools.get('get_script_execution_history')!;
}

function auth(allowedSiteIds: string[] | undefined): AuthContext {
  return {
    user: { id: 'u1', email: 'private@example.test', name: 'Private', isPlatformAdmin: false },
    token: {} as any,
    partnerId: null,
    orgId: ORG_ID,
    scope: 'organization',
    accessibleOrgIds: [ORG_ID],
    allowedSiteIds,
    orgCondition: (column: any) => eq(column, ORG_ID),
    canAccessOrg: (id: string) => id === ORG_ID,
    canAccessSite: (id: string | null | undefined) =>
      allowedSiteIds === undefined || (!!id && allowedSiteIds.includes(id)),
  } as unknown as AuthContext;
}

beforeEach(() => vi.clearAllMocks());

describe('get_script_execution_history site projection', () => {
  it('binds execution org and current device site, returning only bounded previews', async () => {
    let executionWhere: unknown;
    vi.mocked(db.select)
      .mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({ limit: vi.fn().mockResolvedValue([{ id: SCRIPT_ID }]) }),
        }),
      } as any)
      .mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          innerJoin: vi.fn().mockReturnValue({
            where: vi.fn((condition) => {
              executionWhere = condition;
              return {
                orderBy: vi.fn().mockReturnValue({
                  limit: vi.fn().mockResolvedValue([{
                    id: 'execution-a',
                    status: 'completed',
                    exitCode: 0,
                    stdout: 'x'.repeat(16_385),
                    stderr: 'y'.repeat(8_193),
                  }]),
                }),
              };
            }),
          }),
        }),
      } as any);

    const result = JSON.parse(await tool().handler({ scriptId: SCRIPT_ID }, auth([SITE_ID])));
    const query = new PgDialect().sqlToQuery(executionWhere as any);

    expect(query.params).toEqual(expect.arrayContaining([SCRIPT_ID, ORG_ID, SITE_ID]));
    expect(query.sql).toContain('script_executions');
    expect(query.sql).toContain('site_id');
    expect(result.executions[0].stdout).toHaveLength(16_384);
    expect(result.executions[0].stderr).toHaveLength(8_192);
    expect(result.executions[0].stdoutTruncated).toBe(true);
    expect(result.executions[0].stderrTruncated).toBe(true);
  });

  it('does not add a site predicate for an unrestricted caller', async () => {
    let executionWhere: unknown;
    vi.mocked(db.select)
      .mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({ limit: vi.fn().mockResolvedValue([{ id: SCRIPT_ID }]) }),
        }),
      } as any)
      .mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          innerJoin: vi.fn().mockReturnValue({
            where: vi.fn((condition) => {
              executionWhere = condition;
              return { orderBy: vi.fn().mockReturnValue({ limit: vi.fn().mockResolvedValue([]) }) };
            }),
          }),
        }),
      } as any);

    await tool().handler({ scriptId: SCRIPT_ID }, auth(undefined));
    const query = new PgDialect().sqlToQuery(executionWhere as any);
    expect(query.params).toEqual(expect.arrayContaining([SCRIPT_ID, ORG_ID]));
    expect(query.params).not.toContain(SITE_ID);
  });
});
