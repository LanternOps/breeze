import { describe, it, expect, vi } from 'vitest';

// #8022: both queueCommandForExecution entry points map the dispatch seam's
// result through one helper. Driven here through a mocked seam so every
// refusal code (not just the ones a DB-mock scenario can reach) is pinned.
vi.mock('./dispatchDeviceCommand', () => ({
  dispatchDeviceCommand: vi.fn(),
  dispatchDeviceCommandWithSystemPrecheck: vi.fn(),
}));
vi.mock('../routes/agentWs', () => ({
  sendCommandToAgent: vi.fn(),
  isAgentConnected: vi.fn(),
}));

import {
  queueCommandForExecution,
  queueCommandForExecutionWithSystemPrecheck,
} from './commandQueue';
import { dispatchDeviceCommand, dispatchDeviceCommandWithSystemPrecheck } from './dispatchDeviceCommand';
import { cancelledCommandError } from './commandCancelMessage';

const REFUSAL_CODES = [
  'device_not_found',
  'device_offline',
  'device_decommissioned',
  'device_pending_assignment',
  'trust_denied',
  'backup_helper_update_required',
] as const;

const entryPoints = [
  {
    name: 'queueCommandForExecution',
    seam: dispatchDeviceCommand,
    call: () => queueCommandForExecution('dev-1', 'reboot', {}, { expectedOrgId: 'org-1' }),
  },
  {
    name: 'queueCommandForExecutionWithSystemPrecheck',
    seam: dispatchDeviceCommandWithSystemPrecheck,
    call: () => queueCommandForExecutionWithSystemPrecheck('dev-1', 'reboot', {}, { expectedOrgId: 'org-1' }),
  },
] as const;

describe.each(entryPoints)('$name refusal class (#8022)', ({ seam, call }) => {
  it.each(REFUSAL_CODES)('carries %s as refusal beside the error text', async (code) => {
    vi.mocked(seam).mockResolvedValueOnce({ ok: false, code, error: `refused: ${code}` } as never);
    await expect(call()).resolves.toEqual({ error: `refused: ${code}`, refusal: code });
  });

  it('keeps the trust detail on a trust_denied refusal that has it', async () => {
    const trust = { capability: 'device_execute' as const, reason: 'probation_default_deny' };
    vi.mocked(seam).mockResolvedValueOnce({ ok: false, code: 'trust_denied', error: 'TRUST_PROBATION', trust } as never);
    await expect(call()).resolves.toEqual({ error: 'TRUST_PROBATION', refusal: 'trust_denied', trust });
  });

  it('classes a claim-time cancel as cancelled', async () => {
    const command = { id: 'cmd-1', status: 'cancelled' };
    vi.mocked(seam).mockResolvedValueOnce({
      ok: true, command, delivery: 'cancelled', cancelReason: 'requester_inactive', deliverBy: null,
    } as never);
    await expect(call()).resolves.toEqual({
      command, error: cancelledCommandError('requester_inactive'), refusal: 'cancelled',
    });
  });

  it('sets no refusal on a successful dispatch', async () => {
    const command = { id: 'cmd-1', status: 'sent' };
    vi.mocked(seam).mockResolvedValueOnce({ ok: true, command, delivery: 'delivered', deliverBy: null } as never);
    const result = await call();
    expect(result.refusal).toBeUndefined();
    expect(result.error).toBeUndefined();
  });
});
