/**
 * #10416: a tool call that waited on an approval for 30 s or more tells the
 * model how long (`approvalWaitSeconds` on the tool result), so the reply can
 * say the step was waiting rather than leave the user asking "stuck?". The
 * pre-hook (aiAgentSdk.ts) sets `approvalWaitMs` only for Wisp sessions; this
 * suite pins the handler half: both registry handlers apply it the same way.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuthContext } from '../middleware/auth';
import type { ActiveSession } from './streamingSessionManager';

const h = vi.hoisted(() => ({ execute: vi.fn(), capture: vi.fn(), post: vi.fn() }));
vi.mock('../db', () => ({
  runOutsideDbContext: (fn: () => unknown) => fn(),
  withDbAccessContext: (_ctx: unknown, fn: () => unknown) => fn(),
  db: {},
}));
vi.mock('./aiAgent', () => ({ waitForPlanApproval: vi.fn() }));
vi.mock('./sentry', () => ({ captureException: h.capture, captureMessage: vi.fn() }));
vi.mock('./aiTools', async (original) => ({
  ...(await original<typeof import('./aiTools')>()), executeTool: h.execute,
}));
import { __test__, APPROVAL_WAIT_NOTE_MIN_MS, withApprovalWait, type PreToolUseCallback } from './aiAgentSdkTools';

const auth = {
  scope: 'organization', orgId: '00000000-0000-4000-8000-000000000001',
  accessibleOrgIds: ['00000000-0000-4000-8000-000000000001'],
  partnerId: '00000000-0000-4000-8000-000000000002', user: { id: '00000000-0000-4000-8000-000000000003' },
} as AuthContext;
const session = { breezeSessionId: '00000000-0000-4000-8000-000000000004' } as ActiveSession;
const input = { deviceId: '00000000-0000-4000-8000-000000000005' };

describe('withApprovalWait', () => {
  it('adds approvalWaitSeconds (rounded) to a JSON object result at or past the threshold', () => {
    expect(APPROVAL_WAIT_NOTE_MIN_MS).toBe(30_000);
    expect(JSON.parse(withApprovalWait('{"ok":true}', 290_317))).toEqual({ ok: true, approvalWaitSeconds: 290 });
    expect(JSON.parse(withApprovalWait('{"ok":true}', 30_000))).toEqual({ ok: true, approvalWaitSeconds: 30 });
  });

  it('leaves a short wait, no wait, or a non-object result byte-for-byte unchanged', () => {
    expect(withApprovalWait('{"ok":true}', 10_000)).toBe('{"ok":true}');
    expect(withApprovalWait('{"ok":true}', 29_999)).toBe('{"ok":true}');
    expect(withApprovalWait('{"ok":true}', undefined)).toBe('{"ok":true}');
    for (const raw of ['plain text', '[1,2]', 'null', '"str"', '42', '<untrusted_data source="x">\n{}\n</untrusted_data>']) {
      expect(withApprovalWait(raw, 290_000)).toBe(raw);
    }
  });
});

for (const variant of ['registry', 'session-aware'] as const) {
  describe(`${variant} handler: approval wait on the tool result`, () => {
    const make = (pre?: PreToolUseCallback) => variant === 'registry'
      ? __test__.makeToolHandler('get_device_details', () => auth, undefined, pre, h.post)
      : __test__.makeSessionAwareHandler('get_device_details', () => auth, () => session, h.execute, pre, h.post);
    beforeEach(() => {
      vi.clearAllMocks();
      h.execute.mockResolvedValue('{"ok":true}');
      vi.spyOn(console, 'error').mockImplementation(() => undefined);
    });
    afterEach(() => vi.restoreAllMocks());

    it('a step approved after 290 s returns approvalWaitSeconds: 290, and the persisted result matches', async () => {
      const result = await make(async () => ({ allowed: true, approvalWaitMs: 290_000 }))(input);
      const text = (result.content[0] as { text: string }).text;
      expect(JSON.parse(text)).toEqual({ ok: true, approvalWaitSeconds: 290 });
      expect(result.isError).toBeUndefined();
      expect(h.post).toHaveBeenCalledTimes(1);
      const [toolName, args, output, isError] = h.post.mock.calls[0]!;
      expect([toolName, args, output, isError]).toEqual(['get_device_details', input, text, false]);
    });

    it('a 10 s wait, or no wait at all, leaves the result unchanged', async () => {
      for (const pre of [
        async () => ({ allowed: true as const, approvalWaitMs: 10_000 }),
        async () => ({ allowed: true as const }),
      ]) {
        const result = await make(pre)(input);
        expect(result).toEqual({ content: [{ type: 'text', text: '{"ok":true}' }] });
      }
    });

    it('a non-object result is left as is and the wait rides as its own text block', async () => {
      for (const raw of ['plain stdout text', '[{"id":1}]']) {
        h.execute.mockResolvedValue(raw);
        const result = await make(async () => ({ allowed: true, approvalWaitMs: 290_000 }))(input);
        expect(result.content).toEqual([
          { type: 'text', text: raw },
          { type: 'text', text: '{"approvalWaitSeconds":290}' },
        ]);
      }
      h.execute.mockResolvedValue('plain stdout text');
      const short = await make(async () => ({ allowed: true, approvalWaitMs: 10_000 }))(input);
      expect(short.content).toEqual([{ type: 'text', text: 'plain stdout text' }]);
    });

    it('an error result keeps its error classification with the wait added', async () => {
      h.execute.mockResolvedValue('{"error":"device offline"}');
      const result = await make(async () => ({ allowed: true, approvalWaitMs: 60_000 }))(input);
      expect(result.isError).toBe(true);
      expect(JSON.parse((result.content[0] as { text: string }).text)).toEqual({ error: 'device offline', approvalWaitSeconds: 60 });
    });
  });
}

describe('registry handler: a screenshot that waited on an approval', () => {
  const shot = JSON.stringify({ imageBase64: 'aGVsbG8=', format: 'png', width: 10, height: 10, sizeBytes: 5, capturedAt: '2026-11-09T00:00:00Z' });
  const make = (pre?: PreToolUseCallback) => __test__.makeToolHandler('take_screenshot', () => auth, undefined, pre, h.post);
  beforeEach(() => {
    vi.clearAllMocks();
    h.execute.mockResolvedValue(shot);
  });

  it('carries approvalWaitSeconds beside the image after a long wait', async () => {
    const result = await make(async () => ({ allowed: true, approvalWaitMs: 290_000 }))(input);
    expect(result.content[0]).toMatchObject({ type: 'image', data: 'aGVsbG8=' });
    expect(result.content).toContainEqual({ type: 'text', text: '{"approvalWaitSeconds":290}' });
  });

  it('adds nothing after a short wait', async () => {
    const result = await make(async () => ({ allowed: true, approvalWaitMs: 10_000 }))(input);
    expect(JSON.stringify(result.content)).not.toContain('approvalWaitSeconds');
  });
});
