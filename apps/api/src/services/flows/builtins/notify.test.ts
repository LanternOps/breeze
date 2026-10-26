import { beforeEach, describe, expect, it, vi } from 'vitest';

const send = vi.hoisted(() => vi.fn());
vi.mock('../../notificationSenders/channelMessage', () => ({ sendChannelMessage: send }));

import { executeNotifyStep } from './notify';
import type { BuiltinContext } from './types';

const CH = '7d1c3a5e-2b4f-4c6a-9e8d-1f2a3b4c5d6e';
const owner = { orgId: '11111111-1111-4111-8111-111111111111', partnerId: '22222222-2222-4222-8222-222222222222' };
const ctx = (n = 1) => ({ run: { flowId: 'flow-1' }, owner, counters: { notify: n, http: 0 } }) as unknown as BuiltinContext;
const input = { channelId: CH, title: 'Done', message: 'All good', severity: 'info' as const };

beforeEach(() => send.mockReset());

describe('executeNotifyStep', () => {
  it('sends once and outputs sent', async () => {
    send.mockResolvedValue({ ok: true, channelId: CH, channelType: 'slack' });
    const out = await executeNotifyStep(input, ctx());
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith(CH, { title: 'Done', body: 'All good', severity: 'info', link: '/flows/flow-1' }, owner);
    expect(out).toEqual({ kind: 'completed', output: { channelId: CH, sent: true }, truncated: false });
  });

  it('21st notify in a run fails policy', async () => {
    const out = await executeNotifyStep(input, ctx(21));
    expect(send).not.toHaveBeenCalled();
    expect(out).toMatchObject({ kind: 'failed', code: 'notify_failed', policy: true });
    expect((out as { message: string }).message).toContain('20');
  });

  it('20th notify still sends', async () => {
    send.mockResolvedValue({ ok: true, channelId: CH, channelType: 'email' });
    expect((await executeNotifyStep(input, ctx(20))).kind).toBe('completed');
  });

  it('sender error fails with notify_failed', async () => {
    send.mockResolvedValue({ ok: false, code: 'send_failed', message: 'smtp down' });
    const out = await executeNotifyStep(input, ctx());
    expect(out).toMatchObject({ kind: 'failed', code: 'notify_failed', message: 'smtp down', policy: false });
  });
});
