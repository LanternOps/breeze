import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./notify', () => ({ executeNotifyStep: vi.fn() }));
vi.mock('./httpRequest', () => ({ executeHttpRequestStep: vi.fn() }));
vi.mock('./aiStep', () => ({ executeAiStep: vi.fn() }));

import type { BuiltinContext } from './types';
import { executeAiStep } from './aiStep';
import { executeHttpRequestStep } from './httpRequest';
import { executeFlowBuiltin } from './index';
import { executeNotifyStep } from './notify';

const ctx = (over: Partial<BuiltinContext> = {}): BuiltinContext => ({
  run: { id: 'r1', orgId: 'o1' } as never,
  version: {} as never,
  step: { id: 's1', tool: 'http_request', input: { method: 'GET', url: 'https://api.example.com/items/{{inputs.id}}' } } as never,
  owner: { orgId: 'o1', partnerId: 'p1' },
  auth: {} as never,
  stepRowId: 'row1',
  deadline: Date.now() + 60_000,
  counters: { notify: 1, http: 1 },
  leaseToken: 'lease-1',
  ...over,
});

beforeEach(() => {
  vi.mocked(executeNotifyStep).mockReset().mockResolvedValue({ kind: 'completed', output: { sent: true }, truncated: false });
  vi.mocked(executeHttpRequestStep).mockReset().mockResolvedValue({ kind: 'completed', output: { status: 200 }, truncated: false });
  vi.mocked(executeAiStep).mockReset().mockResolvedValue({ kind: 'completed', output: { result: {} }, truncated: false });
});

describe('executeFlowBuiltin', () => {
  it('set and wait still dispatch (W04 behaviour)', async () => {
    expect(await executeFlowBuiltin('set', { values: { a: 1, b: 'x' } }, ctx()))
      .toEqual({ kind: 'completed', output: { a: 1, b: 'x' }, truncated: false, renderedInput: { values: { a: 1, b: 'x' } } });
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2027-01-10T10:00:00.000Z'));
    try {
      expect(await executeFlowBuiltin('wait', { minutes: 2 }, ctx())).toEqual({
        kind: 'park_wait', resumeAt: new Date('2027-01-10T10:02:00.000Z'), output: { waitUntil: '2027-01-10T10:02:00.000Z' },
        renderedInput: { minutes: 2 },
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('an invalid set/wait input is a policy input_invalid', async () => {
    expect(await executeFlowBuiltin('wait', { minutes: 0 }, ctx())).toMatchObject({ kind: 'failed', code: 'input_invalid', policy: true });
  });

  it('notify, http_request and ai dispatch to their executors with the context', async () => {
    const c = ctx();
    const CH = '7d1c3a5e-2b4f-4c6a-9e8d-1f2a3b4c5d6e';
    await executeFlowBuiltin('notify', { channelId: CH, title: 't', message: 'm', severity: 'info' }, c);
    expect(executeNotifyStep).toHaveBeenCalledWith({ channelId: CH, title: 't', message: 'm', severity: 'info' }, c);
    await executeFlowBuiltin('http_request', { method: 'GET', url: 'https://api.example.com/items/7' }, c);
    // The literal origin comes from the PUBLICATION's step, never from the rendered input.
    expect(executeHttpRequestStep).toHaveBeenCalledWith({ method: 'GET', url: 'https://api.example.com/items/7' }, { ...c, literalOrigin: 'https://api.example.com' });
    await executeFlowBuiltin('ai', { prompt: 'p', tools: [], output: { type: 'object' }, maxTurns: 4, maxOutputTokens: 1024 }, c);
    expect(executeAiStep).toHaveBeenCalledWith(expect.objectContaining({ prompt: 'p' }), c);
  });

  it('an http_request whose publication URL has no literal origin is egress_blocked and never dispatches', async () => {
    const c = ctx({ step: { id: 's1', tool: 'http_request', input: { method: 'GET', url: '{{inputs.u}}' } } as never });
    expect(await executeFlowBuiltin('http_request', { method: 'GET', url: 'https://api.example.com/x' }, c))
      .toMatchObject({ kind: 'failed', code: 'egress_blocked', policy: true });
    expect(executeHttpRequestStep).not.toHaveBeenCalled();
  });

  it('an unknown name throws', async () => {
    await expect(executeFlowBuiltin('nope' as never, {}, ctx())).rejects.toThrow(/unknown built-in/i);
  });
});
