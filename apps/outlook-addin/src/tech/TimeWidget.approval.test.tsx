import type { ComponentProps } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { TimeWidget } from './TimeWidget';
import * as api from './api';
import { TechApiError } from './api';
import type { AddinTicketSummary } from './api';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const ticket: AddinTicketSummary = {
  id: 'ticket-1',
  internalNumber: 'T-100',
  subject: 'Printer down',
  status: 'open',
  priority: null,
  updatedAt: '2026-08-15T10:00:00.000Z',
  submitterEmail: null,
  matchesSubmitter: false,
};

function baseProps(overrides: Partial<ComponentProps<typeof TimeWidget>> = {}) {
  return { linkedTicket: ticket, onBanner: vi.fn(), ...overrides };
}

const entry = (approvalHold: { requestId: string; trigger: 'budget' | 'after_hours' } | null) => ({
  id: 'entry-1', partnerId: 'p', orgId: 'o', ticketId: 'ticket-1', userId: 'u',
  startedAt: '2026-08-15T10:00:00.000Z', endedAt: '2026-08-15T11:00:00.000Z', durationMinutes: 60,
  description: 'x', isBillable: true, hourlyRate: null, currencyCode: null, billingStatus: 'awaiting_approval',
  isApproved: false, approvedBy: null, approvedAt: null, createdAt: '2026-08-15T10:00:00.000Z',
  ticketNumber: 'T-100', ticketSubject: 's', userName: null, approvalHold,
});

async function submitLog() {
  await waitFor(() => expect(screen.getByTestId('time-log-duration')).toBeTruthy());
  fireEvent.change(screen.getByTestId('time-log-duration'), { target: { value: '30' } });
  fireEvent.change(screen.getByTestId('time-log-description'), { target: { value: 'work' } });
  fireEvent.click(screen.getByTestId('time-log-submit'));
}

describe('TimeWidget customer-approval handling (#8196 W05)', () => {
  it('APPROVAL_REQUIRED on start offers a non-billable retry that sends isBillable:false', async () => {
    vi.spyOn(api, 'fetchRunningTimer').mockResolvedValue({ running: null });
    const start = vi
      .spyOn(api, 'startTimer')
      .mockRejectedValueOnce(
        new TechApiError(409, 'APPROVAL_REQUIRED', {
          error: 'APPROVAL_REQUIRED',
          details: { trigger: 'budget', pendingRequestId: null },
        }),
      )
      .mockResolvedValueOnce({ entry: entry(null), autoStopped: null });
    const onBanner = vi.fn();
    render(<TimeWidget {...baseProps({ onBanner })} />);
    await waitFor(() => expect(screen.getByTestId('time-start-button')).toBeTruthy());
    fireEvent.click(screen.getByTestId('time-start-button'));

    await waitFor(() => expect(screen.getByTestId('time-approval-required')).toBeTruthy());
    expect(screen.getByTestId('time-approval-required').textContent).toContain(
      'Approval required. Log as non-billable?',
    );
    expect(onBanner).not.toHaveBeenCalledWith(expect.stringContaining('APPROVAL_REQUIRED'));

    fireEvent.click(screen.getByTestId('time-approval-nonbillable'));
    await waitFor(() => expect(start).toHaveBeenCalledTimes(2));
    expect(start.mock.calls[1][0]).toMatchObject({ ticketId: 'ticket-1', isBillable: false });
    await waitFor(() => expect(screen.queryByTestId('time-approval-required')).toBeNull());
  });

  it('the first start attempt does not send isBillable', async () => {
    vi.spyOn(api, 'fetchRunningTimer').mockResolvedValue({ running: null });
    const start = vi
      .spyOn(api, 'startTimer')
      .mockRejectedValue(new TechApiError(409, 'APPROVAL_REQUIRED'));
    render(<TimeWidget {...baseProps()} />);
    await waitFor(() => expect(screen.getByTestId('time-start-button')).toBeTruthy());
    fireEvent.click(screen.getByTestId('time-start-button'));
    await waitFor(() => expect(start).toHaveBeenCalledTimes(1));
    expect(start.mock.calls[0][0]).not.toHaveProperty('isBillable');
  });

  it('shows a held notice when a logged entry carries approvalHold', async () => {
    vi.spyOn(api, 'fetchRunningTimer').mockResolvedValue({ running: null });
    vi.spyOn(api, 'logTime').mockResolvedValue({ entry: entry({ requestId: 'req-1', trigger: 'budget' }) });
    render(<TimeWidget {...baseProps()} />);
    await submitLog();
    await waitFor(() => expect(screen.getByTestId('time-held-notice')).toBeTruthy());
    expect(screen.getByTestId('time-held-notice').textContent).toContain('held pending customer approval');
  });

  it('shows no held notice when approvalHold is null', async () => {
    vi.spyOn(api, 'fetchRunningTimer').mockResolvedValue({ running: null });
    const log = vi.spyOn(api, 'logTime').mockResolvedValue({ entry: entry(null) });
    render(<TimeWidget {...baseProps()} />);
    await submitLog();
    await waitFor(() => expect(log).toHaveBeenCalled());
    expect(screen.queryByTestId('time-held-notice')).toBeNull();
  });

  it('shows the held notice after stop', async () => {
    vi.spyOn(api, 'fetchRunningTimer').mockResolvedValue({
      running: {
        id: 'entry-1', ticketId: 'ticket-1', ticketInternalNumber: 'T-100',
        startedAt: '2026-08-15T10:00:00.000Z', description: null,
      },
    });
    vi.spyOn(api, 'stopTimer').mockResolvedValue({ entry: entry({ requestId: 'req-1', trigger: 'after_hours' }) });
    render(<TimeWidget {...baseProps()} />);
    await waitFor(() => expect(screen.getByTestId('time-stop-button')).toBeTruthy());
    fireEvent.click(screen.getByTestId('time-stop-button'));
    await waitFor(() => expect(screen.getByTestId('time-held-notice')).toBeTruthy());
  });

  it.each([
    ['APPROVAL_REQUEST_PENDING', 'waiting on customer approval'],
    ['SOURCE_AWAITING_APPROVAL', 'awaiting customer approval'],
    ['REQUEST_NOT_PENDING', 'already decided'],
    ['REQUEST_CHANGED', 'was updated'],
    ['REQUEST_EXPIRED', 'expired'],
    ['APPROVAL_REQUIRED', 'Approval required'],
  ])('maps 409 %s to a human message on log', async (code, fragment) => {
    vi.spyOn(api, 'fetchRunningTimer').mockResolvedValue({ running: null });
    vi.spyOn(api, 'logTime').mockRejectedValue(new TechApiError(409, code));
    const onBanner = vi.fn();
    render(<TimeWidget {...baseProps({ onBanner })} />);
    await submitLog();
    await waitFor(() => expect(onBanner).toHaveBeenCalledWith(expect.stringContaining(fragment)));
  });

  it('ENTRY_CHANGED is still surfaced with its code (not swallowed)', async () => {
    vi.spyOn(api, 'fetchRunningTimer').mockResolvedValue({ running: null });
    vi.spyOn(api, 'logTime').mockRejectedValue(new TechApiError(409, 'ENTRY_CHANGED'));
    const onBanner = vi.fn();
    render(<TimeWidget {...baseProps({ onBanner })} />);
    await submitLog();
    await waitFor(() => expect(onBanner).toHaveBeenCalledWith(expect.stringContaining('ENTRY_CHANGED')));
  });
});
