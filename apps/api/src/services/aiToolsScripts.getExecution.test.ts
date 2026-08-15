import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Coverage for the get_script_execution tier-1 tool (script-editor test loop):
 * single-execution lookup with the script-org condition applied and the site
 * axis enforced after the row loads. The tool exists so the AI can read a
 * run's output after the user's editor Test Run (or after a run outlives the
 * 60s tool window), so the shape of the returned JSON is part of the contract.
 */

vi.mock('../db', () => ({
  runOutsideDbContext: vi.fn((fn: any) => fn()),
  withDbAccessContext: vi.fn(async (_ctx: unknown, fn: () => Promise<unknown>) => fn()),
  withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
  db: { select: vi.fn() },
}));

import { db } from '../db';
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

function mockExecutionRows(rows: unknown[]) {
  (db.select as ReturnType<typeof vi.fn>).mockReturnValue({
    from: () => ({
      innerJoin: () => ({
        leftJoin: () => ({
          where: () => ({
            limit: () => Promise.resolve(rows),
          }),
        }),
      }),
    }),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('get_script_execution', () => {
  it('is registered as tier 1 (read-only, auto-executes)', () => {
    expect(getTool().tier).toBe(1);
  });

  it('returns the execution with output fields and without the internal site id', async () => {
    mockExecutionRows([executionRow]);
    const result = JSON.parse(await getTool().handler({ executionId: EXECUTION_ID }, makeAuth()));

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

  it('returns "Execution not found" when the org-scoped query matches nothing (cross-org lookup)', async () => {
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

  it('tolerates a deleted device (left join) — output still returned', async () => {
    mockExecutionRows([{ ...executionRow, deviceHostname: null, deviceSiteId: null }]);
    const result = JSON.parse(await getTool().handler({ executionId: EXECUTION_ID }, makeAuth()));

    expect(result.execution.stdout).toBe('cleaned 12 files');
    expect(result.execution.deviceHostname).toBeNull();
  });
});
