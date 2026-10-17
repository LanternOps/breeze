/** Overview leads with the device's state and its open alerts (#9029). */
import '@/lib/i18n';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import DeviceOverviewState from './DeviceOverviewState';
import { fetchWithAuth } from '../../stores/auth';

vi.mock('../../stores/auth', () => ({ fetchWithAuth: vi.fn() }));

const jsonResponse = (body: unknown, ok = true) =>
  ({ ok, status: ok ? 200 : 500, json: async () => body }) as Response;
const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000).toISOString();

describe('DeviceOverviewState (#9029)', () => {
  beforeEach(() => {
    vi.mocked(fetchWithAuth).mockReset();
  });

  it('says how long an offline device has been gone and lists its open alerts with severity', async () => {
    vi.mocked(fetchWithAuth).mockResolvedValue(
      jsonResponse({
        data: [
          { id: 'a1', title: 'Disk almost full', severity: 'critical', status: 'active' },
          { id: 'a2', title: 'Agent heartbeat missed', severity: 'high', status: 'active' },
        ],
      }),
    );
    const onOpenTab = vi.fn();
    render(
      <DeviceOverviewState
        deviceId="dev-1"
        status="offline"
        lastSeen={minutesAgo(25)}
        alertCount={2}
        ticketCount={1}
        onOpenTab={onOpenTab}
      />,
    );
    const block = screen.getByTestId('device-overview-state');
    expect(block).toHaveTextContent('Offline · last seen 25 minutes ago');
    expect(fetchWithAuth).toHaveBeenCalledWith('/devices/dev-1/alerts?status=active&limit=3');
    const alert = await screen.findByTestId('device-overview-alert-a1');
    expect(alert).toHaveTextContent('Disk almost full');
    expect(alert).toHaveTextContent(/critical/i);
    expect(within(alert).getByRole('link')).toHaveAttribute('href', '/alerts/a1');

    const alertsLink = screen.getByTestId('device-overview-open-alerts');
    expect(alertsLink).toHaveTextContent('2 open alerts');
    expect(alertsLink).toHaveAttribute('href', '#alerts');
    fireEvent.click(alertsLink);
    expect(onOpenTab).toHaveBeenCalledWith('alerts');

    const ticketsLink = screen.getByTestId('device-overview-open-tickets');
    expect(ticketsLink).toHaveTextContent('1 open ticket');
    expect(ticketsLink).toHaveAttribute('href', '#tickets');
  });

  it('collapses to one muted line when nothing is open', async () => {
    vi.mocked(fetchWithAuth).mockResolvedValue(jsonResponse({ data: [] }));
    render(
      <DeviceOverviewState
        deviceId="dev-1"
        status="online"
        lastSeen={minutesAgo(1)}
        alertCount={0}
        ticketCount={0}
        onOpenTab={vi.fn()}
      />,
    );
    const block = screen.getByTestId('device-overview-state');
    expect(await within(block).findByText('No open alerts')).toBeInTheDocument();
    expect(screen.queryByTestId('device-overview-open-tickets')).toBeNull();
  });
});
