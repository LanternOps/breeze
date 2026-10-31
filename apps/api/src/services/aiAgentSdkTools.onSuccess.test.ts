import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuthContext } from '../middleware/auth';
import type { ActiveSession } from './streamingSessionManager';

const h = vi.hoisted(() => ({ execute: vi.fn(), capture: vi.fn() }));
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
import { __test__, type PreToolUseCallback } from './aiAgentSdkTools';

const auth = {
  scope: 'organization', orgId: '00000000-0000-4000-8000-000000000001',
  accessibleOrgIds: ['00000000-0000-4000-8000-000000000001'],
  partnerId: '00000000-0000-4000-8000-000000000002', user: { id: '00000000-0000-4000-8000-000000000003' },
} as AuthContext;
const session = { breezeSessionId: '00000000-0000-4000-8000-000000000004' } as ActiveSession;
const input = { deviceId: '00000000-0000-4000-8000-000000000005' };

for (const variant of ['registry', 'session-aware'] as const) {
  describe(`${variant} onSuccess`, () => {
    const make = (pre?: PreToolUseCallback) => variant === 'registry'
      ? __test__.makeToolHandler('get_device_details', () => auth, undefined, pre)
      : __test__.makeSessionAwareHandler('get_device_details', () => auth, () => session, h.execute, pre);
    beforeEach(() => {
      vi.clearAllMocks();
      h.execute.mockResolvedValue('{"ok":true}');
      vi.spyOn(console, 'error').mockImplementation(() => undefined);
    });
    afterEach(() => vi.restoreAllMocks());

    it('calls onSuccess once after a successful call with the exact input', async () => {
      const onSuccess = vi.fn(async () => { expect(h.execute).toHaveBeenCalledTimes(1); });
      const result = await make(async () => ({ allowed: true, onSuccess }))(input);
      expect(onSuccess).toHaveBeenCalledExactlyOnceWith(input);
      expect(result).toEqual({ content: [{ type: 'text', text: '{"ok":true}' }] });
    });
    it.each(['{"error":"failed"}', '{"refused":"outside_ceiling"}', '{"refused":false}', '<untrusted_data source="test">\n{"refused":"forbidden"}\n</untrusted_data>'])(
      'does not call onSuccess on an error or refused result: %s', async (raw) => {
        h.execute.mockResolvedValue(raw);
        const onSuccess = vi.fn(async () => {});
        await make(async () => ({ allowed: true, onSuccess }))(input);
        expect(onSuccess).not.toHaveBeenCalled();
      },
    );
    it('does not call onSuccess on a thrown tool error or a pre-tool denial', async () => {
      const onSuccess = vi.fn(async () => {});
      h.execute.mockRejectedValueOnce(new Error('unavailable'));
      expect((await make(async () => ({ allowed: true, onSuccess }))(input)).isError).toBe(true);
      await make(async () => ({ allowed: false, error: 'blocked' }))(input);
      expect(onSuccess).not.toHaveBeenCalled();
      expect(h.execute).toHaveBeenCalledTimes(1);
    });
    it('onSuccess rejection does not change the tool result and is captured', async () => {
      const error = new Error('auto-link unavailable');
      const onSuccess = vi.fn(async () => { throw error; });
      const result = await make(async () => ({ allowed: true, onSuccess }))(input);
      await vi.waitFor(() => expect(h.capture).toHaveBeenCalledWith(error, undefined, { op: 'wisp.auto_link', toolName: 'get_device_details' }));
      expect(result).toEqual({ content: [{ type: 'text', text: '{"ok":true}' }] });
    });
    it('onSuccess synchronous throw does not change the tool result', async () => {
      const error = new Error('synchronous fault');
      const onSuccess = vi.fn((): Promise<void> => { throw error; });
      expect(await make(async () => ({ allowed: true, onSuccess }))(input)).toEqual({ content: [{ type: 'text', text: '{"ok":true}' }] });
      expect(h.capture).toHaveBeenCalledWith(error, undefined, { op: 'wisp.auto_link', toolName: 'get_device_details' });
    });
    it('does not await onSuccess, and a call without it behaves as before', async () => {
      const onSuccess = vi.fn(() => new Promise<void>(() => {}));
      expect((await make(async () => ({ allowed: true, onSuccess }))(input)).isError).toBeUndefined();
      expect(onSuccess).toHaveBeenCalledTimes(1);
      expect(await make()(input)).toEqual({ content: [{ type: 'text', text: '{"ok":true}' }] });
    });
  });
}
