/**
 * #10427 (W08 Task 1): in a Wisp session, a dispatch-class tool that answers
 * "success" with no job, command or intent id reaches the model (and the
 * persisted tool result) as `dispatchUnverified`, and the counter ticks. Any
 * other session, and any result that carries its evidence, is byte-for-byte
 * unchanged.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuthContext } from '../middleware/auth';
import type { ActiveSession } from './streamingSessionManager';

const h = vi.hoisted(() => ({
  execute: vi.fn(),
  post: vi.fn(),
  wispEnabled: vi.fn(() => true),
  incWispDispatchUnverified: vi.fn(),
}));
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
vi.mock('../config/env', async (original) => ({
  ...(await original<typeof import('../config/env')>()), wispEnabled: h.wispEnabled,
}));
vi.mock('./wispMetrics', async (original) => ({
  ...(await original<typeof import('./wispMetrics')>()), incWispDispatchUnverified: h.incWispDispatchUnverified,
}));
import { __test__, type PreToolUseCallback } from './aiAgentSdkTools';
import { DISPATCH_UNVERIFIED_NOTE } from './wisp/dispatchEvidence';

const ORG = '00000000-0000-4000-8000-000000000001';
const auth = {
  scope: 'organization', orgId: ORG, accessibleOrgIds: [ORG],
  partnerId: '00000000-0000-4000-8000-000000000002', user: { id: '00000000-0000-4000-8000-000000000003' },
} as AuthContext;
const wispSession = {
  breezeSessionId: '00000000-0000-4000-8000-000000000004',
  orgId: ORG,
  wispGrant: { grantId: 'g-1', revisionId: 'r-1', threadId: 't-1' },
} as unknown as ActiveSession;
const plainSession = { breezeSessionId: '00000000-0000-4000-8000-000000000005', orgId: ORG, wispGrant: null } as unknown as ActiveSession;
const allow: PreToolUseCallback = async () => ({ allowed: true, toolAuth: auth });

const NO_RUN_ID = JSON.stringify({ queued: true });
const WITH_RUN_ID = JSON.stringify({ queued: true, runId: '00000000-0000-4000-8000-000000000006' });

function handler(session: ActiveSession) {
  return __test__.makeToolHandler('run_patch_plan', () => auth, () => session, allow, h.post);
}
const textOf = (result: { content: unknown[] }) => (result.content[0] as { text: string }).text;

describe('makeHandler: dispatch evidence (#10427)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.wispEnabled.mockReturnValue(true);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });
  afterEach(() => vi.restoreAllMocks());

  it('a Wisp dispatch with no id reads as unverified, for the model and for the persisted result', async () => {
    h.execute.mockResolvedValue(NO_RUN_ID);
    const result = await handler(wispSession)({ orgId: ORG });
    const text = textOf(result);
    expect(JSON.parse(text)).toEqual({ success: false, dispatchUnverified: true, note: DISPATCH_UNVERIFIED_NOTE, result: { queued: true } });
    expect(result.isError).toBeUndefined();
    expect(h.post).toHaveBeenCalledTimes(1);
    expect(h.post.mock.calls[0]![2]).toBe(text);
    expect(h.incWispDispatchUnverified).toHaveBeenCalledWith('run_patch_plan');
  });

  it('a Wisp dispatch that carries its id is unchanged', async () => {
    h.execute.mockResolvedValue(WITH_RUN_ID);
    const result = await handler(wispSession)({ orgId: ORG });
    expect(textOf(result)).toBe(WITH_RUN_ID);
    expect(h.incWispDispatchUnverified).not.toHaveBeenCalled();
  });

  it('an ordinary session is never touched', async () => {
    h.execute.mockResolvedValue(NO_RUN_ID);
    const result = await handler(plainSession)({ orgId: ORG });
    expect(textOf(result)).toBe(NO_RUN_ID);
    expect(h.incWispDispatchUnverified).not.toHaveBeenCalled();
  });

  it('with Wisp switched off nothing is touched', async () => {
    h.wispEnabled.mockReturnValue(false);
    h.execute.mockResolvedValue(NO_RUN_ID);
    const result = await handler(wispSession)({ orgId: ORG });
    expect(textOf(result)).toBe(NO_RUN_ID);
  });
});
