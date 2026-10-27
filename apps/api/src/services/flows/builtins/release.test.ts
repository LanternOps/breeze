import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../db', () => ({
  db: {},
  runOutsideDbContext: (fn: () => unknown) => fn(),
  withSystemDbAccessContext: (fn: () => unknown) => fn(),
}));
vi.mock('./releaseStore', () => ({ loadReleasedBuiltinStep: vi.fn() }));
vi.mock('./runCounters', () => ({ countRunBuiltinCalls: vi.fn() }));
vi.mock('./index', () => ({ executeFlowBuiltin: vi.fn() }));

import type { ActionIntent } from '../../../db/schema';
import { executeFlowBuiltin } from './index';
import { loadReleasedBuiltinStep } from './releaseStore';
import { executeReleasedFlowBuiltin, FlowBuiltinMayHaveRunError } from './release';
import { countRunBuiltinCalls } from './runCounters';

const RUN = '99999999-9999-4999-8999-999999999999';
const ORG = '11111111-1111-4111-8111-111111111111';
const PARTNER = '22222222-2222-4222-8222-222222222222';
const POST = { method: 'POST', url: 'https://api.example.com/tickets', body: { t: 1 } };
const STEP = { id: 'call', tool: 'http_request', input: { method: 'POST', url: 'https://api.example.com/tickets', body: { t: '{{inputs.t}}' } }, approval: 'default', onFailure: 'stop', timeoutSec: 60 };

const intent = (over: Partial<ActionIntent> = {}) => ({
  id: 'intent-1', orgId: ORG, actionName: 'http_request', arguments: POST, requestingFlowRunId: RUN, source: 'flow', ...over,
}) as ActionIntent;
const auth = { principal: { kind: 'flow', runId: RUN, flowId: 'f1' }, partnerId: PARTNER, orgId: ORG } as never;

beforeEach(() => {
  vi.mocked(loadReleasedBuiltinStep).mockReset().mockResolvedValue({
    run: { id: RUN, orgId: ORG, flowId: 'f1' } as never,
    version: { id: 'v1', orgId: ORG, partnerId: null } as never,
    step: STEP as never,
    stepRowId: 'row-1',
    itemIndex: null,
  });
  vi.mocked(countRunBuiltinCalls).mockReset().mockResolvedValue({ notify: 0, http: 4 });
  vi.mocked(executeFlowBuiltin).mockReset();
});

describe('executeReleasedFlowBuiltin', () => {
  it('executes the APPROVED arguments with the publication step, the owner and the run counters', async () => {
    vi.mocked(executeFlowBuiltin).mockResolvedValue({ kind: 'completed', output: { status: 201, headers: {}, body: { id: 3 } }, truncated: false });
    const text = await executeReleasedFlowBuiltin(intent(), auth);
    expect(JSON.parse(text)).toEqual({ status: 201, headers: {}, body: { id: 3 } });
    expect(loadReleasedBuiltinStep).toHaveBeenCalledWith(RUN, 'intent-1');
    const [name, args, ctx] = vi.mocked(executeFlowBuiltin).mock.calls[0]!;
    expect(name).toBe('http_request');
    expect(args).toEqual(POST);
    expect(ctx).toMatchObject({ step: STEP, stepRowId: 'row-1', counters: { notify: 0, http: 4 }, leaseToken: null, owner: { orgId: ORG, partnerId: PARTNER }, auth });
  });

  it('a failed outcome is a returned error carrying the built-in code and policy flag', async () => {
    vi.mocked(executeFlowBuiltin).mockResolvedValue({ kind: 'failed', code: 'egress_blocked', message: 'Blocked.', policy: true });
    expect(JSON.parse(await executeReleasedFlowBuiltin(intent(), auth)))
      .toEqual({ error: 'Blocked.', flowStepError: { code: 'egress_blocked', policy: true } });
  });

  it('a failed outcome with output (a fleet step) keeps the output for the wake', async () => {
    const output = { dispatchedDeviceIds: ['d1'], succeededDeviceIds: [], failedDeviceIds: ['d1'], skippedOfflineDeviceIds: [], count: 1, warnings: [] };
    vi.mocked(executeFlowBuiltin).mockResolvedValue({ kind: 'failed', code: 'script_dispatch_failed', message: 'failed on 1 of 1', policy: false, output });
    expect(JSON.parse(await executeReleasedFlowBuiltin(intent(), auth)))
      .toEqual({ error: 'failed on 1 of 1', flowStepError: { code: 'script_dispatch_failed', policy: false }, output });
  });

  it('an unknown outcome throws FlowBuiltinMayHaveRunError (the worker records execution_error, executed)', async () => {
    vi.mocked(executeFlowBuiltin).mockResolvedValue({ kind: 'unknown_outcome', message: 'Timed out after sending.' });
    await expect(executeReleasedFlowBuiltin(intent(), auth)).rejects.toBeInstanceOf(FlowBuiltinMayHaveRunError);
  });

  it('a step that is gone, or a principal of another run, refuses before executing', async () => {
    vi.mocked(loadReleasedBuiltinStep).mockResolvedValueOnce(null);
    await expect(executeReleasedFlowBuiltin(intent(), auth)).rejects.toThrow(/no longer/);
    await expect(executeReleasedFlowBuiltin(intent(), { ...(auth as object), principal: { kind: 'flow', runId: 'other', flowId: 'f1' } } as never))
      .rejects.toThrow(/principal/);
    await expect(executeReleasedFlowBuiltin(intent({ actionName: 'run_script' }), auth)).rejects.toThrow(/built-in/);
    expect(executeFlowBuiltin).not.toHaveBeenCalled();
  });

  it('the step name on the run must be the intent\'s built-in', async () => {
    vi.mocked(loadReleasedBuiltinStep).mockResolvedValueOnce({
      run: { id: RUN, orgId: ORG, flowId: 'f1' } as never, version: { id: 'v1', orgId: ORG, partnerId: null } as never,
      step: { ...STEP, tool: 'notify' } as never, stepRowId: 'row-1', itemIndex: null,
    });
    await expect(executeReleasedFlowBuiltin(intent(), auth)).rejects.toThrow(/no longer/);
    expect(executeFlowBuiltin).not.toHaveBeenCalled();
  });
});
