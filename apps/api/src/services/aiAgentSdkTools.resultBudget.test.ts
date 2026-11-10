/**
 * #11394: every chat-session tool-result path compacts with the session's
 * `toolExposure.resultCharBudget`; a session with no exposure (or `full`)
 * stays at the 8000 default.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuthContext } from '../middleware/auth';
import type { ActiveSession } from './streamingSessionManager';

const h = vi.hoisted(() => ({ execute: vi.fn(), post: vi.fn() }));
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
import { __test__, sessionResultCharBudget } from './aiAgentSdkTools';
import { compactToolResultForChat, MAX_TOOL_RESULT_CHARS } from './aiToolOutput';

const auth = {
  scope: 'organization', orgId: '00000000-0000-4000-8000-000000000001',
  accessibleOrgIds: ['00000000-0000-4000-8000-000000000001'],
  partnerId: '00000000-0000-4000-8000-000000000002', user: { id: '00000000-0000-4000-8000-000000000003' },
} as AuthContext;
const withBudget = (resultCharBudget?: number) => ({
  breezeSessionId: '00000000-0000-4000-8000-000000000004',
  ...(resultCharBudget === undefined ? {} : { toolExposure: { resultCharBudget } }),
}) as unknown as ActiveSession;
const input = { deviceId: '00000000-0000-4000-8000-000000000005' };
// A ~6,000-char structured result (rows of ~40 chars each).
const big = JSON.stringify({ rows: Array.from({ length: 120 }, (_, i) => ({ i, pad: 'p'.repeat(30) })) });
const envelope = JSON.stringify({
  artifact: { handle: '00000000-0000-4000-8000-0000000000a4', bytes: 30_120, contentType: 'text/plain', head: 'h', tail: 't' },
  compacted: big,
});
const textOf = (r: { content: Array<{ type: string; text?: string }> }) => r.content[0]!.text as string;

describe('sessionResultCharBudget', () => {
  it('reads the session budget, defaulting to 8000 when absent, undefined or throwing', () => {
    expect(sessionResultCharBudget(() => withBudget(2000))).toBe(2000);
    expect(sessionResultCharBudget(() => withBudget())).toBe(MAX_TOOL_RESULT_CHARS);
    expect(sessionResultCharBudget(() => undefined)).toBe(MAX_TOOL_RESULT_CHARS);
    expect(sessionResultCharBudget(undefined)).toBe(MAX_TOOL_RESULT_CHARS);
    expect(sessionResultCharBudget(() => { throw new Error('boom'); })).toBe(MAX_TOOL_RESULT_CHARS);
  });
});

for (const variant of ['registry', 'session-aware'] as const) {
  describe(`${variant} handler honours the session result budget`, () => {
    const make = (session: ActiveSession) => variant === 'registry'
      ? __test__.makeToolHandler('get_device_details', () => auth, () => session, undefined, h.post)
      : __test__.makeSessionAwareHandler('get_device_details', () => auth, () => session, h.execute, undefined, h.post);
    beforeEach(() => {
      vi.clearAllMocks();
      vi.spyOn(console, 'error').mockImplementation(() => undefined);
    });

    it('compacts a 6000-char result to <= 2000 under a 2000 budget', async () => {
      h.execute.mockResolvedValue(big);
      const text = textOf(await make(withBudget(2000))(input));
      expect(text.length).toBeLessThanOrEqual(2000);
      expect(text).toBe(compactToolResultForChat('get_device_details', big, 2000));
    });

    it('keeps the capture envelope artifact block under a 2000 budget', async () => {
      h.execute.mockResolvedValue(envelope);
      const text = textOf(await make(withBudget(2000))(input));
      expect(text.length).toBeLessThanOrEqual(2000);
      expect(JSON.parse(text).artifact.handle).toBe('00000000-0000-4000-8000-0000000000a4');
    });

    it('no toolExposure and budget 8000 equal the default compaction', async () => {
      h.execute.mockResolvedValue(big);
      const expected = compactToolResultForChat('get_device_details', big);
      expect(textOf(await make(withBudget())(input))).toBe(expected);
      expect(textOf(await make(withBudget(8000))(input))).toBe(expected);
    });
  });
}
