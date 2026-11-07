import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuthContext } from '../middleware/auth';

const h = vi.hoisted(() => ({ execute: vi.fn(), raw: vi.fn() }));
vi.mock('../db', () => ({
  runOutsideDbContext: (fn: () => unknown) => fn(),
  withDbAccessContext: (_ctx: unknown, fn: () => unknown) => fn(),
  db: {},
}));
vi.mock('./aiAgent', () => ({ waitForPlanApproval: vi.fn() }));
vi.mock('./sentry', () => ({ captureException: vi.fn(), captureMessage: vi.fn() }));
vi.mock('./aiTools', async (original) => ({
  ...(await original<typeof import('./aiTools')>()), executeTool: h.execute,
}));
vi.mock('./aiDispatch', async (original) => ({
  ...(await original<typeof import('./aiDispatch')>()),
  aiQueueCommandForExecution: h.raw, aiQueueCommand: h.raw, aiExecuteCommand: h.raw,
  aiExecuteCommandWithSystemPrecheck: h.raw, aiDispatchDeviceCommand: h.raw, aiInsertQueuedCommandInTransaction: h.raw,
}));
import { __test__ } from './aiAgentSdkTools';

const auth = {
  scope: 'organization', orgId: '00000000-0000-4000-8000-000000000001',
  accessibleOrgIds: ['00000000-0000-4000-8000-000000000001'],
  partnerId: '00000000-0000-4000-8000-000000000002', user: { id: '00000000-0000-4000-8000-000000000003' },
} as AuthContext;
const deviceId = '00000000-0000-4000-8000-000000000005';

// #10919: the SDK lane adds no dispatch of its own. Past the pre-tool gate it reaches only
// executeTool, whose execute_containment and release_containment handlers call the isolation
// service (networkIsolation.bypass.allowlist.test.ts, aiToolsIncident.releaseContainment.service.test.ts).
describe('agent SDK network-isolation path', () => {
  beforeEach(() => { vi.clearAllMocks(); h.execute.mockResolvedValue('{"ok":true}'); });

  it.each([
    ['execute_containment', { deviceId, incidentId: 'incident', actionType: 'network_isolation', reason: 'Contain', parameters: { allow: [{ scope: 'any' }] } }],
    ['release_containment', { deviceId, isolationId: 'episode', generation: 2, reason: 'Clean' }],
  ])('hands %s to the registry handler and queues nothing itself', async (tool, input) => {
    const handler = __test__.makeHandler(tool, () => auth, async () => ({ allowed: true }));
    await handler(input);
    expect(h.execute).toHaveBeenCalledTimes(1);
    expect(h.execute.mock.calls[0]!.slice(0, 2)).toEqual([tool, input]);
    expect(h.raw).not.toHaveBeenCalled();
  });
  it('runs nothing when the pre-tool gate refuses', async () => {
    const handler = __test__.makeHandler('release_containment', () => auth, async () => ({ allowed: false, error: 'approval required' }));
    await handler({ deviceId, isolationId: 'episode', generation: 2, reason: 'Clean' });
    expect(h.execute).not.toHaveBeenCalled();
    expect(h.raw).not.toHaveBeenCalled();
  });
});
