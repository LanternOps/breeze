import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * `registerFilesystemTools(aiTools: Map<string, AiTool>)` fills a Map keyed by
 * tool name (aiToolsFilesystem.ts:55-58), so the registry IS the Map — hand it
 * an empty one and drive the handlers off it.
 */
const registered = new Map<string, { handler: (input: Record<string, unknown>, auth: unknown) => Promise<string> }>();

const contextState = vi.hoisted(() => ({ outside: false, scoped: false }));
vi.mock('../db', () => ({
  runOutsideDbContext: vi.fn(async (fn) => {
    contextState.outside = true;
    try { return await fn(); } finally { contextState.outside = false; }
  }),
  withDbAccessContext: vi.fn(async (_context, fn) => {
    contextState.scoped = true;
    try { return await fn(); } finally { contextState.scoped = false; }
  }),
  db: {
    select: vi.fn(() => ({
      from: vi.fn(() => ({ where: vi.fn(() => ({ limit: vi.fn().mockResolvedValue([{ id: 'user-1' }]) })) })),
    })),
    insert: vi.fn(() => ({
      values: vi.fn(() => ({ returning: vi.fn().mockResolvedValue([{ id: 'run-1' }]) })),
    })),
  },
}));
vi.mock('../db/schema', () => new Proxy({}, {
  get: (_t, prop: string) => (prop === 'then' ? undefined : { name: prop }),
  has: () => true,
}));
vi.mock('./aiDispatch', () => ({ aiExecuteCommand: vi.fn(async () => ({ status: 'completed', stdout: '{}' })), aiQueueCommandForExecution: vi.fn() }));
vi.mock('./commandQueue', () => ({ waitForCommandResult: vi.fn() }));
vi.mock('./filesystemAnalysis', () => ({
  buildCleanupPreview: vi.fn(() => ({
    snapshotId: 'snap-1', estimatedBytes: 0, candidateCount: 0, categories: [], candidates: [],
  })),
  getLatestFilesystemSnapshot: vi.fn(),
  getLatestFilesystemCleanupSnapshot: vi.fn(),
  parseFilesystemAnalysisStdout: vi.fn(() => ({ summary: { filesScanned: 1 } })),
  saveFilesystemSnapshot: vi.fn(),
  setFilesystemScanGeneration: vi.fn(),
  safeCleanupCategories: ['temp_files', 'browser_cache', 'package_cache', 'trash'],
}));

import { db, withDbAccessContext } from '../db';
import { aiQueueCommandForExecution } from './aiDispatch';
import { waitForCommandResult } from './commandQueue';
import {
  getLatestFilesystemCleanupSnapshot,
  getLatestFilesystemSnapshot,
  saveFilesystemSnapshot,
  setFilesystemScanGeneration,
} from './filesystemAnalysis';
import { registerFilesystemTools } from './aiToolsFilesystem';

const DEVICE_ID = '11111111-1111-1111-1111-111111111111';
const AUTH = {
  user: { id: 'user-1' },
  orgCondition: () => undefined,
  allowedDeviceIds: null,
} as never;

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(setFilesystemScanGeneration).mockReset();
  vi.mocked(waitForCommandResult).mockReset();
  vi.mocked(aiQueueCommandForExecution).mockResolvedValue({ command: { id: 'cmd-scan' } } as never);
  vi.mocked(waitForCommandResult).mockResolvedValue({ status: 'completed', result: { status: 'completed', stdout: '{}' } } as never);
  registered.clear();
  registerFilesystemTools(registered as never);
});

function withDevice(osType: 'windows' | 'linux') {
  vi.mocked(db.select).mockReturnValue({
    from: vi.fn(() => ({
      where: vi.fn(() => ({ limit: vi.fn().mockResolvedValue([{ id: DEVICE_ID, orgId: 'org-1', osType, status: 'online' }]) })),
    })),
  } as never);
}

describe('analyze_disk_usage — path (spec §9)', () => {
  it('normalises the requested path and reads that volume\u2019s snapshot', async () => {
    withDevice('windows');
    vi.mocked(getLatestFilesystemSnapshot).mockResolvedValue({
      id: 'snap-d', capturedAt: new Date(), trigger: 'on_demand', partial: false,
      summary: {}, largestFiles: [], largestDirs: [], tempAccumulation: [],
      oldDownloads: [], unrotatedLogs: [], trashUsage: [], duplicateCandidates: [],
      cleanupCandidates: [], errors: [],
    } as never);

    const raw = await registered.get('analyze_disk_usage')!.handler({ deviceId: DEVICE_ID, path: 'd:/' }, AUTH);

    expect(getLatestFilesystemSnapshot).toHaveBeenCalledWith(DEVICE_ID, 'D:\\');
    expect(JSON.parse(raw).scanPath).toBe('D:\\');
  });

  it('registers the generation before waiting and leaves persistence to the result handler', async () => {
    withDevice('windows');
    vi.mocked(getLatestFilesystemSnapshot).mockResolvedValue(null as never);
    vi.mocked(saveFilesystemSnapshot).mockResolvedValue({
      id: 'snap-new', capturedAt: new Date(), trigger: 'on_demand', partial: false,
      summary: {}, largestFiles: [], largestDirs: [], tempAccumulation: [],
      oldDownloads: [], unrotatedLogs: [], trashUsage: [], duplicateCandidates: [],
      cleanupCandidates: [], errors: [],
    } as never);

    await registered.get('analyze_disk_usage')!.handler({ deviceId: DEVICE_ID, refresh: true, path: 'd:/' }, AUTH);

    expect(aiQueueCommandForExecution).toHaveBeenCalledWith(
      AUTH, 'analyze_disk_usage', DEVICE_ID, 'filesystem_analysis',
      expect.objectContaining({ path: 'D:\\', autoContinue: false }),
      expect.anything(),
    );
    expect(setFilesystemScanGeneration).toHaveBeenCalledWith(DEVICE_ID, 'org-1', 'D:\\', 'cmd-scan');
    expect(vi.mocked(setFilesystemScanGeneration).mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(waitForCommandResult).mock.invocationCallOrder[0]!);
    expect(saveFilesystemSnapshot).not.toHaveBeenCalled();
  });

  it('commits the generation before polling outside the ambient transaction', async () => {
    withDevice('windows');
    vi.mocked(getLatestFilesystemSnapshot).mockResolvedValue(null);
    vi.mocked(setFilesystemScanGeneration).mockImplementationOnce(async () => {
      expect(contextState).toEqual({ outside: true, scoped: true });
    });
    vi.mocked(waitForCommandResult).mockImplementationOnce(async () => {
      expect(contextState).toEqual({ outside: true, scoped: false });
      return { status: 'completed', result: { status: 'completed', stdout: '{}' } } as never;
    });
    await registered.get('analyze_disk_usage')!.handler({ deviceId: DEVICE_ID, refresh: true }, AUTH);
    expect(withDbAccessContext).toHaveBeenCalledWith(
      { scope: 'organization', orgId: 'org-1', accessibleOrgIds: ['org-1'] }, expect.any(Function),
    );
  });

  it('defaults to the OS root, which counts as root-scoped', async () => {
    withDevice('linux');
    vi.mocked(getLatestFilesystemSnapshot).mockResolvedValue(null as never);
    vi.mocked(saveFilesystemSnapshot).mockResolvedValue(null as never);

    await registered.get('analyze_disk_usage')!.handler({ deviceId: DEVICE_ID, refresh: true }, AUTH);

    expect(aiQueueCommandForExecution).toHaveBeenCalledWith(
      AUTH, 'analyze_disk_usage', DEVICE_ID, 'filesystem_analysis',
      expect.objectContaining({ path: '/', autoContinue: true }),
      expect.anything(),
    );
  });
});

describe('disk_cleanup — path (spec §9)', () => {
  it('previews the requested volume and pins it into the stored run', async () => {
    withDevice('windows');
    vi.mocked(getLatestFilesystemCleanupSnapshot).mockResolvedValue({
      id: 'snap-d', scanPath: 'D:\\', capturedAt: new Date(), partial: false, cleanupCandidates: [],
    } as never);
    const values = vi.fn(() => ({ returning: vi.fn().mockResolvedValue([{ id: 'run-1' }]) }));
    vi.mocked(db.insert).mockReturnValue({ values } as never);

    const raw = await registered.get('disk_cleanup')!.handler(
      { deviceId: DEVICE_ID, action: 'preview', path: 'd:/' }, AUTH,
    );

    expect(getLatestFilesystemCleanupSnapshot).toHaveBeenCalledWith(DEVICE_ID, 'D:\\');
    expect(JSON.parse(raw).scanPath).toBe('D:\\');
    expect(values).toHaveBeenCalledWith(expect.objectContaining({
      scanPath: 'D:\\',
      plan: expect.objectContaining({ scanPath: 'D:\\' }),
    }));
  });

  it('defaults to the OS root', async () => {
    withDevice('linux');
    vi.mocked(getLatestFilesystemCleanupSnapshot).mockResolvedValue(null as never);

    const raw = await registered.get('disk_cleanup')!.handler({ deviceId: DEVICE_ID, action: 'preview' }, AUTH);

    expect(getLatestFilesystemCleanupSnapshot).toHaveBeenCalledWith(DEVICE_ID, '/');
    expect(JSON.parse(raw).scanPath).toBe('/');
  });
});
