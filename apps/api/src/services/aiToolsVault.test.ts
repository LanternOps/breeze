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
    VAULT_SYNC: 'vault_sync',
  },
  queueCommandForExecution: vi.fn(),
}));

import { db } from '../db';
import type { AuthContext } from '../middleware/auth';
import type { AiTool } from './aiTools';
import { validateToolInput } from './aiToolSchemas';
import { queueCommandForExecution } from './commandQueue';
import { registerVaultTools } from './aiToolsVault';

const ORG_ID = '11111111-1111-1111-1111-111111111111';
const DEVICE_ID = '22222222-2222-2222-2222-222222222222';
const VAULT_ID = '33333333-3333-3333-3333-333333333333';

const EXPECTED_TOOLS = [
  'query_vaults',
  'get_vault_status',
  'trigger_vault_sync',
  'configure_vault',
] as const;

const EXPECTED_TIERS: Record<(typeof EXPECTED_TOOLS)[number], number> = {
  query_vaults: 1,
  get_vault_status: 1,
  trigger_vault_sync: 2,
  configure_vault: 2,
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
  registerVaultTools(toolMap);
  return toolMap;
}

function prepareHandlerMocks(toolName: string) {
  switch (toolName) {
    case 'query_vaults':
      mockSelectSequence([[
        {
          id: VAULT_ID,
          deviceId: DEVICE_ID,
          hostname: 'vault-host-01',
          deviceStatus: 'online',
          vaultPath: '/vaults/main',
          vaultType: 'local',
          isActive: true,
          retentionCount: 7,
          lastSyncAt: new Date('2026-03-02T00:00:00Z'),
          lastSyncStatus: 'success',
          lastSyncSnapshotId: 'snap-1',
          syncSizeBytes: 1024,
          createdAt: new Date('2026-03-01T00:00:00Z'),
          updatedAt: new Date('2026-03-02T00:00:00Z'),
        },
      ]]);
      break;
    case 'get_vault_status':
      mockSelectSequence([
        [{ id: DEVICE_ID, hostname: 'vault-host-01', status: 'online' }],
        [[
          {
            id: VAULT_ID,
            vaultPath: '/vaults/main',
            vaultType: 'local',
            isActive: true,
            retentionCount: 7,
            lastSyncAt: new Date('2026-03-02T00:00:00Z'),
            lastSyncStatus: 'success',
            lastSyncSnapshotId: 'snap-1',
            syncSizeBytes: 1024,
            createdAt: new Date('2026-03-01T00:00:00Z'),
            updatedAt: new Date('2026-03-02T00:00:00Z'),
          },
        ]].flat(),
      ]);
      break;
    case 'trigger_vault_sync':
      mockSelectSequence([[{ id: VAULT_ID, deviceId: DEVICE_ID, isActive: true }]]);
      break;
    case 'configure_vault':
      mockSelectSequence([[{ id: VAULT_ID }]]);
      mockUpdateSequence([[{ id: VAULT_ID, vaultPath: '/vaults/updated', vaultType: 'local' }]]);
      break;
    default:
      mockSelectSequence([[]]);
  }
}

describe('registerVaultTools', () => {
  let toolMap: Map<string, AiTool>;

  beforeEach(() => {
    vi.clearAllMocks();
    setDefaultDbMocks();
    toolMap = buildToolMap();
  });

  it('registers all expected vault tools', () => {
    expect(toolMap.size).toBe(EXPECTED_TOOLS.length);
    expect(Array.from(toolMap.keys()).sort()).toEqual([...EXPECTED_TOOLS].sort());
  });

  it.each(Object.entries(EXPECTED_TIERS))('assigns tier %s -> %s', (toolName, tier) => {
    expect(toolMap.get(toolName)!.tier).toBe(tier);
  });

  it.each([
    ['query_vaults', { deviceId: DEVICE_ID, isActive: true, lastSyncStatus: 'success', limit: 10 }],
    ['get_vault_status', { deviceId: DEVICE_ID }],
    ['trigger_vault_sync', { vaultId: VAULT_ID }],
    ['configure_vault', { action: 'create', deviceId: DEVICE_ID, vaultPath: '/vaults/main', vaultType: 'local' }],
  ])('accepts valid input for %s', (toolName, input) => {
    expect(validateToolInput(toolName, input as Record<string, unknown>)).toEqual({ success: true });
  });

  it.each([
    ['query_vaults', { deviceId: 'not-a-uuid' }],
    ['get_vault_status', {}],
    ['trigger_vault_sync', {}],
    ['configure_vault', { action: 'create', deviceId: DEVICE_ID }],
  ])('rejects invalid input for %s', (toolName, input) => {
    const result = validateToolInput(toolName, input as Record<string, unknown>);
    expect(result.success).toBe(false);
  });
});

describe('aiToolsVault handlers', () => {
  let toolMap: Map<string, AiTool>;

  beforeEach(() => {
    vi.clearAllMocks();
    setDefaultDbMocks();
    toolMap = buildToolMap();
  });

  it.each([
    ['query_vaults', {}],
    ['get_vault_status', { deviceId: DEVICE_ID }],
    ['trigger_vault_sync', { vaultId: VAULT_ID }],
    ['configure_vault', { action: 'update', vaultId: VAULT_ID, vaultPath: '/vaults/updated' }],
  ])('%s handler returns a JSON string', async (toolName, input) => {
    prepareHandlerMocks(toolName);
    const result = await toolMap.get(toolName)!.handler(input as Record<string, unknown>, makeAuth());
    expect(typeof result).toBe('string');
    expect(() => JSON.parse(result)).not.toThrow();
  });

  it('uses orgCondition for org-scoped vault queries', async () => {
    prepareHandlerMocks('query_vaults');
    const auth = makeAuth();

    await toolMap.get('query_vaults')!.handler({}, auth);

    expect(auth.orgCondition).toHaveBeenCalled();
  });

  it('safeHandler returns error JSON when the handler throws', async () => {
    vi.mocked(db.select).mockImplementation(() => {
      throw new Error('boom');
    });

    const result = await toolMap.get('query_vaults')!.handler({}, makeAuth());
    const parsed = JSON.parse(result);

    expect(parsed).toEqual({ error: 'Operation failed. Check server logs for details.' });
  });
});
