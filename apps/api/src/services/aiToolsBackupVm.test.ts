import { beforeEach, describe, expect, it, vi } from 'vitest';

const actorGate = vi.hoisted(() => ({ refusal: vi.fn(async (): Promise<unknown> => null) }));
vi.mock('./backupRestoreActorGate', () => ({
  restoreIntegrityRefusalForActor: (...args: unknown[]) => actorGate.refusal(...(args as [])),
}));
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
    BARE_METAL_REBUILD: 'bare_metal_rebuild',
  },
}));

// The org/cross-site restore authorization is covered by
// aiToolsRestoreAuthorization.test.ts and aiToolsRestoreScope.integration.test.ts;
// here it is stubbed so the select sequences below stay the handler's own.
vi.mock('./aiToolsRestoreAuthorization', () => ({
  authorizeAiRestore: vi.fn(async () => ({ ok: true })),
}));
vi.mock('./aiDispatch', () => ({
  aiQueueCommandForExecution: vi.fn(),
}));

vi.mock('./vmRestoreRebuildEngine', () => ({
  startRebuildEngineVmRestore: vi.fn(),
}));

import { db } from '../db';
import type { AuthContext } from '../middleware/auth';
import type { AiTool } from './aiTools';
import { validateToolInput } from './aiToolSchemas';
import { aiQueueCommandForExecution } from './aiDispatch';
import { registerBackupVmTools } from './aiToolsBackupVm';
import { startRebuildEngineVmRestore } from './vmRestoreRebuildEngine';

const ORG_ID = '11111111-1111-1111-1111-111111111111';
const SNAPSHOT_ID = '22222222-2222-2222-2222-222222222222';
const DEVICE_ID = '33333333-3333-3333-3333-333333333333';
const RESTORE_JOB_ID = '44444444-4444-4444-4444-444444444444';
const HOST_ID = '55555555-5555-4555-8555-555555555555';
const RECOVERY_ID = '66666666-6666-4666-8666-666666666666';
const COMMAND_ID = '77777777-7777-4777-8777-777777777777';
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
  vi.mocked(aiQueueCommandForExecution).mockResolvedValue({
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
    aiOrigin: { kind: 'ai_assistant', sessionId: 'test-session' },
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

describe('restore_as_vm — rebuild engine (W05a)', () => {
  let toolMap: Map<string, AiTool>;

  const rebuildInput = {
    engine: 'rebuild',
    snapshotId: SNAPSHOT_ID,
    rebuildHostDeviceId: HOST_ID,
    outputPath: '/srv/rebuild/dev-1.vhdx',
    imageSizeGb: 60,
  };

  beforeEach(() => {
    vi.clearAllMocks();
    setDefaultDbMocks();
    toolMap = buildToolMap();
  });

  it('declares the rebuild host as a device arg so the central gate covers it', () => {
    expect(toolMap.get('restore_as_vm')!.deviceArgs).toEqual(expect.arrayContaining(['targetDeviceId', 'rebuildHostDeviceId']));
  });

  it('validates the rebuild variant and rejects an identity override', () => {
    expect(validateToolInput('restore_as_vm', rebuildInput)).toEqual({ success: true });
    expect(validateToolInput('restore_as_vm', { ...rebuildInput, identity: 'original' }).success).toBe(false);
    expect(validateToolInput('restore_as_vm', { ...rebuildInput, outputPath: '/srv/out.img' }).success).toBe(false);
    expect(validateToolInput('restore_as_vm', { engine: 'rebuild', snapshotId: SNAPSHOT_ID, outputPath: '/srv/out.vhdx' }).success).toBe(false);
    // legacy Hyper-V input still validates without an engine
    expect(validateToolInput('restore_as_vm', { snapshotId: SNAPSHOT_ID, targetDeviceId: DEVICE_ID, hypervisor: 'hyperv', vmName: 'VM' })).toEqual({ success: true });
  });

  it('starts the rebuild-engine restore through the shared service with identity forced server-side', async () => {
    prepareHandlerMocks('restore_as_vm');
    vi.mocked(startRebuildEngineVmRestore).mockResolvedValue({
      ok: true,
      jobId: RESTORE_JOB_ID,
      recoveryId: RECOVERY_ID,
      commandId: COMMAND_ID,
      status: 'queued',
    });

    const result = JSON.parse(await toolMap.get('restore_as_vm')!.handler({ ...rebuildInput, identity: 'original' } as Record<string, unknown>, makeAuth()));

    expect(startRebuildEngineVmRestore).toHaveBeenCalledWith(
      expect.objectContaining({
        orgId: ORG_ID,
        snapshotId: SNAPSHOT_ID,
        rebuildHostDeviceId: HOST_ID,
        outputPath: '/srv/rebuild/dev-1.vhdx',
        imageSizeGb: 60,
        userId: 'user-1',
      })
    );
    expect(startRebuildEngineVmRestore).not.toHaveBeenCalledWith(expect.objectContaining({ identity: expect.anything() }));
    expect(result).toMatchObject({
      success: true,
      engine: 'rebuild',
      restoreJobId: RESTORE_JOB_ID,
      recoveryId: RECOVERY_ID,
      commandId: COMMAND_ID,
      rebuildHostDeviceId: HOST_ID,
    });
    expect(db.insert).not.toHaveBeenCalled();
  });

  it('hands the rebuild service an integrity decision that refuses an unattested snapshot for an AI agent', async () => {
    prepareHandlerMocks('restore_as_vm');
    vi.mocked(startRebuildEngineVmRestore).mockImplementation(async (input: any) => {
      const decision = await input.integrity({ id: SNAPSHOT_ID, deviceId: DEVICE_ID });
      return decision.ok
        ? { ok: true, jobId: RESTORE_JOB_ID, recoveryId: RECOVERY_ID, commandId: COMMAND_ID, status: 'queued' }
        : { ok: false, status: decision.status, error: decision.body.code, body: decision.body };
    });
    actorGate.refusal.mockResolvedValueOnce({ code: 'snapshot_integrity_unavailable', message: 'no attestation' });

    const result = JSON.parse(await toolMap.get('restore_as_vm')!.handler(rebuildInput as Record<string, unknown>, makeAuth()));

    expect(result).toEqual({ error: 'no attestation', code: 'snapshot_integrity_unavailable' });
    expect(actorGate.refusal).toHaveBeenCalledWith({
      snapshotDbId: SNAPSHOT_ID,
      targetDeviceId: DEVICE_ID,
      commandType: 'bare_metal_rebuild',
      actor: 'ai_agent',
    });
  });

  it('returns the service error verbatim when the snapshot is not rebuildable', async () => {
    prepareHandlerMocks('restore_as_vm');
    vi.mocked(startRebuildEngineVmRestore).mockResolvedValue({
      ok: false,
      status: 409,
      error: 'snapshot_not_bare_metal_restorable',
    });

    const result = JSON.parse(await toolMap.get('restore_as_vm')!.handler(rebuildInput as Record<string, unknown>, makeAuth()));
    expect(result).toEqual({ error: 'snapshot_not_bare_metal_restorable' });
  });

  // W06d (Task 20): the rebuild engine runs on Linux AND Windows hosts
  // (platform-matched server-side), and a Windows host can create the VM.
  it('validates a Windows drive-letter output path and an optional hyperv block on the rebuild variant', () => {
    const windowsInput = { ...rebuildInput, outputPath: 'C:\\ProgramData\\Breeze\\rebuild\\out\\dev-1.vhdx' };
    expect(validateToolInput('restore_as_vm', windowsInput)).toEqual({ success: true });
    expect(validateToolInput('restore_as_vm', { ...windowsInput, hyperv: { vmName: 'w06-proof', switchName: 'lab-switch', memoryMb: 4096, cpuCount: 2 } })).toEqual({ success: true });
    expect(validateToolInput('restore_as_vm', { ...windowsInput, hyperv: { vmName: '' } }).success).toBe(false);
    expect(validateToolInput('restore_as_vm', { ...windowsInput, hyperv: { vmName: 'x', diskSizeGb: 40 } }).success).toBe(false);
    expect(validateToolInput('restore_as_vm', { ...rebuildInput, outputPath: '\\\\server\\share\\dev-1.vhdx' }).success).toBe(false);
    expect(validateToolInput('restore_as_vm', { ...rebuildInput, outputPath: 'C:\\out\\..\\dev-1.vhdx' }).success).toBe(false);
  });

  it('describes the rebuild engine platform-neutrally and exposes the hyperv block', () => {
    const definition = toolMap.get('restore_as_vm')!.definition;
    expect(definition.description).not.toMatch(/Linux whole-machine snapshot/);
    expect(definition.description).toMatch(/Windows/);
    const properties = (definition.input_schema as any).properties;
    expect(properties.hyperv).toMatchObject({ type: 'object' });
    expect(Object.keys(properties.hyperv.properties)).toEqual(['vmName', 'switchName', 'memoryMb', 'cpuCount']);
    expect(properties.rebuildHostDeviceId.description).not.toMatch(/^Linux/);
  });

  it('forwards the hyperv block to the rebuild service and says the VM will be created', async () => {
    prepareHandlerMocks('restore_as_vm');
    vi.mocked(startRebuildEngineVmRestore).mockResolvedValue({
      ok: true, jobId: RESTORE_JOB_ID, recoveryId: RECOVERY_ID, commandId: COMMAND_ID, status: 'queued',
    });
    const hyperv = { vmName: 'w06-proof', switchName: 'lab-switch' };

    const result = JSON.parse(await toolMap.get('restore_as_vm')!.handler(
      { ...rebuildInput, outputPath: 'C:\\out\\dev-1.vhdx', hyperv } as Record<string, unknown>,
      makeAuth(),
    ));

    expect(startRebuildEngineVmRestore).toHaveBeenCalledWith(expect.objectContaining({ outputPath: 'C:\\out\\dev-1.vhdx', hyperv }));
    expect(result).toMatchObject({ success: true, engine: 'rebuild', hyperv });
    expect(result.note).toMatch(/w06-proof/);
    expect(result.note).not.toMatch(/arrives with the Windows engine/);
  });

  it('does not pass hyperv when the input carries none', async () => {
    prepareHandlerMocks('restore_as_vm');
    vi.mocked(startRebuildEngineVmRestore).mockResolvedValue({
      ok: true, jobId: RESTORE_JOB_ID, recoveryId: RECOVERY_ID, commandId: COMMAND_ID, status: 'queued',
    });

    const result = JSON.parse(await toolMap.get('restore_as_vm')!.handler(rebuildInput as Record<string, unknown>, makeAuth()));

    expect(vi.mocked(startRebuildEngineVmRestore).mock.calls[0]![0]).not.toHaveProperty('hyperv');
    expect(result.note).toMatch(/manually/);
    expect(result.note).not.toMatch(/arrives with the Windows engine/);
  });

  it('returns the service refusal message for a hyperv block on a non-Windows host', async () => {
    prepareHandlerMocks('restore_as_vm');
    vi.mocked(startRebuildEngineVmRestore).mockResolvedValue({
      ok: false, status: 400, error: 'hyperv_requires_windows_host', message: 'hyperv is only valid for Windows rebuild hosts',
    });

    const result = JSON.parse(await toolMap.get('restore_as_vm')!.handler(
      { ...rebuildInput, hyperv: { vmName: 'x' } } as Record<string, unknown>,
      makeAuth(),
    ));

    expect(result).toEqual({ error: 'hyperv_requires_windows_host', message: 'hyperv is only valid for Windows rebuild hosts' });
  });

  it('denies a cross-site snapshot before touching the rebuild service', async () => {
    mockSelectSequence([[]]);
    const result = JSON.parse(await toolMap.get('restore_as_vm')!.handler(rebuildInput as Record<string, unknown>, makeAuth()));
    expect(result.error).toBeTruthy();
    expect(startRebuildEngineVmRestore).not.toHaveBeenCalled();
  });
});
