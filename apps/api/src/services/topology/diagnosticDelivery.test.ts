import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  claim: vi.fn(),
  release: vi.fn(),
  send: vi.fn(),
  connected: vi.fn(() => true),
}));

vi.mock('../../db', () => ({
  withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
}));
vi.mock('../../routes/agentWs', () => ({
  isAgentConnected: mocks.connected,
  sendCommandToAgent: mocks.send,
}));
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
    mocks.connected.mockReturnValue(true);
    mocks.send.mockReturnValue(true);
  });

  it('pushes a claimed command', async () => {
    mocks.claim.mockResolvedValue({ status: 'claimed', id: 'cmd-1', executedAt: new Date(), agentId: 'agent-1' });
    expect(await deliverTopologyDiagnosticCommand(input)).toBe(true);
    expect(mocks.send).toHaveBeenCalledTimes(1);
    expect(mocks.send).toHaveBeenCalledWith('agent-1', { id: 'cmd-1', type: 'network_diagnostic', payload: {} });
  });

  it('pushes to the agent id read in the claim, not the one bound before it (#8318 §6.4)', async () => {
    // `input.agentId` (agent-1) was read when the command was bound; a
    // reattach / re-enroll committed before the claim.
    mocks.claim.mockResolvedValue({ status: 'claimed', id: 'cmd-1', executedAt: new Date(), agentId: 'agent-after-reattach' });
    expect(await deliverTopologyDiagnosticCommand(input)).toBe(true);
    expect(mocks.send).toHaveBeenCalledTimes(1);
    expect(mocks.send).toHaveBeenCalledWith('agent-after-reattach', { id: 'cmd-1', type: 'network_diagnostic', payload: {} });
  });

  it('never pushes a command the claim cancelled, and does not release it', async () => {
    mocks.claim.mockResolvedValue({ status: 'cancelled', id: 'cmd-1', reason: 'scope_changed' });
    expect(await deliverTopologyDiagnosticCommand(input)).toBe(false);
    expect(mocks.send).not.toHaveBeenCalled();
    expect(mocks.release).not.toHaveBeenCalled();
  });

  it('never pushes a held command', async () => {
    mocks.claim.mockResolvedValue({ status: 'held', id: 'cmd-1', reason: 'claim_lock_conflict' });
    expect(await deliverTopologyDiagnosticCommand(input)).toBe(false);
    expect(mocks.send).not.toHaveBeenCalled();
  });
});
