import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../db', () => ({
  runOutsideDbContext: vi.fn((fn) => fn()),
  withDbAccessContext: vi.fn(async (_ctx: unknown, fn: () => Promise<unknown>) => fn()),
  withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
  db: {
    select: vi.fn(),
  },
}));

vi.mock('./commandQueue', () => ({
  executeCommand: vi.fn(async () => ({ status: 'completed', stdout: '{}' })),
  CommandTypes: new Proxy({}, { get: (_t, prop) => String(prop) }),
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
import { executeCommand } from './commandQueue';
import { registerFilesystemTools } from './aiToolsFilesystem';
import { AGENT_MAX_FILE_WRITE_BYTES } from '../routes/systemTools/schemas';

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
  } as any;
}

function getFileOperationsTool(): AiTool {
  const aiTools = new Map<string, AiTool>();
  registerFilesystemTools(aiTools);
  const tool = aiTools.get('file_operations');
  if (!tool) throw new Error('file_operations tool not registered');
  return tool;
}

// Regression for #2399: the file_operations AI tool is a file_write producer
// that bypasses fileUploadBodySchema. Without this cap it could dispatch a
// single-frame file_write exceeding the agent's 16MB WS read limit, which
// kills the agent's connection (gorilla ErrReadLimit) instead of returning an
// error. The tool must reject oversized content BEFORE executeCommand.
describe('file_operations write size cap (#2399)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(db.select).mockImplementation(
      () =>
        createQueryChain([
          { id: DEVICE_ID, orgId: ORG_ID, siteId: null, hostname: 'host-1', status: 'online' },
        ]) as any,
    );
  });

  it('rejects write content over the agent 4MB cap without dispatching', async () => {
    const tool = getFileOperationsTool();
    const result = JSON.parse(
      await tool.handler(
        {
          deviceId: DEVICE_ID,
          action: 'write',
          path: '/tmp/big.txt',
          content: 'x'.repeat(AGENT_MAX_FILE_WRITE_BYTES + 1),
        },
        makeAuth(),
      ),
    );

    expect(result.error).toContain('too large');
    expect(executeCommand).not.toHaveBeenCalled();
  });

  it('measures UTF-8 bytes, not string length', async () => {
    const tool = getFileOperationsTool();
    // 'é' is 1 UTF-16 code unit but 2 UTF-8 bytes: 2.5M chars = 5MB > 4MB.
    const result = JSON.parse(
      await tool.handler(
        { deviceId: DEVICE_ID, action: 'write', path: '/tmp/big.txt', content: 'é'.repeat(2_500_000) },
        makeAuth(),
      ),
    );

    expect(result.error).toContain('too large');
    expect(executeCommand).not.toHaveBeenCalled();
  });

  it('dispatches writes at or under the cap', async () => {
    const tool = getFileOperationsTool();
    await tool.handler(
      {
        deviceId: DEVICE_ID,
        action: 'write',
        path: '/tmp/ok.txt',
        content: 'x'.repeat(AGENT_MAX_FILE_WRITE_BYTES),
      },
      makeAuth(),
    );

    expect(executeCommand).toHaveBeenCalledTimes(1);
    expect(vi.mocked(executeCommand).mock.calls[0]?.[1]).toBe('file_write');
  });

  it('does not apply the cap to non-write actions', async () => {
    const tool = getFileOperationsTool();
    await tool.handler(
      { deviceId: DEVICE_ID, action: 'read', path: '/tmp/file.txt' },
      makeAuth(),
    );

    expect(executeCommand).toHaveBeenCalledTimes(1);
    expect(vi.mocked(executeCommand).mock.calls[0]?.[1]).toBe('file_read');
  });
});
