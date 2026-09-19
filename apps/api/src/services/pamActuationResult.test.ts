import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ transaction: vi.fn(), execute: vi.fn() }));

vi.mock('../db', () => ({ db: { transaction: mocks.transaction } }));

import { recordPamActuationResult, type PamAgentResultV2 } from './pamActuationResult';

const baseResult: PamAgentResultV2 = {
  protocolVersion: 2,
  observationId: '10000000-0000-4000-8000-000000000001',
  actuationId: '10000000-0000-4000-8000-000000000002',
  generation: 3,
  state: 'verified_active',
  observedAt: '2026-08-25T12:00:00.000Z',
  evidence: { bootId: 'boot-1', privilegedTokenPresent: true },
};

const current = {
  id: baseResult.actuationId,
  org_id: '10000000-0000-4000-8000-000000000003',
  device_id: '10000000-0000-4000-8000-000000000004',
  elevation_request_id: '10000000-0000-4000-8000-000000000005',
  generation: 3,
  desired_state: 'active',
  observed_state: 'dispatched',
  current_command_id: '10000000-0000-4000-8000-000000000006',
};

describe('recordPamActuationResult', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.transaction.mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) => fn({ execute: mocks.execute }));
  });

  it('persists a current verified-active observation and advances the session', async () => {
    mocks.execute
      .mockResolvedValueOnce({ rows: [current] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ id: 'result-1' }] })
      .mockResolvedValueOnce({ rows: [current] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] });

    await expect(recordPamActuationResult({
      agentId: 'agent-1', deviceId: current.device_id, commandId: current.current_command_id,
      result: baseResult,
    })).resolves.toBe('applied');
    expect(mocks.execute).toHaveBeenCalledTimes(6);
  });

  it('classifies repeated observation identity as duplicate without mutation', async () => {
    mocks.execute
      .mockResolvedValueOnce({ rows: [current] })
      .mockResolvedValueOnce({ rows: [{ id: 'existing-result' }] });
    await expect(recordPamActuationResult({
      agentId: 'agent-1', deviceId: current.device_id, commandId: current.current_command_id,
      result: baseResult,
    })).resolves.toBe('duplicate');
    expect(mocks.execute).toHaveBeenCalledTimes(2);
  });

  it('rejects foreign command/device identity and classifies lower generations as stale', async () => {
    mocks.execute.mockResolvedValueOnce({ rows: [] });
    await expect(recordPamActuationResult({
      agentId: 'agent-foreign', deviceId: current.device_id, commandId: current.current_command_id,
      result: baseResult,
    })).resolves.toBe('rejected');

    mocks.execute.mockReset().mockResolvedValueOnce({ rows: [{ ...current, generation: 4 }] });
    await expect(recordPamActuationResult({
      agentId: 'agent-1', deviceId: current.device_id, commandId: current.current_command_id,
      result: baseResult,
    })).resolves.toBe('stale');
  });

  it('rejects verified-active after cleanup and cleaned without independent negative evidence', async () => {
    mocks.execute.mockResolvedValueOnce({ rows: [{ ...current, desired_state: 'cleanup' }] });
    await expect(recordPamActuationResult({
      agentId: 'agent-1', deviceId: current.device_id, commandId: current.current_command_id,
      result: baseResult,
    })).resolves.toBe('rejected');

    mocks.execute.mockReset().mockResolvedValueOnce({ rows: [{ ...current, desired_state: 'cleanup' }] });
    await expect(recordPamActuationResult({
      agentId: 'agent-1', deviceId: current.device_id, commandId: current.current_command_id,
      result: { ...baseResult, state: 'cleaned', evidence: { bootId: 'boot-1', jobMemberCount: 1 } },
    })).resolves.toBe('rejected');
  });

  // #4196: a cleanup proven after the agent crashed (Job Object already gone)
  // carries jobObjectAbsent alongside the same four independent negatives.
  it('applies a crash-recovered cleaned result that carries jobObjectAbsent with independent evidence', async () => {
    mocks.execute
      .mockResolvedValueOnce({ rows: [{ ...current, desired_state: 'cleanup' }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ id: 'result-2' }] })
      .mockResolvedValueOnce({ rows: [current] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] });

    await expect(recordPamActuationResult({
      agentId: 'agent-1', deviceId: current.device_id, commandId: current.current_command_id,
      result: {
        ...baseResult,
        state: 'cleaned',
        evidence: {
          bootId: 'boot-1', jobMemberCount: 0, accountEnabled: false, accountInAdministrators: false,
          privilegedTokenPresent: false, jobObjectAbsent: true,
        },
      },
    })).resolves.toBe('applied');
    expect(mocks.execute).toHaveBeenCalledTimes(6);
  });

  it('still rejects an unknown evidence key before opening a transaction', async () => {
    const evidence = {
      bootId: 'boot-1', jobMemberCount: 0, accountEnabled: false, accountInAdministrators: false,
      privilegedTokenPresent: false, jobObjectMissing: true,
    } as unknown as PamAgentResultV2['evidence'];

    await expect(recordPamActuationResult({
      agentId: 'agent-1', deviceId: current.device_id, commandId: current.current_command_id,
      result: { ...baseResult, state: 'cleaned', evidence },
    })).resolves.toBe('rejected');
    expect(mocks.transaction).not.toHaveBeenCalled();
  });
});
