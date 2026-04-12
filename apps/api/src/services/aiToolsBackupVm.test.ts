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
    VM_RESTORE_FROM_BACKUP: 'vm_restore_from_backup',
    VM_INSTANT_BOOT: 'vm_instant_boot',
  },
  queueCommandForExecution: vi.fn(),
}));

import { db } from '../db';
import type { AuthContext } from '../middleware/auth';
import type { AiTool } from './aiTools';
import { validateToolInput } from './aiToolSchemas';
import { queueCommandForExecution } from './commandQueue';
import { registerBackupVmTools } from './aiToolsBackupVm';

const ORG_ID = '11111111-1111-1111-1111-111111111111';
const SNAPSHOT_ID = '22222222-2222-2222-2222-222222222222';
const DEVICE_ID = '33333333-3333-3333-3333-333333333333';
const RESTORE_JOB_ID = '44444444-4444-4444-4444-444444444444';
const GB = 1024 * 1024 * 1024;

const EXPECTED_TOOLS = [
  'restore_as_vm',
  'instant_boot_vm',
  'get_vm_restore_estimate',
] as const;

const EXPECTED_TIERS: Record<(typeof EXPECTED_TOOLS)[number], number> = {
  restore_as_vm: 3,
  instant_boot_vm: 3,
  get_vm_restore_estimate: 1,
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
  registerBackupVmTools(toolMap);
  return toolMap;
}

function prepareHandlerMocks(toolName: string) {
  const snapshotRow = {
    id: SNAPSHOT_ID,
    orgId: ORG_ID,
    snapshotId: 'snapshot-ext-1',
    size: 50 * GB,
    metadata: { platform: 'windows', osVersion: '11' },
    hardwareProfile: {
      cpuCores: 4,
      totalMemoryMB: 8192,
      disks: [{ sizeBytes: 80 * GB }],
    },
  };

  switch (toolName) {
    case 'restore_as_vm':
    case 'instant_boot_vm':
      mockSelectSequence([[snapshotRow], [{ id: DEVICE_ID }]]);
      mockInsertSequence([[{ id: RESTORE_JOB_ID, status: 'pending', createdAt: new Date('2026-03-02T00:00:00Z') }]]);
      break;
    case 'get_vm_restore_estimate':
      mockSelectSequence([[snapshotRow]]);
      break;
    default:
      mockSelectSequence([[]]);
  }
}

describe('registerBackupVmTools', () => {
  let toolMap: Map<string, AiTool>;

  beforeEach(() => {
    vi.clearAllMocks();
    setDefaultDbMocks();
    toolMap = buildToolMap();
  });

  it('registers all expected backup VM tools', () => {
    expect(toolMap.size).toBe(EXPECTED_TOOLS.length);
    expect(Array.from(toolMap.keys()).sort()).toEqual([...EXPECTED_TOOLS].sort());
  });

  it.each(Object.entries(EXPECTED_TIERS))('assigns tier %s -> %s', (toolName, tier) => {
    expect(toolMap.get(toolName)!.tier).toBe(tier);
  });

  it.each([
    ['restore_as_vm', { snapshotId: SNAPSHOT_ID, targetDeviceId: DEVICE_ID, hypervisor: 'hyperv', vmName: 'Recovered VM' }],
    ['instant_boot_vm', { snapshotId: SNAPSHOT_ID, targetDeviceId: DEVICE_ID, vmName: 'Instant VM' }],
    ['get_vm_restore_estimate', { snapshotId: SNAPSHOT_ID }],
  ])('accepts valid input for %s', (toolName, input) => {
    expect(validateToolInput(toolName, input as Record<string, unknown>)).toEqual({ success: true });
  });

  it.each([
    ['restore_as_vm', { snapshotId: SNAPSHOT_ID, targetDeviceId: DEVICE_ID, hypervisor: 'hyperv' }],
    ['instant_boot_vm', {}],
    ['get_vm_restore_estimate', {}],
  ])('rejects invalid input for %s', (toolName, input) => {
    const result = validateToolInput(toolName, input as Record<string, unknown>);
    expect(result.success).toBe(false);
  });
});

describe('aiToolsBackupVm handlers', () => {
  let toolMap: Map<string, AiTool>;

  beforeEach(() => {
    vi.clearAllMocks();
    setDefaultDbMocks();
    toolMap = buildToolMap();
  });

  it.each([
    ['restore_as_vm', { snapshotId: SNAPSHOT_ID, targetDeviceId: DEVICE_ID, hypervisor: 'hyperv', vmName: 'Recovered VM' }],
    ['instant_boot_vm', { snapshotId: SNAPSHOT_ID, targetDeviceId: DEVICE_ID, vmName: 'Instant VM' }],
    ['get_vm_restore_estimate', { snapshotId: SNAPSHOT_ID }],
  ])('%s handler returns a JSON string', async (toolName, input) => {
    prepareHandlerMocks(toolName);
    const result = await toolMap.get(toolName)!.handler(input as Record<string, unknown>, makeAuth());
    expect(typeof result).toBe('string');
    expect(() => JSON.parse(result)).not.toThrow();
  });

  it('uses orgCondition for org-scoped backup VM lookups', async () => {
    prepareHandlerMocks('get_vm_restore_estimate');
    const auth = makeAuth();

    await toolMap.get('get_vm_restore_estimate')!.handler({ snapshotId: SNAPSHOT_ID }, auth);

    expect(auth.orgCondition).toHaveBeenCalled();
  });

  it('safeHandler returns error JSON when the handler throws', async () => {
    vi.mocked(db.select).mockImplementation(() => {
      throw new Error('boom');
    });

    const result = await toolMap.get('get_vm_restore_estimate')!.handler({ snapshotId: SNAPSHOT_ID }, makeAuth());
    const parsed = JSON.parse(result);

    expect(parsed).toEqual({ error: 'Operation failed. Check server logs for details.' });
  });
});
