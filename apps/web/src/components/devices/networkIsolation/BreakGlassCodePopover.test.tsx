import { act, fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
const fetchWithAuth = vi.fn();
vi.mock('../../../stores/auth', () => ({ fetchWithAuth: (...args: unknown[]) => fetchWithAuth(...args) }));
vi.mock('../../shared/Toast', () => ({ showToast: vi.fn() }));
import BreakGlassCodePopover from './BreakGlassCodePopover';
beforeEach(() => fetchWithAuth.mockReset());
describe('BreakGlassCodePopover', () => {
  it('never prefetches; explicit click calls the audited GET and shows both codes', async () => {
    fetchWithAuth.mockResolvedValue({ ok: true, json: async () => ({ current: 'ABCD2345', next: 'EFGH2345', currentValidUntil: '2099-11-02T12:00:00Z' }) });
    render(<BreakGlassCodePopover deviceId="device-1" isolationId="episode-1" />);
    expect(fetchWithAuth).not.toHaveBeenCalled();
    expect(screen.queryByText('ABCD2345')).toBeNull();
    fireEvent.click(screen.getByTestId('isolation-show-code'));
    expect(await screen.findByText('ABCD2345')).toBeInTheDocument();
    expect(screen.getByText('EFGH2345')).toBeInTheDocument();
    expect(fetchWithAuth).toHaveBeenCalledWith('/devices/device-1/network-isolation/episode-1/break-glass-code');
    fireEvent.click(screen.getByTestId('isolation-show-code'));
    expect(screen.queryByText('ABCD2345')).toBeNull();
  });
  it('clears codes on generation change and requires another audited click', async () => {
    fetchWithAuth.mockResolvedValue({ ok: true, json: async () => ({ current: 'ABCD2345', next: 'EFGH2345', currentValidUntil: '2099-11-02T12:00:00Z' }) });
    const { rerender } = render(<BreakGlassCodePopover deviceId="device-1" isolationId="episode-1" generation={1} />);
    fireEvent.click(screen.getByTestId('isolation-show-code'));
    expect(await screen.findByText('ABCD2345')).toBeInTheDocument();
    rerender(<BreakGlassCodePopover deviceId="device-1" isolationId="episode-1" generation={2} />);
    expect(screen.queryByText('ABCD2345')).toBeNull();
    expect(fetchWithAuth).toHaveBeenCalledTimes(1);
  });
  it('clears codes at the hour boundary without prefetching', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-02T11:59:59Z'));
    try {
      fetchWithAuth.mockResolvedValue({ ok: true, json: async () => ({ current: 'ABCD2345', next: 'EFGH2345', currentValidUntil: '2026-11-02T12:00:00Z' }) });
      render(<BreakGlassCodePopover deviceId="device-1" isolationId="episode-1" />);
      await act(async () => { fireEvent.click(screen.getByTestId('isolation-show-code')); });
      expect(screen.getByText('ABCD2345')).toBeInTheDocument();
      await act(async () => { vi.advanceTimersByTime(1000); });
      expect(screen.queryByText('ABCD2345')).toBeNull();
      expect(fetchWithAuth).toHaveBeenCalledTimes(1);
    } finally { vi.useRealTimers(); }
  });
  it('shows a retryable failure without exposing a code', async () => {
    fetchWithAuth.mockResolvedValue({ ok: false, status: 503 });
    render(<BreakGlassCodePopover deviceId="device-1" isolationId="episode-1" />);
    fireEvent.click(screen.getByTestId('isolation-show-code'));
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not load');
    expect(screen.getByTestId('isolation-show-code')).toBeEnabled();
  });
  describe('release token tabs', () => {
    it('shows no tabs without releaseTokenAvailable', () => {
      render(<BreakGlassCodePopover deviceId="device-1" isolationId="episode-1" />);
      expect(screen.queryByRole('tablist')).toBeNull();
      expect(screen.getByTestId('isolation-show-code')).toBeInTheDocument();
    });
    it('defaults to the Code tab; switching to Token fetches nothing', () => {
      render(<BreakGlassCodePopover deviceId="device-1" isolationId="episode-1" releaseTokenAvailable />);
      expect(screen.getByRole('tablist')).toBeInTheDocument();
      expect(screen.getByTestId('isolation-tab-code')).toHaveAttribute('aria-selected', 'true');
      expect(screen.getByTestId('isolation-show-code')).toBeInTheDocument();
      fireEvent.click(screen.getByTestId('isolation-tab-token'));
      expect(screen.getByTestId('isolation-tab-token')).toHaveAttribute('aria-selected', 'true');
      expect(screen.getByTestId('isolation-issue-token')).toBeInTheDocument();
      expect(screen.queryByTestId('isolation-show-code')).toBeNull();
      expect(fetchWithAuth).not.toHaveBeenCalled();
    });
    it('codesDisabled hides the code button, shows the note and the token UI', () => {
      render(<BreakGlassCodePopover deviceId="device-1" isolationId="episode-1" releaseTokenAvailable codesDisabled />);
      expect(screen.queryByTestId('isolation-show-code')).toBeNull();
      expect(screen.queryByRole('tablist')).toBeNull();
      expect(screen.getByTestId('isolation-codes-disabled-note')).toBeInTheDocument();
      expect(screen.getByTestId('isolation-issue-token')).toBeInTheDocument();
      expect(fetchWithAuth).not.toHaveBeenCalled();
    });
    it('codesDisabled alone also implies the token UI', () => {
      render(<BreakGlassCodePopover deviceId="device-1" isolationId="episode-1" codesDisabled />);
      expect(screen.queryByTestId('isolation-show-code')).toBeNull();
      expect(screen.getByTestId('isolation-issue-token')).toBeInTheDocument();
    });
  });
});
