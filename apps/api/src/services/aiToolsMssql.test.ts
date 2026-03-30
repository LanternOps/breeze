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
    MSSQL_BACKUP: 'mssql_backup',
    MSSQL_RESTORE: 'mssql_restore',
    MSSQL_VERIFY: 'mssql_verify',
  },
  queueCommandForExecution: vi.fn(),
}));

import { db } from '../db';
import type { AuthContext } from '../middleware/auth';
import type { AiTool } from './aiTools';
import { validateToolInput } from './aiToolSchemas';
import { queueCommandForExecution } from './commandQueue';
import { registerMssqlTools } from './aiToolsMssql';

const ORG_ID = '11111111-1111-1111-1111-111111111111';
const DEVICE_ID = '22222222-2222-2222-2222-222222222222';
const CONFIG_ID = '33333333-3333-3333-3333-333333333333';
const SNAPSHOT_ID = '44444444-4444-4444-4444-444444444444';

const EXPECTED_TOOLS = [
  'query_mssql_instances',
  'get_mssql_backup_status',
  'trigger_mssql_backup',
  'restore_mssql_database',
  'verify_mssql_backup',
] as const;

const EXPECTED_TIERS: Record<(typeof EXPECTED_TOOLS)[number], number> = {
  query_mssql_instances: 1,
  get_mssql_backup_status: 1,
  trigger_mssql_backup: 3,
  restore_mssql_database: 3,
  verify_mssql_backup: 2,
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
  registerMssqlTools(toolMap);
  return toolMap;
}

function prepareHandlerMocks(toolName: string) {
  switch (toolName) {
    case 'query_mssql_instances':
      mockSelectSequence([[
        {
          id: 'instance-1',
          deviceId: DEVICE_ID,
          hostname: 'sql-host-01',
          instanceName: 'MSSQLSERVER',
          version: '2022',
          edition: 'Standard',
          port: 1433,
          authType: 'windows',
          status: 'healthy',
          databases: ['master'],
          lastDiscoveredAt: new Date('2026-03-01T00:00:00Z'),
          createdAt: new Date('2026-03-01T00:00:00Z'),
          updatedAt: new Date('2026-03-02T00:00:00Z'),
        },
      ]]);
      break;
    case 'get_mssql_backup_status':
      mockSelectSequence([[
        {
          id: 'chain-1',
          deviceId: DEVICE_ID,
          hostname: 'sql-host-01',
          configId: CONFIG_ID,
          configName: 'Nightly SQL',
          targetName: 'AppDb',
          targetId: 'db-1',
          isActive: true,
          fullSnapshotId: SNAPSHOT_ID,
          fullSnapshotLabel: 'full-1',
          fullSnapshotTimestamp: new Date('2026-03-01T00:00:00Z'),
          chainMetadata: { health: 'active', lastBackupAt: '2026-03-01T00:00:00Z' },
          createdAt: new Date('2026-03-01T00:00:00Z'),
          updatedAt: new Date('2026-03-02T00:00:00Z'),
        },
      ]]);
      break;
    case 'trigger_mssql_backup':
      mockSelectSequence([[{ id: DEVICE_ID }]]);
      break;
    case 'restore_mssql_database':
      mockSelectSequence([[{ id: DEVICE_ID }]]);
      break;
    case 'verify_mssql_backup':
      mockSelectSequence([[{ id: DEVICE_ID }]]);
      break;
    default:
      mockSelectSequence([[]]);
  }
}

describe('registerMssqlTools', () => {
  let toolMap: Map<string, AiTool>;

  beforeEach(() => {
    vi.clearAllMocks();
    setDefaultDbMocks();
    toolMap = buildToolMap();
  });

  it('registers all expected MSSQL tools', () => {
    expect(toolMap.size).toBe(EXPECTED_TOOLS.length);
    expect(Array.from(toolMap.keys()).sort()).toEqual([...EXPECTED_TOOLS].sort());
  });

  it.each(Object.entries(EXPECTED_TIERS))('assigns tier %s -> %s', (toolName, tier) => {
    expect(toolMap.get(toolName)!.tier).toBe(tier);
  });

  it.each([
    ['query_mssql_instances', { deviceId: DEVICE_ID, status: 'ready', limit: 10 }],
    ['get_mssql_backup_status', { deviceId: DEVICE_ID, database: 'AppDb', limit: 10 }],
    ['trigger_mssql_backup', { deviceId: DEVICE_ID, instance: 'MSSQLSERVER', database: 'AppDb', outputPath: '/tmp/appdb.bak' }],
    ['restore_mssql_database', { deviceId: DEVICE_ID, instance: 'MSSQLSERVER', backupFile: '/tmp/appdb.bak', targetDatabase: 'RestoredDb' }],
    ['verify_mssql_backup', { snapshotId: SNAPSHOT_ID }],
  ])('accepts valid input for %s', (toolName, input) => {
    expect(validateToolInput(toolName, input as Record<string, unknown>)).toEqual({ success: true });
  });

  it.each([
    ['query_mssql_instances', { deviceId: 'not-a-uuid' }],
    ['get_mssql_backup_status', { deviceId: 'not-a-uuid' }],
    ['trigger_mssql_backup', { deviceId: DEVICE_ID, instance: 'MSSQLSERVER', database: 'AppDb' }],
    ['restore_mssql_database', { deviceId: DEVICE_ID, instance: 'MSSQLSERVER', backupFile: '/tmp/appdb.bak' }],
    ['verify_mssql_backup', {}],
  ])('rejects invalid input for %s', (toolName, input) => {
    const result = validateToolInput(toolName, input as Record<string, unknown>);
    expect(result.success).toBe(false);
  });
});

describe('aiToolsMssql handlers', () => {
  let toolMap: Map<string, AiTool>;

  beforeEach(() => {
    vi.clearAllMocks();
    setDefaultDbMocks();
    toolMap = buildToolMap();
  });

  it.each([
    ['query_mssql_instances', {}],
    ['get_mssql_backup_status', {}],
    ['trigger_mssql_backup', { deviceId: DEVICE_ID, instance: 'MSSQLSERVER', database: 'AppDb', outputPath: '/tmp/appdb.bak' }],
    ['restore_mssql_database', { deviceId: DEVICE_ID, instance: 'MSSQLSERVER', backupFile: '/tmp/appdb.bak', targetDatabase: 'RestoredDb' }],
    ['verify_mssql_backup', { deviceId: DEVICE_ID, instance: 'MSSQLSERVER', backupFile: '/tmp/appdb.bak' }],
  ])('%s handler returns a JSON string', async (toolName, input) => {
    prepareHandlerMocks(toolName);
    const result = await toolMap.get(toolName)!.handler(input as Record<string, unknown>, makeAuth());
    expect(typeof result).toBe('string');
    expect(() => JSON.parse(result)).not.toThrow();
  });

  it('uses orgCondition for org-scoped MSSQL queries', async () => {
    prepareHandlerMocks('query_mssql_instances');
    const auth = makeAuth();

    await toolMap.get('query_mssql_instances')!.handler({}, auth);

    expect(auth.orgCondition).toHaveBeenCalled();
  });

  it('safeHandler returns error JSON when the handler throws', async () => {
    vi.mocked(db.select).mockImplementation(() => {
      throw new Error('boom');
    });

    const result = await toolMap.get('query_mssql_instances')!.handler({}, makeAuth());
    const parsed = JSON.parse(result);

    expect(parsed).toEqual({ error: 'Operation failed. Check server logs for details.' });
  });
});
