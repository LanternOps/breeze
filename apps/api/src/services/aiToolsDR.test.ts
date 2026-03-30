import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../db', () => ({
  runOutsideDbContext: vi.fn((fn) => fn()),
  db: {
    select: vi.fn(),
    insert: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
  },
}));

vi.mock('./commandQueue', () => ({
  CommandTypes: {
    VM_RESTORE_FROM_BACKUP: 'vm_restore_from_backup',
    VM_INSTANT_BOOT: 'vm_instant_boot',
    HYPERV_RESTORE: 'hyperv_restore',
    MSSQL_RESTORE: 'mssql_restore',
    BMR_RECOVER: 'bmr_recover',
  },
  queueCommandForExecution: vi.fn(),
}));

import { db } from '../db';
import type { AuthContext } from '../middleware/auth';
import type { AiTool } from './aiTools';
import { validateToolInput } from './aiToolSchemas';
import { queueCommandForExecution } from './commandQueue';
import { registerDRTools } from './aiToolsDR';

const ORG_ID = '11111111-1111-1111-1111-111111111111';
const PLAN_ID = '22222222-2222-2222-2222-222222222222';
const GROUP_ID = '33333333-3333-3333-3333-333333333333';
const EXECUTION_ID = '44444444-4444-4444-4444-444444444444';
const DEVICE_ID = '55555555-5555-5555-5555-555555555555';

const EXPECTED_TOOLS = [
  'query_dr_plans',
  'get_dr_plan_details',
  'get_dr_execution_status',
  'execute_dr_plan',
  'manage_dr_plan',
] as const;

const EXPECTED_TIERS: Record<(typeof EXPECTED_TOOLS)[number], number> = {
  query_dr_plans: 1,
  get_dr_plan_details: 1,
  get_dr_execution_status: 1,
  execute_dr_plan: 3,
  manage_dr_plan: 2,
};

function createQueryChain(rows: any[] = []) {
  const chain: any = {};
  chain.from = vi.fn(() => chain);
  chain.leftJoin = vi.fn(() => chain);
  chain.where = vi.fn(() => chain);
  chain.groupBy = vi.fn(() => chain);
  chain.orderBy = vi.fn(() => chain);
  chain.limit = vi.fn(() => chain);
  chain.offset = vi.fn(() => chain);
  chain.then = (resolve: (value: any[]) => unknown, reject?: (error: unknown) => unknown) =>
    Promise.resolve(rows).then(resolve, reject);
  return chain;
}

function createInsertChain(rows: any[] = []) {
  const chain: any = {};
  chain.values = vi.fn(() => chain);
  chain.returning = vi.fn(() => Promise.resolve(rows));
  chain.onConflictDoNothing = vi.fn(() => Promise.resolve());
  return chain;
}

function createUpdateChain(rows: any[] = []) {
  const chain: any = {};
  chain.set = vi.fn(() => chain);
  chain.where = vi.fn(() => chain);
  chain.returning = vi.fn(() => Promise.resolve(rows));
  chain.then = (resolve: (value: any[]) => unknown, reject?: (error: unknown) => unknown) =>
    Promise.resolve(rows).then(resolve, reject);
  return chain;
}

function createDeleteChain(rows: any[] = []) {
  const chain: any = {};
  chain.where = vi.fn(() => chain);
  chain.then = (resolve: (value: any[]) => unknown, reject?: (error: unknown) => unknown) =>
    Promise.resolve(rows).then(resolve, reject);
  return chain;
}

function setDefaultDbMocks() {
  vi.mocked(db.select).mockImplementation(() => createQueryChain([]) as any);
  vi.mocked(db.insert).mockImplementation(() => createInsertChain([]) as any);
  vi.mocked(db.update).mockImplementation(() => createUpdateChain([]) as any);
  vi.mocked(db.delete).mockImplementation(() => createDeleteChain([]) as any);
  vi.mocked(queueCommandForExecution).mockResolvedValue({
    command: { id: 'cmd-1', status: 'queued' },
    error: null,
  } as any);
}

function mockSelectSequence(rowsList: any[][]) {
  let index = 0;
  vi.mocked(db.select).mockImplementation(() => createQueryChain(rowsList[index++] ?? []) as any);
}

function mockInsertSequence(rowsList: any[][]) {
  let index = 0;
  vi.mocked(db.insert).mockImplementation(() => createInsertChain(rowsList[index++] ?? []) as any);
}

function mockUpdateSequence(rowsList: any[][]) {
  let index = 0;
  vi.mocked(db.update).mockImplementation(() => createUpdateChain(rowsList[index++] ?? []) as any);
}

function makeAuth(): AuthContext {
  return {
    user: { id: 'user-1', email: 'test@example.com', name: 'Test User' },
    token: {} as any,
    partnerId: null,
    orgId: ORG_ID,
    scope: 'organization',
    accessibleOrgIds: [ORG_ID],
    canAccessOrg: (orgId: string) => orgId === ORG_ID,
    orgCondition: vi.fn(() => undefined),
  } as any;
}

function buildToolMap(): Map<string, AiTool> {
  const toolMap = new Map<string, AiTool>();
  registerDRTools(toolMap);
  return toolMap;
}

function prepareHandlerMocks(toolName: string) {
  const planRow = {
    id: PLAN_ID,
    orgId: ORG_ID,
    name: 'Primary DR Plan',
    description: 'Main failover plan',
    status: 'active',
    rpoTargetMinutes: 15,
    rtoTargetMinutes: 60,
    createdBy: 'user-1',
    createdAt: new Date('2026-03-01T00:00:00Z'),
    updatedAt: new Date('2026-03-02T00:00:00Z'),
  };
  const groupRow = {
    id: GROUP_ID,
    name: 'Group A',
    sequence: 1,
    devices: [DEVICE_ID],
    restoreConfig: {
      commandType: 'vm_restore_from_backup',
      payload: { snapshotId: 'snapshot-1' },
    },
    estimatedDurationMinutes: 20,
  };

  switch (toolName) {
    case 'query_dr_plans':
      mockSelectSequence([[
        {
          ...planRow,
          groupCount: 1,
        },
      ]]);
      break;
    case 'get_dr_plan_details':
      mockSelectSequence([[planRow], [groupRow]]);
      break;
    case 'get_dr_execution_status':
      mockSelectSequence([
        [{
          id: EXECUTION_ID,
          planId: PLAN_ID,
          orgId: ORG_ID,
          executionType: 'rehearsal',
          status: 'pending',
          results: {},
          startedAt: new Date('2026-03-02T00:00:00Z'),
          completedAt: null,
          initiatedBy: 'user-1',
          createdAt: new Date('2026-03-02T00:00:00Z'),
        }],
        [planRow],
        [groupRow],
      ]);
      break;
    case 'execute_dr_plan':
      mockSelectSequence([[planRow], [groupRow]]);
      mockInsertSequence([[{ id: EXECUTION_ID, status: 'pending' }]]);
      mockUpdateSequence([[{ id: EXECUTION_ID, status: 'pending' }]]);
      break;
    case 'manage_dr_plan':
      mockSelectSequence([[planRow]]);
      mockUpdateSequence([[{ ...planRow, name: 'Updated DR Plan' }]]);
      break;
    default:
      mockSelectSequence([[]]);
  }
}

describe('registerDRTools', () => {
  let toolMap: Map<string, AiTool>;

  beforeEach(() => {
    vi.clearAllMocks();
    setDefaultDbMocks();
    toolMap = buildToolMap();
  });

  it('registers all expected DR tools', () => {
    expect(toolMap.size).toBe(EXPECTED_TOOLS.length);
    expect(Array.from(toolMap.keys()).sort()).toEqual([...EXPECTED_TOOLS].sort());
  });

  it.each(Object.entries(EXPECTED_TIERS))('assigns tier %s -> %s', (toolName, tier) => {
    expect(toolMap.get(toolName)!.tier).toBe(tier);
  });

  it.each([
    ['query_dr_plans', { status: 'active', limit: 10 }],
    ['get_dr_plan_details', { planId: PLAN_ID }],
    ['get_dr_execution_status', { executionId: EXECUTION_ID }],
    ['execute_dr_plan', { planId: PLAN_ID, executionType: 'rehearsal' }],
    ['manage_dr_plan', { action: 'create_plan', name: 'Primary DR Plan', rpoTargetMinutes: 15, rtoTargetMinutes: 60 }],
  ])('accepts valid input for %s', (toolName, input) => {
    expect(validateToolInput(toolName, input as Record<string, unknown>)).toEqual({ success: true });
  });

  it.each([
    ['query_dr_plans', { status: 'invalid' }],
    ['get_dr_plan_details', {}],
    ['get_dr_execution_status', { executionId: 'not-a-uuid' }],
    ['execute_dr_plan', { planId: PLAN_ID }],
    ['manage_dr_plan', { action: 'add_group' }],
  ])('rejects invalid input for %s', (toolName, input) => {
    const result = validateToolInput(toolName, input as Record<string, unknown>);
    expect(result.success).toBe(false);
  });
});

describe('aiToolsDR handlers', () => {
  let toolMap: Map<string, AiTool>;

  beforeEach(() => {
    vi.clearAllMocks();
    setDefaultDbMocks();
    toolMap = buildToolMap();
  });

  it.each([
    ['query_dr_plans', {}],
    ['get_dr_plan_details', { planId: PLAN_ID }],
    ['get_dr_execution_status', { executionId: EXECUTION_ID }],
    ['execute_dr_plan', { planId: PLAN_ID, executionType: 'rehearsal' }],
    ['manage_dr_plan', { action: 'update_plan', planId: PLAN_ID, name: 'Updated DR Plan' }],
  ])('%s handler returns a JSON string', async (toolName, input) => {
    prepareHandlerMocks(toolName);
    const result = await toolMap.get(toolName)!.handler(input as Record<string, unknown>, makeAuth());
    expect(typeof result).toBe('string');
    expect(() => JSON.parse(result)).not.toThrow();
  });

  it('uses orgCondition for org-scoped DR queries', async () => {
    prepareHandlerMocks('query_dr_plans');
    const auth = makeAuth();

    await toolMap.get('query_dr_plans')!.handler({}, auth);

    expect(auth.orgCondition).toHaveBeenCalled();
  });

  it('safeHandler returns error JSON when the handler throws', async () => {
    vi.mocked(db.select).mockImplementation(() => {
      throw new Error('boom');
    });

    const result = await toolMap.get('query_dr_plans')!.handler({}, makeAuth());
    const parsed = JSON.parse(result);

    expect(parsed).toEqual({ error: 'Operation failed. Check server logs for details.' });
  });
});
