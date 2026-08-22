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
  vi.useRealTimers();
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
  return {
    linkedTicket: ticket,
    onBanner: vi.fn(),
    ...overrides,
  };
}

describe('TimeWidget', () => {
  it('renders the running timer from the initial fetch', async () => {
    vi.spyOn(api, 'fetchRunningTimer').mockResolvedValue({
      running: {
        id: 'entry-1',
        ticketId: 'ticket-1',
        ticketInternalNumber: 'T-100',
        startedAt: '2026-08-15T10:00:00.000Z',
        description: null,
      },
    });
    render(<TimeWidget {...baseProps()} />);

    await waitFor(() => expect(screen.getByTestId('time-running')).toBeTruthy());
    expect(screen.getByTestId('time-running').textContent).toContain('T-100');
  });

  it('shows idle state when nothing is running', async () => {
    vi.spyOn(api, 'fetchRunningTimer').mockResolvedValue({ running: null });
    render(<TimeWidget {...baseProps()} />);
    await waitFor(() => expect(screen.getByTestId('time-idle')).toBeTruthy());
  });

  it('polls fetchRunningTimer every 30s and cleans up on unmount', async () => {
    vi.useFakeTimers();
    const spy = vi.spyOn(api, 'fetchRunningTimer').mockResolvedValue({ running: null });
    const { unmount } = render(<TimeWidget {...baseProps()} />);

    await vi.waitFor(() => expect(spy).toHaveBeenCalledTimes(1));

    await vi.advanceTimersByTimeAsync(30_000);
    expect(spy).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(30_000);
    expect(spy).toHaveBeenCalledTimes(3);

    unmount();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(spy).toHaveBeenCalledTimes(3);
  });

  it('starts directly when no timer is running', async () => {
    vi.spyOn(api, 'fetchRunningTimer').mockResolvedValue({ running: null });
    const startSpy = vi.spyOn(api, 'startTimer').mockResolvedValue({
      entry: {
        id: 'entry-1',
        partnerId: 'p1',
        orgId: 'org-1',
        currencyCode: 'USD',
        ticketId: 'ticket-1',
        userId: 'u1',
        startedAt: '2026-08-15T10:05:00.000Z',
        endedAt: null,
        durationMinutes: null,
        description: null,
        isBillable: true,
        hourlyRate: null,
        billingStatus: 'unbilled',
        isApproved: false,
        approvedBy: null,
        approvedAt: null,
        createdAt: '2026-08-15T10:05:00.000Z',
        ticketNumber: 'T-100',
        ticketSubject: 'Printer down',
        userName: 'Tech',
      },
      autoStopped: null,
    });
    render(<TimeWidget {...baseProps()} />);
    await waitFor(() => expect(screen.getByTestId('time-idle')).toBeTruthy());

    fireEvent.click(screen.getByTestId('time-start-button'));

    await waitFor(() => expect(startSpy).toHaveBeenCalledWith({ ticketId: 'ticket-1' }));
    expect(screen.queryByTestId('time-start-warning')).toBeNull();
    await waitFor(() => expect(screen.getByTestId('time-running')).toBeTruthy());
  });

  it('warns before starting when a timer is running on another ticket, and only starts on confirm', async () => {
    vi.spyOn(api, 'fetchRunningTimer').mockResolvedValue({
      running: {
        id: 'entry-9',
        ticketId: 'ticket-2',
        ticketInternalNumber: 'T-200',
        startedAt: '2026-08-15T09:00:00.000Z',
        description: null,
      },
    });
    const startSpy = vi.spyOn(api, 'startTimer').mockResolvedValue({
      entry: {
        id: 'entry-1',
        partnerId: 'p1',
        orgId: 'org-1',
        currencyCode: 'USD',
        ticketId: 'ticket-1',
        userId: 'u1',
        startedAt: '2026-08-15T10:05:00.000Z',
        endedAt: null,
        durationMinutes: null,
        description: null,
        isBillable: true,
        hourlyRate: null,
        billingStatus: 'unbilled',
        isApproved: false,
        approvedBy: null,
        approvedAt: null,
        createdAt: '2026-08-15T10:05:00.000Z',
        ticketNumber: 'T-100',
        ticketSubject: 'Printer down',
        userName: 'Tech',
      },
      autoStopped: {
        id: 'entry-9',
        ticketId: 'ticket-2',
        ticketInternalNumber: 'T-200',
        startedAt: '2026-08-15T09:00:00.000Z',
        description: null,
      },
    });
    render(<TimeWidget {...baseProps({ linkedTicket: ticket })} />);
    await waitFor(() => expect(screen.getByTestId('time-running')).toBeTruthy());

    fireEvent.click(screen.getByTestId('time-start-button'));

    expect(startSpy).not.toHaveBeenCalled();
    const warning = await screen.findByTestId('time-start-warning');
    expect(warning.textContent).toContain('T-200');

    fireEvent.click(screen.getByTestId('time-start-cancel'));
    expect(screen.queryByTestId('time-start-warning')).toBeNull();
    expect(startSpy).not.toHaveBeenCalled();

    fireEvent.click(screen.getByTestId('time-start-button'));
    fireEvent.click(await screen.findByTestId('time-start-confirm'));

    await waitFor(() => expect(startSpy).toHaveBeenCalledWith({ ticketId: 'ticket-1' }));
  });

  it('stop calls the endpoint and clears the running timer', async () => {
    vi.spyOn(api, 'fetchRunningTimer').mockResolvedValue({
      running: {
        id: 'entry-1',
        ticketId: 'ticket-1',
        ticketInternalNumber: 'T-100',
        startedAt: '2026-08-15T10:00:00.000Z',
        description: null,
      },
    });
    const stopSpy = vi.spyOn(api, 'stopTimer').mockResolvedValue({
      entry: {
        id: 'entry-1',
        partnerId: 'p1',
        orgId: 'org-1',
        currencyCode: 'USD',
        ticketId: 'ticket-1',
        userId: 'u1',
        startedAt: '2026-08-15T10:00:00.000Z',
        endedAt: '2026-08-15T10:30:00.000Z',
        durationMinutes: 30,
        description: null,
        isBillable: true,
        hourlyRate: null,
        billingStatus: 'unbilled',
        isApproved: false,
        approvedBy: null,
        approvedAt: null,
        createdAt: '2026-08-15T10:00:00.000Z',
        ticketNumber: 'T-100',
        ticketSubject: 'Printer down',
        userName: 'Tech',
      },
    });
    render(<TimeWidget {...baseProps()} />);
    await waitFor(() => expect(screen.getByTestId('time-stop-button')).toBeTruthy());

    fireEvent.click(screen.getByTestId('time-stop-button'));

    await waitFor(() => expect(stopSpy).toHaveBeenCalledWith({}));
    await waitFor(() => expect(screen.getByTestId('time-idle')).toBeTruthy());
  });

  it('manual log posts the exact schema shape and omits isBillable when untouched', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-15T12:00:00.000Z'));
    vi.spyOn(api, 'fetchRunningTimer').mockResolvedValue({ running: null });
    const logSpy = vi.spyOn(api, 'logTime').mockResolvedValue({
      entry: {
        id: 'entry-1',
        partnerId: 'p1',
        orgId: 'org-1',
        currencyCode: 'USD',
        ticketId: 'ticket-1',
        userId: 'u1',
        startedAt: '2026-08-15T11:30:00.000Z',
        endedAt: '2026-08-15T12:00:00.000Z',
        durationMinutes: 30,
        description: 'Fixed the jam',
        isBillable: true,
        hourlyRate: null,
        billingStatus: 'unbilled',
        isApproved: false,
        approvedBy: null,
        approvedAt: null,
        createdAt: '2026-08-15T12:00:00.000Z',
        ticketNumber: 'T-100',
        ticketSubject: 'Printer down',
        userName: 'Tech',
      },
    });
    render(<TimeWidget {...baseProps()} />);
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(0);
    expect(screen.getByTestId('time-idle')).toBeTruthy();

    fireEvent.change(screen.getByTestId('time-log-duration'), { target: { value: '30' } });
    fireEvent.change(screen.getByTestId('time-log-description'), { target: { value: 'Fixed the jam' } });
    fireEvent.click(screen.getByTestId('time-log-submit'));
    await vi.advanceTimersByTimeAsync(0);

    expect(logSpy).toHaveBeenCalledWith({
      ticketId: 'ticket-1',
      startedAt: '2026-08-15T11:30:00.000Z',
      endedAt: '2026-08-15T12:00:00.000Z',
      description: 'Fixed the jam',
    });
  });

  it('manual log includes isBillable when the checkbox is touched', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-15T12:00:00.000Z'));
    vi.spyOn(api, 'fetchRunningTimer').mockResolvedValue({ running: null });
    const logSpy = vi.spyOn(api, 'logTime').mockResolvedValue({
      entry: { id: 'entry-1' } as api.TimeEntry,
    });
    render(<TimeWidget {...baseProps()} />);
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(0);
    expect(screen.getByTestId('time-idle')).toBeTruthy();

    fireEvent.change(screen.getByTestId('time-log-duration'), { target: { value: '15' } });
    fireEvent.change(screen.getByTestId('time-log-description'), { target: { value: 'Quick check' } });
    fireEvent.click(screen.getByTestId('time-log-billable'));
    fireEvent.click(screen.getByTestId('time-log-submit'));
    await vi.advanceTimersByTimeAsync(0);

    expect(logSpy).toHaveBeenCalledWith(
      expect.objectContaining({ isBillable: true }),
    );
  });

  it('prefills the manual log duration from the suggested AI duration', async () => {
    vi.spyOn(api, 'fetchRunningTimer').mockResolvedValue({ running: null });
    render(<TimeWidget {...baseProps({ suggestedDurationMinutes: 25 })} />);
    await waitFor(() => expect(screen.getByTestId('time-idle')).toBeTruthy());

    expect((screen.getByTestId('time-log-duration') as HTMLInputElement).value).toBe('25');
  });

  it('does not clobber a duration the technician already edited when a suggestion arrives later', async () => {
    vi.spyOn(api, 'fetchRunningTimer').mockResolvedValue({ running: null });
    const { rerender } = render(<TimeWidget {...baseProps()} />);
    await waitFor(() => expect(screen.getByTestId('time-idle')).toBeTruthy());

    fireEvent.change(screen.getByTestId('time-log-duration'), { target: { value: '5' } });
    rerender(<TimeWidget {...baseProps({ suggestedDurationMinutes: 25 })} />);

    expect((screen.getByTestId('time-log-duration') as HTMLInputElement).value).toBe('5');
  });

  it('surfaces a running-timer fetch failure via onBanner', async () => {
    vi.spyOn(api, 'fetchRunningTimer').mockRejectedValue(new TechApiError(500, 'server_error'));
    const onBanner = vi.fn();
    render(<TimeWidget {...baseProps({ onBanner })} />);
    await waitFor(() =>
      expect(onBanner).toHaveBeenCalledWith(expect.stringContaining('server_error')),
    );
  });

  it('a 403 on load hides the widget without a banner and stops the poll', async () => {
    vi.useFakeTimers();
    const spy = vi
      .spyOn(api, 'fetchRunningTimer')
      .mockRejectedValue(new TechApiError(403, 'forbidden'));
    const onBanner = vi.fn();
    render(<TimeWidget {...baseProps({ onBanner })} />);

    await vi.waitFor(() =>
      expect(document.querySelector('[data-testid="time-widget"]')).toBeNull(),
    );
    expect(spy).toHaveBeenCalledTimes(1);
    expect(onBanner).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(90_000);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('surfaces a start failure via onBanner', async () => {
    vi.spyOn(api, 'fetchRunningTimer').mockResolvedValue({ running: null });
    vi.spyOn(api, 'startTimer').mockRejectedValue(new TechApiError(409, 'ticket_closed'));
    const onBanner = vi.fn();
    render(<TimeWidget {...baseProps({ onBanner })} />);
    await waitFor(() => expect(screen.getByTestId('time-start-button')).toBeTruthy());

    fireEvent.click(screen.getByTestId('time-start-button'));

    await waitFor(() =>
      expect(onBanner).toHaveBeenCalledWith(expect.stringContaining('ticket_closed')),
    );
  });

  it('surfaces a stop failure via onBanner', async () => {
    vi.spyOn(api, 'fetchRunningTimer').mockResolvedValue({
      running: {
        id: 'entry-1',
        ticketId: 'ticket-1',
        ticketInternalNumber: 'T-100',
        startedAt: '2026-08-15T10:00:00.000Z',
        description: null,
      },
    });
    vi.spyOn(api, 'stopTimer').mockRejectedValue(new TechApiError(500, 'server_error'));
    const onBanner = vi.fn();
    render(<TimeWidget {...baseProps({ onBanner })} />);
    await waitFor(() => expect(screen.getByTestId('time-stop-button')).toBeTruthy());

    fireEvent.click(screen.getByTestId('time-stop-button'));

    await waitFor(() =>
      expect(onBanner).toHaveBeenCalledWith(expect.stringContaining('server_error')),
    );
  });

  it('surfaces a manual log failure via onBanner', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-15T12:00:00.000Z'));
    vi.spyOn(api, 'fetchRunningTimer').mockResolvedValue({ running: null });
    vi.spyOn(api, 'logTime').mockRejectedValue(new TechApiError(400, 'bad_request'));
    const onBanner = vi.fn();
    render(<TimeWidget {...baseProps({ onBanner })} />);
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(0);
    expect(screen.getByTestId('time-idle')).toBeTruthy();

    fireEvent.change(screen.getByTestId('time-log-duration'), { target: { value: '10' } });
    fireEvent.change(screen.getByTestId('time-log-description'), { target: { value: 'x' } });
    fireEvent.click(screen.getByTestId('time-log-submit'));
    await vi.advanceTimersByTimeAsync(0);

    expect(onBanner).toHaveBeenCalledWith(expect.stringContaining('bad_request'));
  });

  it('disables the start button and log form when there is no linked ticket', async () => {
    vi.spyOn(api, 'fetchRunningTimer').mockResolvedValue({ running: null });
    render(<TimeWidget {...baseProps({ linkedTicket: null })} />);
    await waitFor(() => expect(screen.getByTestId('time-idle')).toBeTruthy());

    expect((screen.getByTestId('time-start-button') as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByTestId('time-log-submit') as HTMLButtonElement).disabled).toBe(true);
  });
});
