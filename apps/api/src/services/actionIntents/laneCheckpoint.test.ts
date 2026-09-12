import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockCheckpoint = vi.fn();
vi.mock('../deviceRecovery/restoreCheckpoint', () => ({
  ensureRestoreCheckpoint: (...a: unknown[]) => mockCheckpoint(...a),
}));

import { ensureLaneCheckpointBeforeRelease } from './laneCheckpoint';

const lane = (checkpointRequired: boolean, over: Record<string, unknown> = {}) => ({
  decidedVia: 'script_reviewer',
  scriptReviewerEvidence: { proposalId: 'prop-1', reviewId: 'rev-1', checkpointRequired },
  arguments: { proposalId: 'prop-1', deviceIds: ['dev-1'] },
  ...over,
}) as never;

beforeEach(() => {
  mockCheckpoint.mockReset();
  mockCheckpoint.mockResolvedValue({ ok: true, checkpointRef: '42' });
});

describe('ensureLaneCheckpointBeforeRelease', () => {
  it('never runs for a non-lane intent', async () => {
    await expect(ensureLaneCheckpointBeforeRelease(lane(true, { decidedVia: null }))).resolves.toEqual({ ok: true, checkpointRef: null });
    await expect(ensureLaneCheckpointBeforeRelease(lane(true, { decidedVia: 'ticket_autonomy' }))).resolves.toEqual({ ok: true, checkpointRef: null });
    expect(mockCheckpoint).not.toHaveBeenCalled();
  });

  it('takes no checkpoint for a lane intent that never needed one', async () => {
    await expect(ensureLaneCheckpointBeforeRelease(lane(false))).resolves.toEqual({ ok: true, checkpointRef: null });
    expect(mockCheckpoint).not.toHaveBeenCalled();
  });

  it('takes one against the single target device when the evidence says it was required', async () => {
    await expect(ensureLaneCheckpointBeforeRelease(lane(true))).resolves.toEqual({ ok: true, checkpointRef: '42' });
    expect(mockCheckpoint).toHaveBeenCalledWith('dev-1');
  });

  it('refuses when the checkpoint cannot be taken, carrying the specific reason', async () => {
    mockCheckpoint.mockResolvedValue({ ok: false, reason: 'checkpoint_failed' });
    await expect(ensureLaneCheckpointBeforeRelease(lane(true))).resolves.toEqual({ ok: false, reason: 'checkpoint_failed' });
  });

  it('refuses a malformed device list without dispatching', async () => {
    await expect(ensureLaneCheckpointBeforeRelease(lane(true, { arguments: { proposalId: 'prop-1' } }))).resolves.toEqual({ ok: false, reason: 'device_unavailable' });
    expect(mockCheckpoint).not.toHaveBeenCalled();
  });

  it('a missing evidence blob on a lane row refuses (fail-closed), never "no checkpoint needed"', async () => {
    await expect(ensureLaneCheckpointBeforeRelease(lane(true, { scriptReviewerEvidence: null }))).resolves.toEqual({ ok: false, reason: 'evidence_missing' });
    expect(mockCheckpoint).not.toHaveBeenCalled();
  });
});
