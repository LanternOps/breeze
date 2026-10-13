import { describe, it, expect, vi, type Mock } from 'vitest';

// Customer work approval (#8196 W05): mobile handling of the hard-mode gate.
vi.mock('../../services/api', () => ({ coreRequest: vi.fn() }));
vi.mock('@sentry/react-native', () => ({ captureException: vi.fn(), captureMessage: vi.fn() }));

import { startForTicket, type Stamp, type StartDeps } from './timerActions';
import { startOutcomeEffects } from './timerOutcomeEffects';
import { entryLock } from '../time/entryLock';
import { TimeEntryError, type TimeEntry } from '../../services/timeEntries';

const entry: TimeEntry = {
  id: 'e1',
  ticketId: 'k1',
  startedAt: '2026-10-01T09:00:00.000Z',
  endedAt: null,
  durationMinutes: null,
  isBillable: true,
  billingStatus: 'not_billed',
  isApproved: false,
  description: null,
};

const stamp = (): Stamp => ({ localId: 'l1', wallMs: Date.parse('2026-10-01T09:00:00Z'), monoMs: 1, monoEpochId: 'x' });

function deps(startTimerMock: Mock) {
  return {
    startTimer: startTimerMock as StartDeps['startTimer'] & Mock,
    writeLocalTimer: vi.fn().mockResolvedValue(undefined),
    clearLocalTimer: vi.fn().mockResolvedValue(undefined),
    isConnected: () => true,
    stamp,
  };
}

const APPROVAL_REQUIRED = new TimeEntryError('refused', 'APPROVAL_REQUIRED', 409);

describe('entryLock — awaiting_approval', () => {
  it('labels the row and keeps it editable (the server still accepts edits to a held entry)', () => {
    const lock = entryLock({ isApproved: false, billingStatus: 'awaiting_approval' });
    expect(lock.badge).toBe('Awaiting approval');
    expect(lock.note).toMatch(/customer approval/i);
    expect(lock.canEditDescription).toBe(true);
    expect(lock.canToggleBillable).toBe(true);
  });

  it('an approved held row is still fully locked (approval is the stronger lock)', () => {
    const lock = entryLock({ isApproved: true, billingStatus: 'awaiting_approval' });
    expect(lock.canEditDescription).toBe(false);
    expect(lock.badge).toBe('Approved');
  });
});

describe('start — 409 APPROVAL_REQUIRED', () => {
  it('returns an approval-required outcome with the prompt text and drops the local timer', async () => {
    const d = deps(vi.fn().mockRejectedValue(APPROVAL_REQUIRED));
    const outcome = await startForTicket('k1', d);
    expect(outcome).toEqual({
      ok: false,
      reason: 'approval-required',
      message: 'Approval required. Log as non-billable?',
    });
    expect(d.clearLocalTimer).toHaveBeenCalled();
  });

  it('retrying as non-billable sends isBillable:false and nothing otherwise', async () => {
    const d = deps(vi.fn().mockResolvedValue({ ...entry, isBillable: false }));
    await startForTicket('k1', d, { isBillable: false });
    expect(d.startTimer).toHaveBeenCalledWith(expect.objectContaining({ ticketId: 'k1', isBillable: false }));

    const plain = deps(vi.fn().mockResolvedValue(entry));
    await startForTicket('k1', plain);
    expect(plain.startTimer.mock.calls[0][0]).not.toHaveProperty('isBillable');
  });

  it('effects offer the non-billable retry and surface the prompt, without an account-level denial', () => {
    const effects = startOutcomeEffects({
      ok: false,
      reason: 'approval-required',
      message: 'Approval required. Log as non-billable?',
    });
    expect(effects.offerNonBillable).toBe(true);
    expect(effects.notice).toBe('Approval required. Log as non-billable?');
    expect(effects.accountDenial).toBeNull();
    expect(effects.startRunning).toBeNull();
  });

  it('other failures do not offer the retry', () => {
    const effects = startOutcomeEffects({ ok: false, reason: 'unknown', message: 'x' });
    expect(effects.offerNonBillable).toBe(false);
  });
});
