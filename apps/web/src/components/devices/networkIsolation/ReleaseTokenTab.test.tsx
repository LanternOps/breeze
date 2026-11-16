import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
const fetchWithAuth = vi.fn();
const showToast = vi.fn();
vi.mock('../../../stores/auth', () => ({ fetchWithAuth: (...args: unknown[]) => fetchWithAuth(...args) }));
vi.mock('../../shared/Toast', () => ({ showToast: (...args: unknown[]) => showToast(...args) }));
import ReleaseTokenTab from './ReleaseTokenTab';

const TOKEN = 'tok.' + 'A'.repeat(220);
const QR = 'data:image/png;base64,iVBORw0KGgo=';
function ok(body: Record<string, unknown> = {}) {
  return { ok: true, status: 200, json: async () => ({ generation: 3, token: TOKEN, notBefore: '2026-11-02T10:00:00Z', expiresAt: '2099-11-02T12:00:00Z', qrCodeDataUrl: QR, ...body }) };
}
const URL = '/devices/device-1/network-isolation/episode-1/release-token';
beforeEach(() => { fetchWithAuth.mockReset(); showToast.mockReset(); });

describe('ReleaseTokenTab', () => {
  it('never prefetches; click POSTs and shows token, QR and validity', async () => {
    fetchWithAuth.mockResolvedValue(ok());
    render(<ReleaseTokenTab deviceId="device-1" isolationId="episode-1" />);
    expect(fetchWithAuth).not.toHaveBeenCalled();
    expect(screen.queryByTestId('isolation-release-token')).toBeNull();
    fireEvent.click(screen.getByTestId('isolation-issue-token'));
    const box = await screen.findByTestId('isolation-release-token');
    expect(box).toHaveValue(TOKEN);
    expect(box).toHaveAttribute('readonly');
    expect(fetchWithAuth).toHaveBeenCalledTimes(1);
    expect(fetchWithAuth).toHaveBeenCalledWith(URL, { method: 'POST' });
    expect(screen.getByTestId('isolation-token-qr')).toHaveAttribute('src', QR);
    expect(screen.getByText(/valid until/i)).toBeInTheDocument();
    expect(screen.getByText('breeze-agent containment release --token <token>')).toBeInTheDocument();
    expect(showToast).not.toHaveBeenCalled();
  });

  it('copy writes the token to the clipboard and shows a copied state', async () => {
    fetchWithAuth.mockResolvedValue(ok());
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    render(<ReleaseTokenTab deviceId="device-1" isolationId="episode-1" />);
    fireEvent.click(screen.getByTestId('isolation-issue-token'));
    await screen.findByTestId('isolation-release-token');
    fireEvent.click(screen.getByTestId('isolation-copy-token'));
    await waitFor(() => expect(screen.getByTestId('isolation-copy-token')).toHaveTextContent('Copied'));
    expect(writeText).toHaveBeenCalledWith(TOKEN);
  });

  it('shows an inline error when the clipboard rejects', async () => {
    fetchWithAuth.mockResolvedValue(ok());
    Object.defineProperty(navigator, 'clipboard', { value: { writeText: vi.fn().mockRejectedValue(new Error('denied')) }, configurable: true });
    render(<ReleaseTokenTab deviceId="device-1" isolationId="episode-1" />);
    fireEvent.click(screen.getByTestId('isolation-issue-token'));
    await screen.findByTestId('isolation-release-token');
    fireEvent.click(screen.getByTestId('isolation-copy-token'));
    expect(await screen.findByRole('alert')).toHaveTextContent(/copy/i);
  });

  it('shows an inline error when the clipboard is unavailable', async () => {
    fetchWithAuth.mockResolvedValue(ok());
    Object.defineProperty(navigator, 'clipboard', { value: undefined, configurable: true });
    render(<ReleaseTokenTab deviceId="device-1" isolationId="episode-1" />);
    fireEvent.click(screen.getByTestId('isolation-issue-token'));
    await screen.findByTestId('isolation-release-token');
    fireEvent.click(screen.getByTestId('isolation-copy-token'));
    expect(await screen.findByRole('alert')).toHaveTextContent(/copy/i);
  });

  it.each([
    ['empty token', { token: '' }],
    ['bad expiry', { expiresAt: 'nope' }],
    ['bad qr', { qrCodeDataUrl: 'https://evil.example/x.png' }],
  ])('treats a malformed success body (%s) as failure and shows no token', async (_n, patch) => {
    fetchWithAuth.mockResolvedValue(ok(patch));
    render(<ReleaseTokenTab deviceId="device-1" isolationId="episode-1" />);
    fireEvent.click(screen.getByTestId('isolation-issue-token'));
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not issue');
    expect(screen.queryByTestId('isolation-release-token')).toBeNull();
    expect(screen.queryByTestId('isolation-token-qr')).toBeNull();
  });

  it('409 release_token_unavailable surfaces the unavailable copy', async () => {
    fetchWithAuth.mockResolvedValue({ ok: false, status: 409, json: async () => ({ error: 'release_token_unavailable', code: 'release_token_unavailable' }) });
    render(<ReleaseTokenTab deviceId="device-1" isolationId="episode-1" />);
    fireEvent.click(screen.getByTestId('isolation-issue-token'));
    await waitFor(() => expect(showToast).toHaveBeenCalled());
    expect(showToast.mock.calls[0][0].message).toMatch(/not available|unavailable/i);
    expect(screen.queryByTestId('isolation-release-token')).toBeNull();
    expect(screen.getByTestId('isolation-issue-token')).toBeEnabled();
  });

  it('a 401 is not double-toasted', async () => {
    fetchWithAuth.mockResolvedValue({ ok: false, status: 401, json: async () => ({}) });
    render(<ReleaseTokenTab deviceId="device-1" isolationId="episode-1" />);
    fireEvent.click(screen.getByTestId('isolation-issue-token'));
    await waitFor(() => expect(screen.getByTestId('isolation-issue-token')).toBeEnabled());
    expect(showToast).not.toHaveBeenCalled();
  });

  it('second click hides the token; issuing again is a new POST', async () => {
    fetchWithAuth.mockResolvedValue(ok());
    render(<ReleaseTokenTab deviceId="device-1" isolationId="episode-1" />);
    fireEvent.click(screen.getByTestId('isolation-issue-token'));
    await screen.findByTestId('isolation-release-token');
    fireEvent.click(screen.getByTestId('isolation-issue-token'));
    expect(screen.queryByTestId('isolation-release-token')).toBeNull();
    fireEvent.click(screen.getByTestId('isolation-issue-token'));
    await screen.findByTestId('isolation-release-token');
    expect(fetchWithAuth).toHaveBeenCalledTimes(2);
  });

  it('clears on generation change without refetching', async () => {
    fetchWithAuth.mockResolvedValue(ok());
    const { rerender } = render(<ReleaseTokenTab deviceId="device-1" isolationId="episode-1" generation={1} />);
    fireEvent.click(screen.getByTestId('isolation-issue-token'));
    await screen.findByTestId('isolation-release-token');
    rerender(<ReleaseTokenTab deviceId="device-1" isolationId="episode-1" generation={2} />);
    expect(screen.queryByTestId('isolation-release-token')).toBeNull();
    expect(fetchWithAuth).toHaveBeenCalledTimes(1);
  });

  it('ignores a stale response that resolves after the generation changed', async () => {
    let resolve!: (v: unknown) => void;
    fetchWithAuth.mockReturnValue(new Promise((r) => { resolve = r; }));
    const { rerender } = render(<ReleaseTokenTab deviceId="device-1" isolationId="episode-1" generation={1} />);
    fireEvent.click(screen.getByTestId('isolation-issue-token'));
    rerender(<ReleaseTokenTab deviceId="device-1" isolationId="episode-1" generation={2} />);
    await act(async () => { resolve(ok()); });
    expect(screen.queryByTestId('isolation-release-token')).toBeNull();
  });

  it('clears automatically at expiry', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-02T11:59:59Z'));
    try {
      fetchWithAuth.mockResolvedValue(ok({ expiresAt: '2026-11-02T12:00:00Z' }));
      render(<ReleaseTokenTab deviceId="device-1" isolationId="episode-1" />);
      await act(async () => { fireEvent.click(screen.getByTestId('isolation-issue-token')); });
      expect(screen.getByTestId('isolation-release-token')).toBeInTheDocument();
      await act(async () => { vi.advanceTimersByTime(1000); });
      expect(screen.queryByTestId('isolation-release-token')).toBeNull();
      expect(fetchWithAuth).toHaveBeenCalledTimes(1);
    } finally { vi.useRealTimers(); }
  });
});
