import '@/lib/i18n';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import ReliabilityBaselineDialog from './ReliabilityBaselineDialog';
import { fetchWithAuth } from '../../stores/auth';
import { showToast } from '../shared/Toast';

vi.mock('../../stores/auth', () => ({ fetchWithAuth: vi.fn() }));
vi.mock('../shared/Toast', () => ({ showToast: vi.fn() }));
const fetchMock = vi.mocked(fetchWithAuth);
const toastMock = vi.mocked(showToast);
const ok = (body: unknown, status = 201) => ({ ok: true, status, statusText: 'OK', json: vi.fn().mockResolvedValue(body) }) as unknown as Response;
const fail = (body: unknown, status: number) => ({ ok: false, status, statusText: 'ERR', json: vi.fn().mockResolvedValue(body) }) as unknown as Response;

const pad = (n: number) => String(n).padStart(2, '0');
const localMinute = (d: Date) =>
  `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;

describe('ReliabilityBaselineDialog (#5876)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('requires a note for Remediated before it can be saved', async () => {
    render(<ReliabilityBaselineDialog deviceId="dev-1" open onClose={vi.fn()} onSaved={vi.fn()} />);
    fireEvent.change(screen.getByTestId('baseline-reason'), { target: { value: 'remediated' } });
    expect(screen.getByTestId('baseline-save')).toBeDisabled();
    fireEvent.change(screen.getByTestId('baseline-note'), { target: { value: 'Replaced RAM' } });
    expect(screen.getByTestId('baseline-save')).not.toBeDisabled();
  });

  it('treats a whitespace-only note as blank for Remediated', () => {
    render(<ReliabilityBaselineDialog deviceId="dev-1" open onClose={vi.fn()} onSaved={vi.fn()} />);
    expect((screen.getByTestId('baseline-reason') as HTMLSelectElement).value).toBe('remediated');
    fireEvent.change(screen.getByTestId('baseline-note'), { target: { value: '   ' } });
    expect(screen.getByTestId('baseline-save')).toBeDisabled();
  });

  it('allows Reimaged without a note and posts reason + ISO time', async () => {
    fetchMock.mockResolvedValue(ok({ baseline: { id: 'b1' }, reliability: null }));
    const onSaved = vi.fn();
    render(<ReliabilityBaselineDialog deviceId="dev-1" open onClose={vi.fn()} onSaved={onSaved} />);
    fireEvent.change(screen.getByTestId('baseline-reason'), { target: { value: 'reimaged' } });
    fireEvent.click(screen.getByTestId('baseline-save'));
    await waitFor(() => expect(onSaved).toHaveBeenCalled());
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('/reliability/dev-1/baselines');
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body.reason).toBe('reimaged');
    expect(new Date(body.baselineAt).toString()).not.toBe('Invalid Date');
  });

  it('toasts that scoring restarts when the new marker is the effective one', async () => {
    fetchMock.mockResolvedValue(ok({ baseline: { id: 'b1' }, reliability: { baseline: { id: 'b1' } } }));
    render(<ReliabilityBaselineDialog deviceId="dev-1" open onClose={vi.fn()} onSaved={vi.fn()} />);
    fireEvent.change(screen.getByTestId('baseline-reason'), { target: { value: 'reimaged' } });
    fireEvent.click(screen.getByTestId('baseline-save'));
    await waitFor(() => expect(toastMock).toHaveBeenCalledWith({
      type: 'success',
      message: 'Marker saved — scoring restarts from this point',
    }));
  });

  it('says the score did not change when a later marker is still in effect', async () => {
    // Backdated before a later marker: the effective marker is still b2.
    fetchMock.mockResolvedValue(ok({ baseline: { id: 'b1' }, reliability: { baseline: { id: 'b2' } } }));
    render(<ReliabilityBaselineDialog deviceId="dev-1" open onClose={vi.fn()} onSaved={vi.fn()} />);
    fireEvent.change(screen.getByTestId('baseline-reason'), { target: { value: 'reimaged' } });
    fireEvent.click(screen.getByTestId('baseline-save'));
    await waitFor(() => expect(toastMock).toHaveBeenCalledWith({
      type: 'success',
      message: "Marker saved. A later marker is still in effect, so the score didn't change.",
    }));
  });

  it('names the dialog by its visible heading', () => {
    render(<ReliabilityBaselineDialog deviceId="dev-1" open onClose={vi.fn()} onSaved={vi.fn()} />);
    const dialog = screen.getByRole('dialog', { name: 'Mark work done on this device' });
    const headingId = dialog.getAttribute('aria-labelledby');
    expect(headingId).toBeTruthy();
    expect(document.getElementById(headingId!)?.tagName).toBe('H3');
    expect(dialog.hasAttribute('aria-label')).toBe(false);
  });

  it('bounds the date input to the last 30 days', () => {
    render(<ReliabilityBaselineDialog deviceId="dev-1" open onClose={vi.fn()} onSaved={vi.fn()} />);
    const input = screen.getByTestId('baseline-at') as HTMLInputElement;
    expect(input.min).not.toBe('');
    expect(input.max).not.toBe('');
  });

  it('formats the bounds and default in local time, 30 days apart', () => {
    const before = new Date();
    render(<ReliabilityBaselineDialog deviceId="dev-1" open onClose={vi.fn()} onSaved={vi.fn()} />);
    const input = screen.getByTestId('baseline-at') as HTMLInputElement;
    expect(input.min).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/);
    // max and the default are "now" in the browser's local zone, not UTC.
    expect([localMinute(before), localMinute(new Date())]).toContain(input.max);
    expect(input.value).toBe(input.max);
    // A datetime-local string parses as local time, so the span is 30 days
    // (± the minute the min is rounded up to, ± one DST hour).
    const spanMs = new Date(input.max).getTime() - new Date(input.min).getTime();
    expect(Math.abs(spanMs - 30 * 24 * 60 * 60 * 1000)).toBeLessThanOrEqual(61 * 60 * 1000);
  });

  it('shows the friendly server reason inline and stays open on a 400', async () => {
    fetchMock.mockResolvedValue(fail({ error: 'too old', code: 'baseline_too_old' }, 400));
    const onSaved = vi.fn();
    const onClose = vi.fn();
    render(<ReliabilityBaselineDialog deviceId="dev-1" open onClose={onClose} onSaved={onSaved} />);
    fireEvent.change(screen.getByTestId('baseline-reason'), { target: { value: 'reimaged' } });
    fireEvent.click(screen.getByTestId('baseline-save'));
    const error = await screen.findByTestId('baseline-error');
    expect(error).toHaveTextContent('30 days');
    expect(toastMock).toHaveBeenCalledWith(expect.objectContaining({ type: 'error' }));
    expect(onSaved).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByTestId('baseline-save')).not.toBeDisabled();
  });

  it('stays quiet on a 401 (the auth redirect owns it)', async () => {
    fetchMock.mockResolvedValue(fail({ error: 'Unauthorized' }, 401));
    const onSaved = vi.fn();
    render(<ReliabilityBaselineDialog deviceId="dev-1" open onClose={vi.fn()} onSaved={onSaved} />);
    fireEvent.change(screen.getByTestId('baseline-reason'), { target: { value: 'reimaged' } });
    fireEvent.click(screen.getByTestId('baseline-save'));
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    await waitFor(() => expect(screen.getByTestId('baseline-save')).not.toBeDisabled());
    expect(screen.queryByTestId('baseline-error')).toBeNull();
    expect(toastMock).not.toHaveBeenCalled();
    expect(onSaved).not.toHaveBeenCalled();
  });
});
