import '@/lib/i18n';

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../stores/auth', () => ({ fetchWithAuth: vi.fn(), registerOrgIdProvider: vi.fn() }));
vi.mock('../shared/Toast', () => ({ showToast: vi.fn() }));

import { fetchWithAuth } from '../../stores/auth';
import { showToast } from '../shared/Toast';
import DeviceMonitoringTab from './DeviceMonitoringTab';

const fetchMock = vi.mocked(fetchWithAuth);
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

const row = {
  monitorId: 'm1',
  name: 'CPU high',
  kind: 'cpu',
  enabled: true,
  sourcePolicyId: 'p1',
  sourcePolicyName: 'Servers',
  lastState: 'breach',
  lastEvaluatedAt: null,
  openEpisode: { id: 'ep1', alertId: 'a1', startedAt: '2026-09-19T10:00:00Z' },
  escalatedAt: '2026-09-19T11:00:00Z',
  escalationAlertId: null,
  responsesPaused: true,
};

const monitorReads = () => fetchMock.mock.calls.filter(([url]) => url === '/devices/d1/monitors');

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(window, 'confirm').mockReturnValue(true);
});

describe('DeviceMonitoringTab — effective device monitors', () => {
  it('loads effective monitors and shows policy, state and episode', async () => {
    fetchMock.mockResolvedValue(json({ data: [row] }));
    render(<DeviceMonitoringTab deviceId="d1" />);
    expect(await screen.findByText('CPU high')).toHaveAttribute('href', '/alerts/monitors/m1');
    expect(fetchMock).toHaveBeenCalledWith('/devices/d1/monitors');
    expect(screen.getByText('Servers')).toHaveAttribute('href', '/configuration-policies/p1#monitors');
    expect(screen.getByTestId('device-monitoring-row')).toHaveTextContent('Breach');
    expect(screen.getByTestId('device-monitor-episode-m1')).toHaveAttribute('href', '/alerts/a1');
  });

  it('shows unknown evidence and disabled effective attachments without a reset action', async () => {
    fetchMock.mockResolvedValue(
      json({
        data: [
          { ...row, enabled: false, lastState: 'unknown', openEpisode: null, escalatedAt: null, responsesPaused: false },
        ],
      }),
    );
    render(<DeviceMonitoringTab deviceId="d1" />);
    expect(await screen.findByTestId('device-monitoring-row')).toHaveTextContent('Unknown');
    expect(screen.getByTestId('device-monitoring-row')).toHaveTextContent('Disabled');
    expect(screen.queryByTestId('device-monitor-reset-m1')).toBeNull();
  });

  it('confirms the reset against the device name, not the monitor name (sweep D5)', async () => {
    fetchMock.mockImplementation(async (_url, init) =>
      init?.method === 'POST' ? json({ success: true }) : json({ data: [row] }),
    );
    render(<DeviceMonitoringTab deviceId="d1" deviceName="Sweep D high CPU" />);
    fireEvent.click(await screen.findByTestId('device-monitor-reset-m1'));
    expect(window.confirm).toHaveBeenCalledWith(expect.stringContaining('Sweep D high CPU'));
    expect(window.confirm).not.toHaveBeenCalledWith(expect.stringContaining(row.name));
  });

  it('resets a latch through runAction and reloads', async () => {
    fetchMock.mockImplementation(async (_url, init) =>
      init?.method === 'POST' ? json({ success: true }) : json({ data: [row] }),
    );
    render(<DeviceMonitoringTab deviceId="d1" />);
    fireEvent.click(await screen.findByTestId('device-monitor-reset-m1'));
    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith('/monitor-definitions/m1/devices/d1/reset', { method: 'POST' }),
    );
    await waitFor(() => expect(showToast).toHaveBeenCalledWith(expect.objectContaining({ type: 'success' })));
    await waitFor(() => expect(monitorReads()).toHaveLength(2));
  });

  it('does nothing when the confirmation is declined', async () => {
    vi.mocked(window.confirm).mockReturnValue(false);
    fetchMock.mockResolvedValue(json({ data: [row] }));
    render(<DeviceMonitoringTab deviceId="d1" />);
    fireEvent.click(await screen.findByTestId('device-monitor-reset-m1'));
    expect(fetchMock.mock.calls.some(([, init]) => init?.method === 'POST')).toBe(false);
  });

  it('reports a logical failure without a false success or reload', async () => {
    fetchMock.mockImplementation(async (_url, init) =>
      init?.method === 'POST' ? json({ success: false, error: 'Reset refused' }) : json({ data: [row] }),
    );
    render(<DeviceMonitoringTab deviceId="d1" />);
    fireEvent.click(await screen.findByTestId('device-monitor-reset-m1'));
    await waitFor(() => expect(showToast).toHaveBeenCalledWith(expect.objectContaining({ type: 'error' })));
    expect(showToast).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'success' }));
    expect(monitorReads()).toHaveLength(1);
  });

  it('distinguishes no effective monitors from a failed read', async () => {
    fetchMock.mockResolvedValue(json({ data: [] }));
    const view = render(<DeviceMonitoringTab deviceId="d1" />);
    expect(await screen.findByTestId('device-monitoring-empty')).toBeInTheDocument();
    view.unmount();
    fetchMock.mockResolvedValue(json({ error: 'Denied' }, 403));
    render(<DeviceMonitoringTab deviceId="d2" />);
    expect(await screen.findByTestId('device-monitoring-error')).toBeInTheDocument();
    expect(screen.queryByTestId('device-monitoring-empty')).toBeNull();
  });
});
