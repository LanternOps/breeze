import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  claim: vi.fn(),
  release: vi.fn(),
  dispatch: vi.fn(),
  reachability: vi.fn(),
}));

vi.mock('../../db', () => ({
  withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
}));
// #4142: diagnostics reach agents through the role-safe relay facade, not the
// socket registry. The outcome -> disposition mapping is pinned in
// agentCommandRelay.test.ts; it is restated here so a drift fails this suite.
vi.mock('../agentCommandRelay', () => ({
  dispatchCommandToAgent: mocks.dispatch,
  agentReachability: mocks.reachability,
  dispatchDisposition: (o: { status: string }) => (
    o.status === 'sent' ? 'delivered' : o.status === 'indeterminate' ? 'uncertain' : 'not_delivered'
  ),
}));
vi.mock('../sentry', () => ({ captureException: vi.fn() }));
vi.mock('../commandDispatch', () => ({
  claimPendingCommandForDelivery: mocks.claim,
  releaseClaimedCommandDelivery: mocks.release,
}));

import { deliverTopologyDiagnosticCommand } from './diagnosticDelivery';

const input = {
  agentId: 'agent-1',
  commandId: 'cmd-1',
  type: 'network_diagnostic',
  payload: {},
} as Parameters<typeof deliverTopologyDiagnosticCommand>[0];

describe('deliverTopologyDiagnosticCommand', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.reachability.mockResolvedValue('connected');
    mocks.dispatch.mockResolvedValue({ status: 'sent', via: 'local' });
  });

  it('pushes a claimed command', async () => {
    mocks.claim.mockResolvedValue({ status: 'claimed', id: 'cmd-1', executedAt: new Date(), agentId: 'agent-1' });
    expect(await deliverTopologyDiagnosticCommand(input)).toBe(true);
    expect(mocks.dispatch).toHaveBeenCalledTimes(1);
    expect(mocks.dispatch).toHaveBeenCalledWith('agent-1', { id: 'cmd-1', type: 'network_diagnostic', payload: {} });
  });

  it('pushes to the agent id read in the claim, not the one bound before it (#8318 §6.4)', async () => {
    // `input.agentId` (agent-1) was read when the command was bound; a
    // reattach / re-enroll committed before the claim.
    mocks.claim.mockResolvedValue({ status: 'claimed', id: 'cmd-1', executedAt: new Date(), agentId: 'agent-after-reattach' });
    expect(await deliverTopologyDiagnosticCommand(input)).toBe(true);
    expect(mocks.dispatch).toHaveBeenCalledTimes(1);
    expect(mocks.dispatch).toHaveBeenCalledWith('agent-after-reattach', { id: 'cmd-1', type: 'network_diagnostic', payload: {} });
  });

  it('never pushes a command the claim cancelled, and does not release it', async () => {
    mocks.claim.mockResolvedValue({ status: 'cancelled', id: 'cmd-1', reason: 'scope_changed' });
    expect(await deliverTopologyDiagnosticCommand(input)).toBe(false);
    expect(mocks.dispatch).not.toHaveBeenCalled();
    expect(mocks.release).not.toHaveBeenCalled();
  });

  it('never pushes a held command', async () => {
    mocks.claim.mockResolvedValue({ status: 'held', id: 'cmd-1', reason: 'claim_lock_conflict' });
    expect(await deliverTopologyDiagnosticCommand(input)).toBe(false);
    expect(mocks.dispatch).not.toHaveBeenCalled();
  });

  it('skips (false, no claim) only when the agent is provably absent', async () => {
    mocks.reachability.mockResolvedValue('absent');
    expect(await deliverTopologyDiagnosticCommand(input)).toBe(false);
    expect(mocks.claim).not.toHaveBeenCalled();
    expect(mocks.dispatch).not.toHaveBeenCalled();
  });

  it('skips without any lookup when the command has no agent id', async () => {
    expect(await deliverTopologyDiagnosticCommand({ ...input, agentId: null } as never)).toBe(false);
    expect(mocks.reachability).not.toHaveBeenCalled();
    expect(mocks.claim).not.toHaveBeenCalled();
  });

  it('proceeds to claim and dispatch when presence is unknown (the dispatch answers)', async () => {
    mocks.reachability.mockResolvedValue('unknown');
    mocks.claim.mockResolvedValue({ status: 'claimed', id: 'cmd-1', executedAt: new Date(), agentId: 'agent-1' });
    expect(await deliverTopologyDiagnosticCommand(input)).toBe(true);
    expect(mocks.claim).toHaveBeenCalledTimes(1);
    expect(mocks.dispatch).toHaveBeenCalledTimes(1);
  });

  it('an indeterminate outcome reports true and keeps the claim (no release)', async () => {
    mocks.claim.mockResolvedValue({ status: 'claimed', id: 'cmd-1', executedAt: new Date(), agentId: 'agent-1' });
    mocks.dispatch.mockResolvedValue({ status: 'indeterminate', reason: 'ack_timeout' });
    expect(await deliverTopologyDiagnosticCommand(input)).toBe(true);
    expect(mocks.release).not.toHaveBeenCalled();
  });

  it('a rejected facade promise is treated as uncertain: true, claim kept', async () => {
    mocks.claim.mockResolvedValue({ status: 'claimed', id: 'cmd-1', executedAt: new Date(), agentId: 'agent-1' });
    mocks.dispatch.mockRejectedValue(new Error('relay contract violation'));
    const err = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    expect(await deliverTopologyDiagnosticCommand(input)).toBe(true);
    expect(mocks.release).not.toHaveBeenCalled();
    err.mockRestore();
  });

  it.each(['offline', 'expired', 'owner_mismatch', 'infrastructure_error'])(
    'a %s outcome releases the claim and returns false',
    async (status) => {
      const executedAt = new Date();
      mocks.claim.mockResolvedValue({ status: 'claimed', id: 'cmd-1', executedAt, agentId: 'agent-1' });
      mocks.dispatch.mockResolvedValue({ status });
      expect(await deliverTopologyDiagnosticCommand(input)).toBe(false);
      expect(mocks.release).toHaveBeenCalledWith('cmd-1', executedAt);
    },
  );
});
