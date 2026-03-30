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

import { db } from '../db';
import type { AuthContext } from '../middleware/auth';
import type { AiTool } from './aiTools';
import { validateToolInput } from './aiToolSchemas';
import { registerSLABackupTools } from './aiToolsSLABackup';

const ORG_ID = '11111111-1111-1111-1111-111111111111';
const DEVICE_ID = '22222222-2222-2222-2222-222222222222';
const CONFIG_ID = '33333333-3333-3333-3333-333333333333';

const EXPECTED_TOOLS = [
  'query_backup_sla',
  'get_sla_breaches',
  'get_sla_compliance_report',
  'configure_backup_sla',
] as const;

const EXPECTED_TIERS: Record<(typeof EXPECTED_TOOLS)[number], number> = {
  query_backup_sla: 1,
  get_sla_breaches: 1,
  get_sla_compliance_report: 1,
  configure_backup_sla: 2,
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
}

function mockSelectSequence(rowsList: any[][]) {
  let index = 0;
  vi.mocked(db.select).mockImplementation(() => createQueryChain(rowsList[index++] ?? []) as any);
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
  registerSLABackupTools(toolMap);
  return toolMap;
}

function prepareHandlerMocks(toolName: string) {
  switch (toolName) {
    case 'query_backup_sla':
      mockSelectSequence([
        [
          {
            id: CONFIG_ID,
            name: 'Gold SLA',
            targetDevices: [DEVICE_ID],
            targetGroups: [],
            isActive: true,
            createdAt: new Date('2026-03-01T00:00:00Z'),
            updatedAt: new Date('2026-03-02T00:00:00Z'),
          },
        ],
        [{ slaConfigId: CONFIG_ID, count: 1 }],
      ]);
      break;
    case 'get_sla_breaches':
      mockSelectSequence([[
        {
          id: 'breach-1',
          slaConfigId: CONFIG_ID,
          slaName: 'Gold SLA',
          deviceId: DEVICE_ID,
          hostname: 'workstation-01',
          eventType: 'missed_backup',
          details: { reason: 'offline' },
          detectedAt: new Date('2026-03-02T00:00:00Z'),
          resolvedAt: null,
        },
      ]]);
      break;
    case 'get_sla_compliance_report':
      mockSelectSequence([
        [{ count: 3 }],
        [{ count: 1 }],
        [{ count: 4 }],
        [{ avgRpo: 30, avgRto: 60 }],
        [{ count: 1 }],
      ]);
      break;
    case 'configure_backup_sla':
      mockSelectSequence([[{ id: CONFIG_ID }]]);
      mockUpdateSequence([[{ id: CONFIG_ID, name: 'Updated SLA' }]]);
      break;
    default:
      mockSelectSequence([[]]);
  }
}

describe('registerSLABackupTools', () => {
  let toolMap: Map<string, AiTool>;

  beforeEach(() => {
    vi.clearAllMocks();
    setDefaultDbMocks();
    toolMap = buildToolMap();
  });

  it('registers all expected SLA backup tools', () => {
    expect(toolMap.size).toBe(EXPECTED_TOOLS.length);
    expect(Array.from(toolMap.keys()).sort()).toEqual([...EXPECTED_TOOLS].sort());
  });

  it.each(Object.entries(EXPECTED_TIERS))('assigns tier %s -> %s', (toolName, tier) => {
    expect(toolMap.get(toolName)!.tier).toBe(tier);
  });

  it.each([
    ['query_backup_sla', { isActive: true, limit: 10 }],
    ['get_sla_breaches', { configId: CONFIG_ID, deviceId: DEVICE_ID, unresolvedOnly: true, from: '2026-03-01T00:00:00Z' }],
    ['get_sla_compliance_report', { daysBack: 30 }],
    ['configure_backup_sla', { action: 'create', name: 'Gold SLA', rpoTargetMinutes: 60, rtoTargetMinutes: 120, targetDevices: [DEVICE_ID] }],
  ])('accepts valid input for %s', (toolName, input) => {
    expect(validateToolInput(toolName, input as Record<string, unknown>)).toEqual({ success: true });
  });

  it.each([
    ['query_backup_sla', { limit: 0 }],
    ['get_sla_breaches', { deviceId: 'not-a-uuid' }],
    ['get_sla_compliance_report', { daysBack: 0 }],
    ['configure_backup_sla', { action: 'create', name: 'Gold SLA' }],
  ])('rejects invalid input for %s', (toolName, input) => {
    const result = validateToolInput(toolName, input as Record<string, unknown>);
    expect(result.success).toBe(false);
  });
});

describe('aiToolsSLABackup handlers', () => {
  let toolMap: Map<string, AiTool>;

  beforeEach(() => {
    vi.clearAllMocks();
    setDefaultDbMocks();
    toolMap = buildToolMap();
  });

  it.each([
    ['query_backup_sla', {}],
    ['get_sla_breaches', {}],
    ['get_sla_compliance_report', {}],
    ['configure_backup_sla', { action: 'update', configId: CONFIG_ID, name: 'Updated SLA' }],
  ])('%s handler returns a JSON string', async (toolName, input) => {
    prepareHandlerMocks(toolName);
    const result = await toolMap.get(toolName)!.handler(input as Record<string, unknown>, makeAuth());
    expect(typeof result).toBe('string');
    expect(() => JSON.parse(result)).not.toThrow();
  });

  it('uses orgCondition for org-scoped SLA queries', async () => {
    prepareHandlerMocks('query_backup_sla');
    const auth = makeAuth();

    await toolMap.get('query_backup_sla')!.handler({}, auth);

    expect(auth.orgCondition).toHaveBeenCalled();
  });

  it('safeHandler returns error JSON when the handler throws', async () => {
    vi.mocked(db.select).mockImplementation(() => {
      throw new Error('boom');
    });

    const result = await toolMap.get('query_backup_sla')!.handler({}, makeAuth());
    const parsed = JSON.parse(result);

    expect(parsed).toEqual({ error: 'Operation failed. Check server logs for details.' });
  });
});
