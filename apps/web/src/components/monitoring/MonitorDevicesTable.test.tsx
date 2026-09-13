import '@/lib/i18n';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import MonitorDevicesTable from './MonitorDevicesTable';
import { fetchWithAuth } from '../../stores/auth';

vi.mock('../../stores/auth', () => ({ fetchWithAuth: vi.fn() }));

const fetchMock = vi.mocked(fetchWithAuth);
const json = (payload: unknown, ok = true, status = ok ? 200 : 500): Response =>
  ({ ok, status, statusText: ok ? 'OK' : 'ERR', json: vi.fn().mockResolvedValue(payload) }) as unknown as Response;

describe('MonitorDevicesTable (#5289)', () => {
  it('renders resolved devices once expanded', async () => {
    fetchMock.mockResolvedValue(
      json({ data: [{ deviceId: 'd1', deviceName: 'HOST-1', enabled: true, sourcePolicyName: 'Site Policy' }] }),
    );
    render(<MonitorDevicesTable monitorId="m1" />);
    fireEvent.click(screen.getByTestId('monitor-devices-toggle'));
    await waitFor(() => expect(screen.getByTestId('monitor-devices-row-d1')).toBeInTheDocument());
    expect(screen.getByTestId('monitor-devices-row-d1')).toHaveTextContent('HOST-1');
  });

  it('shows the empty state when no devices resolve', async () => {
    fetchMock.mockResolvedValue(json({ data: [] }));
    render(<MonitorDevicesTable monitorId="m1" />);
    fireEvent.click(screen.getByTestId('monitor-devices-toggle'));
    await waitFor(() => expect(screen.getByText('No devices are covered by this monitor yet.')).toBeInTheDocument());
  });

  it('shows a distinct error message on a failed load, never the empty-state copy', async () => {
    fetchMock.mockResolvedValue(json({}, false, 500));
    render(<MonitorDevicesTable monitorId="m1" />);
    fireEvent.click(screen.getByTestId('monitor-devices-toggle'));
    await waitFor(() => expect(screen.getByText('Failed to load devices')).toBeInTheDocument());
    expect(screen.queryByText('No devices are covered by this monitor yet.')).toBeNull();
  });
});
