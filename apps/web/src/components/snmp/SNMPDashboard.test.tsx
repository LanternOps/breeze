import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import SNMPDashboard from './SNMPDashboard';
import { fetchWithAuth } from '../../stores/auth';

vi.mock('../../stores/auth', () => ({
  fetchWithAuth: vi.fn()
}));

const fetchWithAuthMock = vi.mocked(fetchWithAuth);

const makeJsonResponse = (payload: unknown, ok = true, status = ok ? 200 : 500): Response =>
  ({
    ok,
    status,
    statusText: ok ? 'OK' : 'ERROR',
    json: vi.fn().mockResolvedValue(payload)
  }) as unknown as Response;

describe('SNMPDashboard', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('loads recent alerts from API instead of forcing an empty list', async () => {
    fetchWithAuthMock.mockImplementation(async (input) => {
      const url = String(input);

      if (url === '/snmp/dashboard') {
        return makeJsonResponse({
          data: {
            totals: { devices: 1, thresholds: 1 },
            status: { online: 1 },
            recentPolls: [{ lastPolledAt: '2026-02-09T10:00:00.000Z' }],
            topInterfaces: []
          }
        });
      }

      if (url === '/snmp/devices') {
        return makeJsonResponse({
          data: [
            {
              id: 'device-1',
              name: 'Core-1',
              ipAddress: '10.0.0.1',
              status: 'online',
              templateId: 'tpl-1',
              lastPolledAt: '2026-02-09T10:00:00.000Z'
            }
          ]
        });
      }

      if (url === '/alerts?status=active&limit=25') {
        return makeJsonResponse({
          data: [
            {
              id: 'alert-1',
              deviceId: 'device-1',
              deviceName: 'Core-1',
              message: 'Interface utilization high',
              severity: 'critical',
              triggeredAt: '2026-02-09T10:05:00.000Z'
            }
          ]
        });
      }

      return makeJsonResponse({}, false, 404);
    });

    render(<SNMPDashboard />);

    await screen.findByText('Interface utilization high');
    expect(screen.queryByText('No active alerts.')).toBeNull();
    expect(fetchWithAuthMock).toHaveBeenCalledWith('/alerts?status=active&limit=25');
  });

  it('renders top bandwidth consumers from dashboard topInterfaces payload', async () => {
    fetchWithAuthMock.mockImplementation(async (input) => {
      const url = String(input);

      if (url === '/snmp/dashboard') {
        return makeJsonResponse({
          data: {
            totals: { devices: 1, thresholds: 0 },
            status: { online: 1 },
            recentPolls: [{ lastPolledAt: '2026-02-09T10:00:00.000Z' }],
            topInterfaces: [
              {
                deviceId: 'device-1',
                name: 'Core-1 / ifIndex 1',
                inOctets: 4000000,
                outOctets: 2000000,
                totalOctets: 6000000
              }
            ]
          }
        });
      }

      if (url === '/snmp/devices') {
        return makeJsonResponse({
          data: [
            {
              id: 'device-1',
              name: 'Core-1',
              ipAddress: '10.0.0.1',
              status: 'online',
              templateId: 'tpl-1',
              lastPolledAt: '2026-02-09T10:00:00.000Z'
            }
          ]
        });
      }

      if (url === '/alerts?status=active&limit=25') {
        return makeJsonResponse({ data: [] });
      }

      return makeJsonResponse({}, false, 404);
    });

    render(<SNMPDashboard />);

    await screen.findByText('Core-1 / ifIndex 1');
    expect(screen.getByText('6 MB')).not.toBeNull();
    expect(screen.queryByText('No bandwidth data available.')).toBeNull();
  });
});
