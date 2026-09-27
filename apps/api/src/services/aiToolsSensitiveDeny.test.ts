/**
 * Regression coverage: the AI/MCP tool surface (file_operations,
 * registry_operations) dispatches straight to aiExecuteCommand and never
 * passes through routes/systemTools/*, so it never picked up the server-side
 * deny that blocks the agent's own config/secrets directory and the
 * SAM/SECURITY registry hives — even though the REST routes for the same
 * operations do. This file proves both tools apply the same deny,
 * regardless of the caller's permission tier.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../db', () => ({
  runOutsideDbContext: vi.fn((fn) => fn()),
  withDbAccessContext: vi.fn(async (_ctx: unknown, fn: () => Promise<unknown>) => fn()),
  withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
  db: { select: vi.fn() },
}));

vi.mock('./commandQueue', () => ({
  CommandTypes: new Proxy({}, { get: (_t, prop) => String(prop) }),
}));

vi.mock('./aiDispatch', () => ({
  aiExecuteCommand: vi.fn(async () => ({ status: 'completed', stdout: '{}' })),
  aiExecuteCommandWithSystemPrecheck: vi.fn(async () => ({ status: 'completed', stdout: '{}' })),
  aiDispatchScriptToDevice: vi.fn(async () => ({ status: 'completed', stdout: '{}' })),
  requireAiOrigin: vi.fn(),
}));

vi.mock('./filesystemAnalysis', () => ({
  buildCleanupPreview: vi.fn(),
  getLatestFilesystemSnapshot: vi.fn(),
  parseFilesystemAnalysisStdout: vi.fn(),
  saveFilesystemSnapshot: vi.fn(),
  safeCleanupCategories: [],
}));

import { db } from '../db';
import type { AuthContext } from '../middleware/auth';
import type { AiTool } from './aiTools';
import { aiExecuteCommand } from './aiDispatch';
import { registerFilesystemTools } from './aiToolsFilesystem';
import { registerScriptTools } from './aiToolsScripts';

const ORG_ID = '11111111-1111-1111-1111-111111111111';
const DEVICE_ID = '33333333-3333-3333-3333-333333333333';

function createQueryChain(rows: any[] = []) {
  const chain: any = {};
  chain.from = vi.fn(() => chain);
  chain.where = vi.fn(() => chain);
  chain.limit = vi.fn(() => chain);
  chain.then = (resolve: (value: any[]) => unknown, reject?: (error: unknown) => unknown) =>
    Promise.resolve(rows).then(resolve, reject);
  return chain;
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

function getFileOperationsTool(): AiTool {
  const aiTools = new Map<string, AiTool>();
  registerFilesystemTools(aiTools);
  const tool = aiTools.get('file_operations');
  if (!tool) throw new Error('file_operations tool not registered');
  return tool;
}

function getRegistryOperationsTool(): AiTool {
  const aiTools = new Map<string, AiTool>();
  registerScriptTools(aiTools);
  const tool = aiTools.get('registry_operations');
  if (!tool) throw new Error('registry_operations tool not registered');
  return tool;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(db.select).mockImplementation(
    () =>
      createQueryChain([
        { id: DEVICE_ID, orgId: ORG_ID, siteId: null, hostname: 'host-1', status: 'online' },
      ]) as any,
  );
});

describe('file_operations sensitive-path deny', () => {
  it('denies reading the agent config directory', async () => {
    const tool = getFileOperationsTool();
    const result = JSON.parse(
      await tool.handler(
        { deviceId: DEVICE_ID, action: 'read', path: String.raw`C:\ProgramData\Breeze\secrets.yaml` },
        makeAuth(),
      ),
    );

    expect(result.error).toBeTruthy();
    expect(aiExecuteCommand).not.toHaveBeenCalled();
  });

  it('denies writing into the agent config directory', async () => {
    const tool = getFileOperationsTool();
    const result = JSON.parse(
      await tool.handler(
        { deviceId: DEVICE_ID, action: 'write', path: '/etc/breeze/secrets.yaml', content: 'x' },
        makeAuth(),
      ),
    );

    expect(result.error).toBeTruthy();
    expect(aiExecuteCommand).not.toHaveBeenCalled();
  });

  it('denies renaming into the agent config directory', async () => {
    const tool = getFileOperationsTool();
    const result = JSON.parse(
      await tool.handler(
        { deviceId: DEVICE_ID, action: 'rename', path: '/tmp/ordinary.txt', newPath: '/etc/breeze/secrets.yaml' },
        makeAuth(),
      ),
    );

    expect(result.error).toBeTruthy();
    expect(aiExecuteCommand).not.toHaveBeenCalled();
  });

  it('allows an ordinary path', async () => {
    const tool = getFileOperationsTool();
    await tool.handler(
      { deviceId: DEVICE_ID, action: 'read', path: '/tmp/ordinary.txt' },
      makeAuth(),
    );

    expect(aiExecuteCommand).toHaveBeenCalled();
  });
});

describe('registry_operations sensitive-path deny', () => {
  it('denies reading HKLM\\SAM', async () => {
    const tool = getRegistryOperationsTool();
    const result = JSON.parse(
      await tool.handler(
        { deviceId: DEVICE_ID, action: 'read_key', keyPath: String.raw`HKLM\SAM` },
        makeAuth(),
      ),
    );

    expect(result.error).toBeTruthy();
    expect(aiExecuteCommand).not.toHaveBeenCalled();
  });

  it('denies setting a value under HKLM\\SECURITY', async () => {
    const tool = getRegistryOperationsTool();
    const result = JSON.parse(
      await tool.handler(
        {
          deviceId: DEVICE_ID,
          action: 'set_value',
          keyPath: String.raw`HKLM\SECURITY\Policy\Secrets`,
          valueName: 'foo',
          valueData: 'bar',
          valueType: 'REG_SZ',
        },
        makeAuth(),
      ),
    );

    expect(result.error).toBeTruthy();
    expect(aiExecuteCommand).not.toHaveBeenCalled();
  });

  it('allows an ordinary registry key', async () => {
    const tool = getRegistryOperationsTool();
    await tool.handler(
      { deviceId: DEVICE_ID, action: 'read_key', keyPath: String.raw`HKLM\SOFTWARE\Microsoft` },
      makeAuth(),
    );

    expect(aiExecuteCommand).toHaveBeenCalled();
  });
});
