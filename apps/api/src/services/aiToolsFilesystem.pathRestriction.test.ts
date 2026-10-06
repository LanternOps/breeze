import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * analyze_disk_usage normalises its `path` (normalizeScanPath) before it keys a
 * snapshot or dispatches `filesystem_analysis`, and normalisation can turn one
 * spelling into another (`C:Users\x` becomes `C:\Users\x`). The default AI path
 * restriction must hold for the value actually used, not only for the raw
 * input the schema saw, so the handler re-checks the normalised scan root.
 *
 * Harness copied from aiToolsFilesystem.scanPath.test.ts.
 */

const registered = new Map<string, { handler: (input: Record<string, unknown>, auth: unknown) => Promise<string> }>();

vi.mock('../db', () => ({
  // These handlers run as under the per-call transaction: `inToolDbPhase`
  // (#7918) joins it rather than opening a context of its own.
  hasDbAccessContext: vi.fn(() => true),
  runOutsideDbContext: vi.fn(async (fn) => fn()),
  withDbAccessContext: vi.fn(async (_context, fn) => fn()),
  db: {
    select: vi.fn(),
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
  getLatestFilesystemSnapshot: vi.fn(async () => null),
  getLatestFilesystemCleanupSnapshot: vi.fn(),
  parseFilesystemAnalysisStdout: vi.fn(() => ({ summary: { filesScanned: 1 } })),
  saveFilesystemSnapshot: vi.fn(),
  setFilesystemScanGeneration: vi.fn(),
  clearFilesystemScanGeneration: vi.fn(),
  safeCleanupCategories: ['temp_files', 'browser_cache', 'package_cache', 'trash'],
}));

import { db } from '../db';
import { aiExecuteCommand } from './aiDispatch';
import { getLatestFilesystemSnapshot, setFilesystemScanGeneration } from './filesystemAnalysis';
import { registerFilesystemTools } from './aiToolsFilesystem';

const DEVICE_ID = '11111111-1111-1111-1111-111111111111';
const AUTH = {
  user: { id: 'user-1' },
  orgCondition: () => undefined,
  allowedDeviceIds: null,
} as never;

function withDevice(osType: 'windows' | 'linux' | 'macos') {
  vi.mocked(db.select).mockReturnValue({
    from: vi.fn(() => ({
      where: vi.fn(() => ({ limit: vi.fn().mockResolvedValue([{ id: DEVICE_ID, orgId: 'org-1', osType, status: 'online' }]) })),
    })),
  } as never);
}

beforeEach(() => {
  vi.clearAllMocks();
  registered.clear();
  registerFilesystemTools(registered as never);
});

describe('analyze_disk_usage: the normalised scan root is checked before use', () => {
  it.each([
    'C:Users\\bob\\AppData',
    'c:users/bob/appdata/local',
    '/Users/bob/AppData/Local',
    'C:\\Documents and Settings\\bob\\Application Data',
    '  C:\\Users\\bob\\Local Settings  ',
  ])('refuses %j on a Windows device without scanning', async (path) => {
    withDevice('windows');

    const result = JSON.parse(await registered.get('analyze_disk_usage')!.handler(
      { deviceId: DEVICE_ID, refresh: true, path }, AUTH,
    ));

    expect(result.error).toMatch(/blocked/);
    expect(aiExecuteCommand).not.toHaveBeenCalled();
    expect(setFilesystemScanGeneration).not.toHaveBeenCalled();
    expect(getLatestFilesystemSnapshot).not.toHaveBeenCalled();
  });

  it.each(['/run/secrets', '/private/var/run'])('refuses %s on a POSIX device without scanning', async (path) => {
    withDevice('linux');

    const result = JSON.parse(await registered.get('analyze_disk_usage')!.handler(
      { deviceId: DEVICE_ID, refresh: true, path }, AUTH,
    ));

    expect(result.error).toMatch(/blocked/);
    expect(aiExecuteCommand).not.toHaveBeenCalled();
  });

  it.each([
    { osType: 'windows' as const, path: undefined, scanPath: 'C:\\' },
    { osType: 'windows' as const, path: 'd:/', scanPath: 'D:\\' },
    { osType: 'windows' as const, path: 'C:\\Users\\bob\\Downloads', scanPath: 'C:\\Users\\bob\\Downloads' },
    { osType: 'linux' as const, path: undefined, scanPath: '/' },
    { osType: 'linux' as const, path: '/var/log', scanPath: '/var/log' },
  ])('still scans $scanPath ($osType)', async ({ osType, path, scanPath }) => {
    withDevice(osType);

    await registered.get('analyze_disk_usage')!.handler(
      { deviceId: DEVICE_ID, refresh: true, ...(path === undefined ? {} : { path }) }, AUTH,
    );

    expect(aiExecuteCommand).toHaveBeenCalledWith(
      AUTH, 'analyze_disk_usage', DEVICE_ID, 'filesystem_analysis',
      expect.objectContaining({ path: scanPath }),
      expect.anything(),
    );
  });
});
