import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

const fetchWithAuth = vi.fn();
vi.mock('../stores/auth', () => ({ fetchWithAuth: (...a: unknown[]) => fetchWithAuth(...a) }));
vi.mock('../components/shared/Toast', () => ({ showToast: vi.fn() }));

import { deleteTimeEntryAction, TIMER_CHANGED_EVENT, BILLING_CHANGED_EVENT } from './timerActions';

// #8133: the shared delete used by the ticket rail and the timesheet.
describe('deleteTimeEntryAction', () => {
  const timer = vi.fn();
  const billing = vi.fn();
  beforeEach(() => {
    fetchWithAuth.mockReset();
    timer.mockReset();
    billing.mockReset();
    window.addEventListener(TIMER_CHANGED_EVENT, timer);
    window.addEventListener(BILLING_CHANGED_EVENT, billing);
  });
  afterEach(() => {
    window.removeEventListener(TIMER_CHANGED_EVENT, timer);
    window.removeEventListener(BILLING_CHANGED_EVENT, billing);
  });

  it('sends DELETE and fires only the billing event for a finished entry', async () => {
    fetchWithAuth.mockResolvedValue({ ok: true, status: 200, json: async () => ({ data: { deleted: true } }) } as Response);
    await deleteTimeEntryAction({ id: 'te-1', endedAt: '2026-06-12T09:45:00Z' }, { errorFallback: 'fail', successMessage: 'ok' });
    expect(fetchWithAuth).toHaveBeenCalledWith('/time-entries/te-1', { method: 'DELETE' });
    expect(billing).toHaveBeenCalledTimes(1);
    expect(timer).not.toHaveBeenCalled();
  });

  it('fires only the timer event when the running timer is deleted', async () => {
    fetchWithAuth.mockResolvedValue({ ok: true, status: 200, json: async () => ({ data: { deleted: true } }) } as Response);
    await deleteTimeEntryAction({ id: 'run-1', endedAt: null }, { errorFallback: 'fail', successMessage: 'ok' });
    expect(timer).toHaveBeenCalledTimes(1);
    expect(billing).not.toHaveBeenCalled();
  });

  it('throws and broadcasts nothing when the server refuses', async () => {
    fetchWithAuth.mockResolvedValue({ ok: false, status: 409, json: async () => ({ error: 'invoiced', code: 'ENTRY_BILLED' }) } as Response);
    await expect(deleteTimeEntryAction({ id: 'te-1', endedAt: '2026-06-12T09:45:00Z' }, { errorFallback: 'fail', successMessage: 'ok' })).rejects.toThrow();
    expect(timer).not.toHaveBeenCalled();
    expect(billing).not.toHaveBeenCalled();
  });

  it('applies the caller friendly message before the module default', async () => {
    const { showToast } = await import('../components/shared/Toast');
    fetchWithAuth.mockResolvedValue({ ok: false, status: 409, json: async () => ({ error: 'invoiced', code: 'ENTRY_BILLED' }) } as Response);
    await expect(deleteTimeEntryAction({ id: 'te-1', endedAt: '2026-06-12T09:45:00Z' }, { errorFallback: 'fail', successMessage: 'ok' }, (code) => (code === 'ENTRY_BILLED' ? 'void it first' : undefined))).rejects.toThrow();
    expect(showToast).toHaveBeenCalledWith(expect.objectContaining({ message: 'void it first' }));
  });
});
