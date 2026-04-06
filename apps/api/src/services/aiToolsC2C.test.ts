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

vi.mock('../jobs/c2cEnqueue', () => ({
  enqueueC2cRestore: vi.fn(),
  enqueueC2cSync: vi.fn(),
}));

vi.mock('./c2cJobCreation', () => ({
  createC2cSyncJobIfIdle: vi.fn(),
}));

import { db } from '../db';
import type { AuthContext } from '../middleware/auth';
import type { AiTool } from './aiTools';
import { enqueueC2cRestore, enqueueC2cSync } from '../jobs/c2cEnqueue';
import { validateToolInput } from './aiToolSchemas';
import { createC2cSyncJobIfIdle } from './c2cJobCreation';
import { registerC2CTools } from './aiToolsC2C';

const ORG_ID = '11111111-1111-1111-1111-111111111111';
const CONFIG_ID = '22222222-2222-2222-2222-222222222222';
const ITEM_ID = '33333333-3333-3333-3333-333333333333';
const JOB_ID = '44444444-4444-4444-4444-444444444444';

const EXPECTED_TOOLS = [
  'query_c2c_connections',
  'query_c2c_jobs',
  'search_c2c_items',
  'trigger_c2c_sync',
  'restore_c2c_items',
] as const;

const EXPECTED_TIERS: Record<(typeof EXPECTED_TOOLS)[number], number> = {
  query_c2c_connections: 1,
  query_c2c_jobs: 1,
  search_c2c_items: 1,
  trigger_c2c_sync: 2,
  restore_c2c_items: 3,
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
  vi.mocked(createC2cSyncJobIfIdle).mockResolvedValue({
    job: { id: JOB_ID, status: 'pending' } as any,
    created: true,
  });
  vi.mocked(enqueueC2cSync).mockResolvedValue('queue-job-1');
  vi.mocked(enqueueC2cRestore).mockResolvedValue('queue-job-2');
}

function mockSelectSequence(rowsList: any[][]) {
  let index = 0;
  vi.mocked(db.select).mockImplementation(() => createQueryChain(rowsList[index++] ?? []) as any);
}

function mockInsertSequence(rowsList: any[][]) {
  let index = 0;
  vi.mocked(db.insert).mockImplementation(() => createInsertChain(rowsList[index++] ?? []) as any);
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
  registerC2CTools(toolMap);
  return toolMap;
}

function prepareHandlerMocks(toolName: string) {
  switch (toolName) {
    case 'query_c2c_connections':
      mockSelectSequence([[
        {
          id: 'conn-1',
          provider: 'm365',
          displayName: 'Tenant A',
          tenantId: 'tenant-1',
          clientId: 'client-1',
          hasClientSecret: true,
          hasRefreshToken: true,
          hasAccessToken: true,
          tokenExpiresAt: new Date('2026-03-10T00:00:00Z'),
          scopes: ['mail.read'],
          status: 'connected',
          lastSyncAt: new Date('2026-03-02T00:00:00Z'),
          createdAt: new Date('2026-03-01T00:00:00Z'),
          updatedAt: new Date('2026-03-02T00:00:00Z'),
        },
      ]]);
      break;
    case 'query_c2c_jobs':
      mockSelectSequence([[
        {
          id: JOB_ID,
          configId: CONFIG_ID,
          configName: 'M365 Backup',
          backupScope: 'mailbox',
          connectionId: 'conn-1',
          connectionName: 'Tenant A',
          provider: 'm365',
          status: 'completed',
          startedAt: new Date('2026-03-01T00:00:00Z'),
          completedAt: new Date('2026-03-01T01:00:00Z'),
          itemsProcessed: 10,
          itemsNew: 2,
          itemsUpdated: 1,
          itemsDeleted: 0,
          bytesTransferred: 1024,
          errorLog: null,
          createdAt: new Date('2026-03-01T00:00:00Z'),
          updatedAt: new Date('2026-03-01T01:00:00Z'),
        },
      ]]);
      break;
    case 'search_c2c_items':
      mockSelectSequence([
        [[
          {
            id: ITEM_ID,
            configId: CONFIG_ID,
            configName: 'M365 Backup',
            jobId: JOB_ID,
            itemType: 'mail',
            externalId: 'ext-1',
            userEmail: 'user@example.com',
            subjectOrName: 'Quarterly report',
            parentPath: '/Inbox',
            storagePath: '/storage/item-1',
            sizeBytes: 1024,
            itemDate: new Date('2026-03-01T00:00:00Z'),
            isDeleted: false,
            metadata: {},
            createdAt: new Date('2026-03-01T00:00:00Z'),
            updatedAt: new Date('2026-03-01T00:00:00Z'),
          },
        ]].flat(),
        [{ count: 1 }],
      ]);
      break;
    case 'trigger_c2c_sync':
      mockSelectSequence([[{ id: CONFIG_ID, orgId: ORG_ID, name: 'M365 Backup' }]]);
      vi.mocked(createC2cSyncJobIfIdle).mockResolvedValue({
        job: { id: JOB_ID, status: 'pending' } as any,
        created: true,
      });
      break;
    case 'restore_c2c_items':
      mockSelectSequence([[{ id: ITEM_ID, orgId: ORG_ID, configId: CONFIG_ID }]]);
      mockInsertSequence([[{ id: JOB_ID, status: 'pending' }]]);
      break;
    default:
      mockSelectSequence([[]]);
  }
}

describe('registerC2CTools', () => {
  let toolMap: Map<string, AiTool>;

  beforeEach(() => {
    vi.clearAllMocks();
    setDefaultDbMocks();
    toolMap = buildToolMap();
  });

  it('registers all expected C2C tools', () => {
    expect(toolMap.size).toBe(EXPECTED_TOOLS.length);
    expect(Array.from(toolMap.keys()).sort()).toEqual([...EXPECTED_TOOLS].sort());
  });

  it.each(Object.entries(EXPECTED_TIERS))('assigns tier %s -> %s', (toolName, tier) => {
    expect(toolMap.get(toolName)!.tier).toBe(tier);
  });

  it.each([
    ['query_c2c_connections', { provider: 'm365', status: 'connected', limit: 10 }],
    ['query_c2c_jobs', { configId: CONFIG_ID, status: 'completed', from: '2026-03-01T00:00:00Z', to: '2026-03-02T00:00:00Z' }],
    ['search_c2c_items', { configId: CONFIG_ID, userEmail: 'user@example.com', keyword: 'report', limit: 10, offset: 0 }],
    ['trigger_c2c_sync', { configId: CONFIG_ID }],
    ['restore_c2c_items', { itemIds: [ITEM_ID] }],
  ])('accepts valid input for %s', (toolName, input) => {
    expect(validateToolInput(toolName, input as Record<string, unknown>)).toEqual({ success: true });
  });

  it.each([
    ['query_c2c_connections', { limit: 0 }],
    ['query_c2c_jobs', { from: 'not-a-date' }],
    ['search_c2c_items', { userEmail: 'not-an-email' }],
    ['trigger_c2c_sync', {}],
    ['restore_c2c_items', { itemIds: [] }],
  ])('rejects invalid input for %s', (toolName, input) => {
    const result = validateToolInput(toolName, input as Record<string, unknown>);
    expect(result.success).toBe(false);
  });
});

describe('aiToolsC2C handlers', () => {
  let toolMap: Map<string, AiTool>;

  beforeEach(() => {
    vi.clearAllMocks();
    setDefaultDbMocks();
    toolMap = buildToolMap();
  });

  it.each([
    ['query_c2c_connections', {}],
    ['query_c2c_jobs', {}],
    ['search_c2c_items', {}],
    ['trigger_c2c_sync', { configId: CONFIG_ID }],
    ['restore_c2c_items', { itemIds: [ITEM_ID] }],
  ])('%s handler returns a JSON string', async (toolName, input) => {
    prepareHandlerMocks(toolName);
    const result = await toolMap.get(toolName)!.handler(input as Record<string, unknown>, makeAuth());
    expect(typeof result).toBe('string');
    expect(() => JSON.parse(result)).not.toThrow();
  });

  it('uses orgCondition for org-scoped C2C queries', async () => {
    prepareHandlerMocks('query_c2c_connections');
    const auth = makeAuth();

    await toolMap.get('query_c2c_connections')!.handler({}, auth);

    expect(auth.orgCondition).toHaveBeenCalled();
  });

  it('safeHandler returns error JSON when the handler throws', async () => {
    vi.mocked(db.select).mockImplementation(() => {
      throw new Error('boom');
    });

    const result = await toolMap.get('query_c2c_connections')!.handler({}, makeAuth());
    const parsed = JSON.parse(result);

    expect(parsed).toEqual({ error: 'Operation failed. Check server logs for details.' });
  });
});
