import '@/lib/i18n';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import MonitorDetailModal from './MonitorDetailModal';
import { fetchWithAuth } from '../../stores/auth';
import { showToast } from '../shared/Toast';

vi.mock('../../stores/auth', () => ({ fetchWithAuth: vi.fn() }));
vi.mock('../shared/Toast', () => ({ showToast: vi.fn() }));
const fetchMock = vi.mocked(fetchWithAuth);
const base = {
  id: 'm1', name: 'Website', monitorType: 'http_check', target: 'https://example.com',
  config: {}, pollingInterval: 60, timeout: 5, isActive: true,
  lastChecked: null, lastStatus: 'unknown', lastResponseMs: null, lastError: null,
  consecutiveFailures: 0, recentResults: [], alertRules: [], tlsState: null,
};
const observed = {
  tlsState: 'observed', tlsIssuer: 'Example CA', tlsNotAfter: '2026-12-15T12:00:00.000Z',
  tlsObservedHost: 'example.com',
};
const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status });

async function open(overrides = {}) {
  let monitor = { ...base, ...overrides };
  fetchMock.mockImplementation(async (_url, init) => {
    if (init?.method === 'PATCH') {
      const patch = JSON.parse(init.body as string);
      monitor = { ...monitor, ...patch, ...(patch.target ? { tlsState: null } : {}) };
      return json({ data: monitor });
    }
    return json({ data: monitor });
  });
  const onUpdated = vi.fn();
  render(<MonitorDetailModal monitorId="m1" onClose={vi.fn()} onDeleted={vi.fn()} onUpdated={onUpdated} />);
  await screen.findByTestId('monitor-check-edit');
  return onUpdated;
}

function patchBody() {
  const call = fetchMock.mock.calls.find(([, init]) => init?.method === 'PATCH');
  expect(call?.[0]).toBe('/monitors/m1');
  return JSON.parse(call![1]!.body as string);
}

describe('MonitorDetailModal HTTP target and certificate', () => {
  beforeEach(() => vi.clearAllMocks());

  it('edits the HTTP URL, sends target, and refreshes the invalidated certificate', async () => {
    const onUpdated = await open(observed);
    fireEvent.click(screen.getByTestId('monitor-check-edit'));
    const target = screen.getByTestId('monitor-check-target');
    expect(target).toHaveValue(base.target);
    expect(target).toHaveAttribute('type', 'url');
    expect(screen.getByTestId('monitor-check-target-note')).toHaveTextContent('Changing the URL resets the TLS observation.');
    fireEvent.change(target, { target: { value: 'https://new.example.com' } });
    fireEvent.click(screen.getByTestId('monitor-check-save'));
    await waitFor(() => expect(onUpdated).toHaveBeenCalledOnce());
    expect(patchBody()).toEqual({ name: 'Website', pollingInterval: 60, timeout: 5, isActive: true, target: 'https://new.example.com' });
    expect(screen.queryByTestId('monitor-check-certificate')).not.toBeInTheDocument();
    expect(showToast).toHaveBeenCalledWith(expect.objectContaining({ type: 'success' }));
  });

  it.each(['', 'not-a-url'])('rejects an invalid target URL (%s)', async (target) => {
    const onUpdated = await open();
    fireEvent.click(screen.getByTestId('monitor-check-edit'));
    fireEvent.change(screen.getByTestId('monitor-check-target'), { target: { value: target } });
    fireEvent.click(screen.getByTestId('monitor-check-save'));
    expect(screen.getByTestId('monitor-check-target')).toBeInvalid();
    expect(fetchMock.mock.calls.some(([, init]) => init?.method === 'PATCH')).toBe(false);
    expect(onUpdated).not.toHaveBeenCalled();
  });

  it('omits an unchanged target from PATCH', async () => {
    const onUpdated = await open();
    fireEvent.click(screen.getByTestId('monitor-check-edit'));
    fireEvent.click(screen.getByTestId('monitor-check-save'));
    await waitFor(() => expect(onUpdated).toHaveBeenCalledOnce());
    expect(patchBody()).not.toHaveProperty('target');
  });

  it('does not expose URL editing for non-HTTP checks', async () => {
    await open({ monitorType: 'icmp_ping', target: 'example.com' });
    fireEvent.click(screen.getByTestId('monitor-check-edit'));
    expect(screen.queryByTestId('monitor-check-target')).not.toBeInTheDocument();
  });

  it('hides the certificate when TLS state is null', async () => {
    await open();
    expect(screen.queryByTestId('monitor-check-certificate')).not.toBeInTheDocument();
  });

  it('shows the certificate issuer, formatted expiry, observed host and state', async () => {
    await open(observed);
    const certificate = screen.getByTestId('monitor-check-certificate');
    expect(certificate).toHaveTextContent('Example CA');
    expect(certificate).toHaveTextContent('example.com');
    expect(certificate).toHaveTextContent('Observed');
    expect(certificate).toHaveTextContent('Dec 15, 2026');
    expect(certificate).not.toHaveTextContent(observed.tlsNotAfter);
  });

  it.each([['handshake_failed', 'Handshake failed'], ['not_tls', 'No TLS']])('shows %s without inventing certificate values', async (tlsState, label) => {
    await open({ tlsState });
    expect(screen.getByTestId('monitor-check-certificate')).toHaveTextContent(label);
    expect(screen.getByTestId('monitor-check-certificate')).not.toHaveTextContent('Invalid Date');
  });

  it('surfaces PATCH failures and retains the edit form', async () => {
    const onUpdated = await open();
    fetchMock.mockResolvedValue(json({ success: false, error: 'Update rejected' }));
    fireEvent.click(screen.getByTestId('monitor-check-edit'));
    fireEvent.click(screen.getByTestId('monitor-check-save'));
    await waitFor(() => expect(showToast).toHaveBeenCalledWith(expect.objectContaining({ type: 'error', message: 'Update rejected' })));
    expect(onUpdated).not.toHaveBeenCalled();
    expect(screen.getByTestId('monitor-check-save')).toBeInTheDocument();
  });
});
