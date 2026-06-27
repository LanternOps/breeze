import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../db', () => ({
  runOutsideDbContext: vi.fn((fn) => fn()),
  withDbAccessContext: vi.fn(async (_ctx: unknown, fn: () => Promise<unknown>) => fn()),
  withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
  db: {
    select: vi.fn(),
  },
}));

// Importing aiGuardrails (for the gate-coverage assertion) pulls in the full
// aiTools registry, whose other tools read CommandTypes constants. Provide a
// Proxy so any `CommandTypes.X` access resolves to the string "X".
vi.mock('./commandQueue', () => ({
  executeCommand: vi.fn(),
  queueCommandForExecution: vi.fn(),
  CommandTypes: new Proxy({}, { get: (_t, prop) => String(prop) }),
}));

import { db } from '../db';
import type { AuthContext } from '../middleware/auth';
import type { AiTool } from './aiTools';
import { executeCommand } from './commandQueue';
import { registerAgentMgmtTools } from './aiToolsAgentMgmt';
import { TOOL_PERMISSIONS } from './aiGuardrails';

const ORG_ID = '11111111-1111-1111-1111-111111111111';
const DEVICE_ID = '33333333-3333-3333-3333-333333333333';
const OTHER_DEVICE_ID = '44444444-4444-4444-4444-444444444444';

function createQueryChain(rows: any[] = []) {
  const chain: any = {};
  chain.from = vi.fn(() => chain);
  chain.where = vi.fn(() => chain);
  chain.limit = vi.fn(() => chain);
  chain.then = (resolve: (value: any[]) => unknown, reject?: (error: unknown) => unknown) =>
    Promise.resolve(rows).then(resolve, reject);
  return chain;
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
  registerAgentMgmtTools(toolMap);
  return toolMap;
}

// A silent/wedged device — deliberately NOT online, since that is exactly the
// state this tool exists to recover.
function offlineDeviceRow() {
  return { id: DEVICE_ID, orgId: ORG_ID, siteId: null, status: 'offline', hostname: 'wedged-pc' };
}

describe('trigger_agent_restart', () => {
  let tool: AiTool;

  beforeEach(() => {
    vi.clearAllMocks();
    // executeCommand resolves a CommandResult; 'completed' = dispatched.
    vi.mocked(executeCommand).mockResolvedValue({ status: 'completed', result: {} } as any);
    tool = buildToolMap().get('trigger_agent_restart')!;
  });

  it('is registered as a Tier 3 device tool gating deviceIds', () => {
    expect(tool).toBeDefined();
    expect(tool.tier).toBe(3);
    expect(tool.deviceArgs).toEqual(['deviceIds']);
  });

  it('is present in the TOOL_PERMISSIONS gate (dual-map drift guard)', () => {
    // A tool absent from TOOL_PERMISSIONS 404s at execute time. Lock it here.
    expect(TOOL_PERMISSIONS.trigger_agent_restart).toEqual({ resource: 'devices', action: 'execute' });
  });

  it('dispatches restart_agent to the WATCHDOG, even for an offline agent', async () => {
    // select #1: verifyDeviceAccess. select #2: org-wide access check.
    mockSelectSequence([[offlineDeviceRow()], [{ id: DEVICE_ID }]]);

    const raw = await tool.handler({ deviceIds: [DEVICE_ID] }, makeAuth());
    const result = JSON.parse(raw);

    expect(result).toEqual({ requested: 1, queued: 1, action: 'restart_agent' });
    expect(executeCommand).toHaveBeenCalledTimes(1);
    expect(executeCommand).toHaveBeenCalledWith(
      DEVICE_ID,
      'restart_agent',
      {},
      expect.objectContaining({ targetRole: 'watchdog', userId: 'user-1' }),
    );
  });

  it('counts a RETURNED status:failed as an error, not a queued success', async () => {
    // executeCommand signals dispatch failure by returning, not throwing. The
    // handler must surface it in `errors` and NOT increment `queued` — this is
    // the regression guard for the silent-success bug.
    mockSelectSequence([[offlineDeviceRow()], [{ id: DEVICE_ID }]]);
    vi.mocked(executeCommand).mockResolvedValue({
      status: 'failed',
      error: 'Watchdog is not reporting; cannot dispatch watchdog command',
    } as any);

    const result = JSON.parse(await tool.handler({ deviceIds: [DEVICE_ID] }, makeAuth()));

    expect(result.queued).toBe(0);
    expect(result.requested).toBe(1);
    expect(result.errors[DEVICE_ID]).toMatch(/watchdog is not reporting/i);
  });

  it('reports partial failure across multiple devices', async () => {
    mockSelectSequence([[offlineDeviceRow()], [{ id: DEVICE_ID }, { id: OTHER_DEVICE_ID }]]);
    vi.mocked(executeCommand)
      .mockResolvedValueOnce({ status: 'completed', result: {} } as any)
      .mockResolvedValueOnce({ status: 'failed', error: 'Device not found' } as any);

    const result = JSON.parse(
      await tool.handler({ deviceIds: [DEVICE_ID, OTHER_DEVICE_ID] }, makeAuth()),
    );

    expect(result).toEqual({
      requested: 2,
      queued: 1,
      action: 'restart_agent',
      errors: { [OTHER_DEVICE_ID]: 'Device not found' },
    });
    expect(executeCommand).toHaveBeenCalledTimes(2);
  });

  it('denies a device inside the org but outside the caller site allowlist', async () => {
    // verifyDeviceAccess enforces a second axis: auth.canAccessSite(siteId).
    const siteScopedAuth = { ...makeAuth(), canAccessSite: () => false } as any;
    mockSelectSequence([[{ ...offlineDeviceRow(), siteId: 'site-out-of-scope' }]]);

    const result = JSON.parse(await tool.handler({ deviceIds: [DEVICE_ID] }, siteScopedAuth));

    expect(result.error).toMatch(/not found or access denied/i);
    expect(executeCommand).not.toHaveBeenCalled();
  });

  it('refuses and dispatches nothing when a deviceId is outside the caller org', async () => {
    // select #1 grants access to the first device; select #2 (org-wide) returns
    // only DEVICE_ID, so OTHER_DEVICE_ID is denied and the whole call aborts.
    mockSelectSequence([[offlineDeviceRow()], [{ id: DEVICE_ID }]]);

    const raw = await tool.handler({ deviceIds: [DEVICE_ID, OTHER_DEVICE_ID] }, makeAuth());
    const result = JSON.parse(raw);

    expect(result.error).toContain(OTHER_DEVICE_ID);
    expect(executeCommand).not.toHaveBeenCalled();
  });

  it('rejects an empty deviceIds list without touching the DB', async () => {
    const raw = await tool.handler({ deviceIds: [] }, makeAuth());
    expect(JSON.parse(raw).error).toMatch(/deviceIds/);
    expect(db.select).not.toHaveBeenCalled();
    expect(executeCommand).not.toHaveBeenCalled();
  });
});
