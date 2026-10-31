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
import type { AuthContext } from '../middleware/auth';
import type { AiTool } from './aiTools';
import { registerScriptTools } from './aiToolsScripts';
import { toolInputSchemas } from './aiToolSchemas';

/**
 * #10417: "I pushed X to device Y, did it run?" — get_script_execution_history
 * used to require a scriptId, so a per-device question had no read at all.
 * `deviceId` (with an optional `since`) now lists every script run on one
 * device, newest first, with the script name so the model can tell runs apart.
 */

const SCRIPT_ID = '11111111-1111-4111-8111-111111111111';
const ORG_ID = '22222222-2222-4222-8222-222222222222';
const SITE_ID = '33333333-3333-4333-8333-333333333333';
const DEVICE_ID = '44444444-4444-4444-8444-444444444444';

function tool(): AiTool {
  const tools = new Map<string, AiTool>();
  registerScriptTools(tools);
  return tools.get('get_script_execution_history')!;
}

function auth(allowedSiteIds?: string[]): AuthContext {
  return {
    user: { id: 'u1', email: 'tech@example.test', name: 'Tech', isPlatformAdmin: false },
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

/** Mocks the executions query only; captures its WHERE. */
function mockExecutionsQuery(rows: unknown[]): { where: () => unknown } {
  let captured: unknown;
  vi.mocked(db.select).mockReturnValueOnce({
    from: vi.fn().mockReturnValue({
      innerJoin: vi.fn().mockReturnValue({
        leftJoin: vi.fn().mockReturnValue({
          where: vi.fn((condition) => {
            captured = condition;
            return { orderBy: vi.fn().mockReturnValue({ limit: vi.fn().mockResolvedValue(rows) }) };
          }),
        }),
      }),
    }),
  } as any);
  return { where: () => captured };
}

beforeEach(() => vi.clearAllMocks());

describe('get_script_execution_history by device (#10417)', () => {
  it('schema: scriptId is optional and deviceId is gated by the central device check', () => {
    const def = tool();
    const schema = def.definition.input_schema as { required?: string[]; properties: Record<string, unknown> };
    expect(schema.required ?? []).not.toContain('scriptId');
    expect(schema.properties).toHaveProperty('deviceId');
    expect(schema.properties).toHaveProperty('since');
    expect(def.deviceArgs).toEqual(['deviceId']);

    const zod = toolInputSchemas.get_script_execution_history!;
    expect(zod.safeParse({ deviceId: DEVICE_ID }).success).toBe(true);
    expect(zod.safeParse({ deviceId: DEVICE_ID, since: '2026-10-27T00:00:00Z' }).success).toBe(true);
    expect(zod.safeParse({ scriptId: SCRIPT_ID }).success).toBe(true);
    expect(zod.safeParse({}).success).toBe(false);
    expect(zod.safeParse({ deviceId: 'not-a-uuid' }).success).toBe(false);
  });

  it('lists every run on the device without a script lookup, scoped by org, site and device', async () => {
    const q = mockExecutionsQuery([{
      id: 'execution-a',
      scriptId: SCRIPT_ID,
      scriptName: 'Install 7-Zip',
      sourceKind: 'library',
      triggerType: 'manual',
      deviceId: DEVICE_ID,
      status: 'failed',
      exitCode: 1603,
      stdout: '',
      stderr: 'msiexec failed',
      errorMessage: null,
    }]);

    const result = JSON.parse(await tool().handler({ deviceId: DEVICE_ID }, auth([SITE_ID])));
    const query = new PgDialect().sqlToQuery(q.where() as any);

    // One query: the executions read. No `scripts` existence lookup first.
    expect(db.select).toHaveBeenCalledTimes(1);
    expect(query.params).toEqual(expect.arrayContaining([DEVICE_ID, ORG_ID, SITE_ID]));
    expect(query.params).not.toContain(SCRIPT_ID);
    expect(result.count).toBe(1);
    expect(result.executions[0]).toMatchObject({
      id: 'execution-a', scriptName: 'Install 7-Zip', status: 'failed', exitCode: 1603, deviceId: DEVICE_ID,
    });
  });

  it('applies since as a created_at lower bound', async () => {
    const q = mockExecutionsQuery([]);
    await tool().handler({ deviceId: DEVICE_ID, since: '2026-10-27T00:00:00.000Z' }, auth());
    const query = new PgDialect().sqlToQuery(q.where() as any);
    expect(query.sql).toContain('"created_at" >=');
    expect(query.params.some((p) => String(p).startsWith('2026-10-27'))).toBe(true);
  });

  it('rejects a call with neither scriptId nor deviceId, and an unparseable since', async () => {
    const missing = JSON.parse(await tool().handler({}, auth()));
    expect(missing.error).toMatch(/scriptId or deviceId/);
    const badSince = JSON.parse(await tool().handler({ deviceId: DEVICE_ID, since: 'last tuesday' }, auth()));
    expect(badSince.error).toMatch(/since/);
    expect(db.select).not.toHaveBeenCalled();
  });

  it('scriptId + deviceId narrows to that script on that device after the script check', async () => {
    vi.mocked(db.select).mockReturnValueOnce({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({ limit: vi.fn().mockResolvedValue([{ id: SCRIPT_ID }]) }),
      }),
    } as any);
    const q = mockExecutionsQuery([]);
    await tool().handler({ scriptId: SCRIPT_ID, deviceId: DEVICE_ID }, auth());
    const query = new PgDialect().sqlToQuery(q.where() as any);
    expect(query.params).toEqual(expect.arrayContaining([SCRIPT_ID, DEVICE_ID, ORG_ID]));
  });
});
