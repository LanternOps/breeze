import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../db', () => ({
  runOutsideDbContext: vi.fn((fn) => fn()),
  withDbAccessContext: vi.fn(async (_ctx: unknown, fn: () => Promise<unknown>) => fn()),
  withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
  db: {
    select: vi.fn(),
    insert: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
  },
}));

vi.mock('./commandQueue', () => ({
  CommandTypes: {
    HYPERV_VM_STATE: 'hyperv_vm_state',
    HYPERV_BACKUP: 'hyperv_backup',
    HYPERV_RESTORE: 'hyperv_restore',
    HYPERV_CHECKPOINT: 'hyperv_checkpoint',
  },
  queueCommandForExecution: vi.fn(),
}));

const resolveBackupConfigForDeviceMock = vi.fn();
vi.mock('./featureConfigResolver', () => ({
  resolveBackupConfigForDevice: (...args: unknown[]) =>
    resolveBackupConfigForDeviceMock(...(args as [])),
}));

import { db } from '../db';
import type { AuthContext } from '../middleware/auth';
import type { AiTool } from './aiTools';
import { validateToolInput } from './aiToolSchemas';
import { queueCommandForExecution } from './commandQueue';
import { registerHypervTools } from './aiToolsHyperv';

const ORG_ID = '11111111-1111-1111-1111-111111111111';
const DEVICE_ID = '22222222-2222-2222-2222-222222222222';
const VM_ID = '33333333-3333-3333-3333-333333333333';

const EXPECTED_TOOLS = [
  'query_hyperv_vms',
  'get_hyperv_vm_details',
  'manage_hyperv_vm',
  'trigger_hyperv_backup',
  'restore_hyperv_vm',
  'manage_hyperv_checkpoints',
] as const;

const EXPECTED_TIERS: Record<(typeof EXPECTED_TOOLS)[number], number> = {
  query_hyperv_vms: 1,
  get_hyperv_vm_details: 1,
  manage_hyperv_vm: 3,
  trigger_hyperv_backup: 3,
  restore_hyperv_vm: 3,
  manage_hyperv_checkpoints: 2,
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
  resolveBackupConfigForDeviceMock.mockResolvedValue({
    configId: '44444444-4444-4444-8444-444444444444',
    featureLinkId: '55555555-5555-4555-8555-555555555555',
  });
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
  registerHypervTools(toolMap);
  return toolMap;
}

function prepareHandlerMocks(toolName: string) {
  const vmRow = {
    id: VM_ID,
    orgId: ORG_ID,
    deviceId: DEVICE_ID,
    vmId: 'hyperv-vm-1',
    vmName: 'Accounting VM',
    state: 'running',
    generation: 2,
    memoryMb: 4096,
    processorCount: 4,
    rctEnabled: true,
    hasPassthroughDisks: false,
    checkpoints: ['daily'],
    vhdPaths: ['C:/VMs/accounting.vhdx'],
    notes: 'primary',
    hostname: 'hyperv-01',
    deviceStatus: 'online',
    lastDiscoveredAt: new Date('2026-03-01T00:00:00Z'),
    createdAt: new Date('2026-03-01T00:00:00Z'),
    updatedAt: new Date('2026-03-02T00:00:00Z'),
  };

  switch (toolName) {
    case 'query_hyperv_vms':
      mockSelectSequence([[vmRow]]);
      break;
    case 'get_hyperv_vm_details':
      mockSelectSequence([[vmRow]]);
      break;
    case 'manage_hyperv_vm':
    case 'trigger_hyperv_backup':
      mockSelectSequence([[vmRow]]);
      vi.mocked(db.insert).mockImplementationOnce(() =>
        createInsertChain([{ id: 'backup-job-1' }]) as any
      );
      break;
    case 'manage_hyperv_checkpoints':
      mockSelectSequence([[vmRow]]);
      break;
    case 'restore_hyperv_vm':
      mockSelectSequence([
        [{ id: DEVICE_ID }],
        [{ id: '66666666-6666-4666-8666-666666666666', providerSnapshotId: 'hyperv-accounting-1', metadata: { backupKind: 'hyperv_export' } }],
      ]);
      break;
    default:
      mockSelectSequence([[]]);
  }
}

describe('registerHypervTools', () => {
  let toolMap: Map<string, AiTool>;

  beforeEach(() => {
    vi.clearAllMocks();
    setDefaultDbMocks();
    toolMap = buildToolMap();
  });

  it('registers all expected Hyper-V tools', () => {
    expect(toolMap.size).toBe(EXPECTED_TOOLS.length);
    expect(Array.from(toolMap.keys()).sort()).toEqual([...EXPECTED_TOOLS].sort());
  });

  it.each(Object.entries(EXPECTED_TIERS))('assigns tier %s -> %s', (toolName, tier) => {
    expect(toolMap.get(toolName)!.tier).toBe(tier);
  });

  it.each([
    ['query_hyperv_vms', { deviceId: DEVICE_ID, state: 'running', limit: 10 }],
    ['get_hyperv_vm_details', { vmId: VM_ID }],
    ['manage_hyperv_vm', { vmId: VM_ID, action: 'start' }],
    ['trigger_hyperv_backup', { vmId: VM_ID, consistencyType: 'application' }],
    ['restore_hyperv_vm', { deviceId: DEVICE_ID, snapshotId: '66666666-6666-4666-8666-666666666666', vmName: 'Recovered VM' }],
    ['manage_hyperv_checkpoints', { vmId: VM_ID, action: 'create', checkpointName: 'prepatch' }],
  ])('accepts valid input for %s', (toolName, input) => {
    expect(validateToolInput(toolName, input as Record<string, unknown>)).toEqual({ success: true });
  });

  it.each([
    ['query_hyperv_vms', { deviceId: 'not-a-uuid' }],
    ['get_hyperv_vm_details', {}],
    ['manage_hyperv_vm', { vmId: VM_ID }],
    ['trigger_hyperv_backup', {}],
    ['restore_hyperv_vm', { deviceId: DEVICE_ID }],
    ['manage_hyperv_checkpoints', { vmId: VM_ID }],
  ])('rejects invalid input for %s', (toolName, input) => {
    const result = validateToolInput(toolName, input as Record<string, unknown>);
    expect(result.success).toBe(false);
  });
});

describe('aiToolsHyperv handlers', () => {
  let toolMap: Map<string, AiTool>;

  beforeEach(() => {
    vi.clearAllMocks();
    setDefaultDbMocks();
    toolMap = buildToolMap();
  });

  it.each([
    ['query_hyperv_vms', {}],
    ['get_hyperv_vm_details', { vmId: VM_ID }],
    ['manage_hyperv_vm', { vmId: VM_ID, action: 'start' }],
    ['trigger_hyperv_backup', { vmId: VM_ID }],
    ['restore_hyperv_vm', { deviceId: DEVICE_ID, snapshotId: '66666666-6666-4666-8666-666666666666' }],
    ['manage_hyperv_checkpoints', { vmId: VM_ID, action: 'create', checkpointName: 'prepatch' }],
  ])('%s handler returns a JSON string', async (toolName, input) => {
    prepareHandlerMocks(toolName);
    const result = await toolMap.get(toolName)!.handler(input as Record<string, unknown>, makeAuth());
    expect(typeof result).toBe('string');
    expect(() => JSON.parse(result)).not.toThrow();
  });

  it('uses orgCondition for org-scoped Hyper-V queries', async () => {
    prepareHandlerMocks('query_hyperv_vms');
    const auth = makeAuth();

    await toolMap.get('query_hyperv_vms')!.handler({}, auth);

    expect(auth.orgCondition).toHaveBeenCalled();
  });

  it('safeHandler returns error JSON when the handler throws', async () => {
    vi.mocked(db.select).mockImplementation(() => {
      throw new Error('boom');
    });

    const result = await toolMap.get('query_hyperv_vms')!.handler({}, makeAuth());
    const parsed = JSON.parse(result);

    expect(parsed).toEqual({ error: 'Operation failed. Check server logs for details.' });
  });

  it('queues VM state commands with targetState for the agent', async () => {
    prepareHandlerMocks('manage_hyperv_vm');

    await toolMap.get('manage_hyperv_vm')!.handler({ vmId: VM_ID, action: 'start' }, makeAuth());

    expect(queueCommandForExecution).toHaveBeenCalledWith(
      DEVICE_ID,
      'hyperv_vm_state',
      { vmName: 'Accounting VM', targetState: 'start' },
      expect.objectContaining({ userId: 'user-1' })
    );
  });

  it('queues Hyper-V backups without a local export path', async () => {
    prepareHandlerMocks('trigger_hyperv_backup');

    await toolMap.get('trigger_hyperv_backup')!.handler({ vmId: VM_ID, consistencyType: 'crash' }, makeAuth());

    expect(queueCommandForExecution).toHaveBeenCalledWith(
      DEVICE_ID,
      'hyperv_backup',
      { backupJobId: 'backup-job-1', vmName: 'Accounting VM', consistencyType: 'crash' },
      expect.objectContaining({ userId: 'user-1' })
    );
  });

  it('queues Hyper-V restore commands using snapshotId', async () => {
    prepareHandlerMocks('restore_hyperv_vm');

    await toolMap.get('restore_hyperv_vm')!.handler(
      { deviceId: DEVICE_ID, snapshotId: '66666666-6666-4666-8666-666666666666', vmName: 'Recovered VM' },
      makeAuth()
    );

    expect(queueCommandForExecution).toHaveBeenCalledWith(
      DEVICE_ID,
      'hyperv_restore',
      {
        snapshotId: 'hyperv-accounting-1',
        vmName: 'Recovered VM',
        generateNewId: true,
      },
      expect.objectContaining({ userId: 'user-1' })
    );
  });
});
