import '@/lib/i18n';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import MonitorDetailModal from './MonitorDetailModal';
import { showToast } from '../shared/Toast';
import { fetchWithAuth } from '../../stores/auth';

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
  const monitor = { ...base, managedByMonitorId: null, ...overrides };
  fetchMock.mockResolvedValue(json({ data: monitor }));
  const onUpdated = vi.fn();
  render(<MonitorDetailModal monitorId="m1" onClose={vi.fn()} onUpdated={onUpdated} />);
  await screen.findByTestId(monitor.managedByMonitorId ? 'monitor-check-open-monitor' : 'monitor-check-not-converted');
  return onUpdated;
}

describe('MonitorDetailModal HTTP target and certificate', () => {
  beforeEach(() => vi.clearAllMocks());

  it('links a managed check to its monitor without edit or delete actions', async () => {
    await open({ managedByMonitorId: 'definition-1' });
    expect(screen.getByTestId('monitor-check-open-monitor')).toHaveAttribute('href', '/alerts/monitors/definition-1');
    expect(screen.queryByTestId('monitor-check-edit')).not.toBeInTheDocument();
    expect(screen.queryByText(/delete monitor/i)).not.toBeInTheDocument();
  });

  it('marks unmanaged checks as not converted', async () => {
    await open();
    expect(screen.getByTestId('monitor-check-not-converted')).toBeInTheDocument();
  });

  it.each([409, 200])('reports rejected check requests without success (%s)', async status => {
    const onUpdated = await open();
    fetchMock.mockResolvedValue(json({ success: false, error: 'Check rejected' }, status));
    fireEvent.click(screen.getByRole('button', { name: /check now/i }));
    await waitFor(() => expect(showToast).toHaveBeenCalledWith(expect.objectContaining({ type: 'error', message: 'Check rejected' })));
    expect(onUpdated).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenLastCalledWith('/monitors/m1/check', { method: 'POST' });
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

});
