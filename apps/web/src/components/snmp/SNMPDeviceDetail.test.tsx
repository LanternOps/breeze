import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import SNMPDeviceDetail from './SNMPDeviceDetail';
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

describe('SNMPDeviceDetail traffic chart', () => {
  beforeAll(() => {
    vi.stubGlobal('ResizeObserver', class ResizeObserver {
      observe() {}
      unobserve() {}
      disconnect() {}
    });
  });

  afterAll(() => {
    vi.unstubAllGlobals();
  });

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders live SNMP device summary, thresholds, recent values, and traffic chart', async () => {
    fetchWithAuthMock.mockImplementation(async (input) => {
      const url = String(input);

      if (url === '/snmp/devices/device-1') {
        return makeJsonResponse({
          data: {
            id: 'device-1',
            name: 'Edge-Switch-42',
            ipAddress: '10.20.30.40',
            status: 'online',
            template: { id: 'tpl-1', name: 'Cisco Core' },
            lastPolledAt: '2026-02-09T10:00:00.000Z',
            recentMetrics: {
              capturedAt: '2026-02-09T10:05:00.000Z',
              metrics: [
                {
                  oid: '1.3.6.1.2.1.2.2.1.10.1',
                  name: 'ifInOctets.1',
                  value: '150',
                  recordedAt: '2026-02-09T10:05:00.000Z'
                },
                {
                  oid: '1.3.6.1.2.1.2.2.1.16.1',
                  name: 'ifOutOctets.1',
                  value: '120',
                  recordedAt: '2026-02-09T10:05:00.000Z'
                }
              ]
            }
          }
        });
      }

      if (url === '/snmp/thresholds/device-1') {
        return makeJsonResponse({
          data: [
            {
              id: 'th-1',
              oid: '1.3.6.1.2.1.2.2.1.10.1',
              operator: '>',
              threshold: '100',
              severity: 'high',
              message: 'Ingress warning',
              isActive: true
            }
          ]
        });
      }

      if (url.startsWith('/snmp/metrics/device-1/history')) {
        return makeJsonResponse({
          data: {
            series: [
              {
                oid: '1.3.6.1.2.1.2.2.1.10.1',
                name: 'ifInOctets.1',
                points: [
                  { timestamp: '2026-02-09T10:00:00.000Z', value: '100' },
                  { timestamp: '2026-02-09T10:05:00.000Z', value: '150' }
                ]
              },
              {
                oid: '1.3.6.1.2.1.2.2.1.16.1',
                name: 'ifOutOctets.1',
                points: [
                  { timestamp: '2026-02-09T10:00:00.000Z', value: '80' },
                  { timestamp: '2026-02-09T10:05:00.000Z', value: '120' }
                ]
              }
            ]
          }
        });
      }

      return makeJsonResponse({}, false, 404);
    });

    render(<SNMPDeviceDetail deviceId="device-1" />);

    await screen.findByText('Edge-Switch-42');
    await screen.findByLabelText('SNMP interface traffic chart');

    expect(screen.getByText('Ingress warning')).not.toBeNull();
    expect(screen.getAllByText('ifInOctets.1').length).toBeGreaterThan(0);
    expect(screen.getByText('10.20.30.40')).not.toBeNull();
    expect(screen.queryByText('Core-Switch-01')).toBeNull();
    expect(screen.queryByText('Line chart placeholder for interface traffic')).toBeNull();
    expect(fetchWithAuthMock).toHaveBeenCalledWith(expect.stringMatching(/^\/snmp\/metrics\/device-1\/history\?/));
  });

  it('shows explicit empty states when live SNMP endpoints return no data', async () => {
    fetchWithAuthMock.mockImplementation(async (input) => {
      const url = String(input);
      if (url === '/snmp/devices/device-1') {
        return makeJsonResponse({
          data: {
            id: 'device-1',
            name: 'Edge-Switch-42',
            ipAddress: '10.20.30.40',
            status: 'online',
            template: null,
            lastPolledAt: null,
            recentMetrics: null
          }
        });
      }

      if (url === '/snmp/thresholds/device-1') {
        return makeJsonResponse({ data: [] });
      }

      if (url.startsWith('/snmp/metrics/device-1/history')) {
        return makeJsonResponse({ data: { series: [] } });
      }

      return makeJsonResponse({}, false, 404);
    });

    render(<SNMPDeviceDetail deviceId="device-1" />);

    await waitFor(() => {
      expect(screen.getByText('No interface traffic history available.')).not.toBeNull();
      expect(screen.getByText('No recent SNMP metrics available.')).not.toBeNull();
      expect(screen.getByText('No thresholds configured.')).not.toBeNull();
    });
  });

  it('opens the editor and refreshes header details after save', async () => {
    let deviceName = 'Edge-Switch-42';

    fetchWithAuthMock.mockImplementation(async (input, init) => {
      const url = String(input);
      const method = init?.method ?? 'GET';

      if (url === '/snmp/devices/device-1' && method === 'GET') {
        return makeJsonResponse({
          data: {
            id: 'device-1',
            name: deviceName,
            ipAddress: '10.20.30.40',
            status: 'online',
            snmpVersion: 'v2c',
            pollingInterval: 300,
            template: { id: 'tpl-1', name: 'Cisco Core' },
            templateId: 'tpl-1',
            lastPolledAt: null,
            recentMetrics: null
          }
        });
      }

      if (url === '/snmp/thresholds/device-1') {
        return makeJsonResponse({ data: [] });
      }

      if (url.startsWith('/snmp/metrics/device-1/history')) {
        return makeJsonResponse({ data: { series: [] } });
      }

      if (url === '/snmp/templates' && method === 'GET') {
        return makeJsonResponse({
          data: [{ id: 'tpl-1', name: 'Cisco Core' }]
        });
      }

      if (url === '/snmp/devices/device-1' && method === 'PATCH') {
        const body = JSON.parse(String(init?.body ?? '{}'));
        deviceName = String(body.name ?? deviceName);
        return makeJsonResponse({
          data: { id: 'device-1', name: deviceName }
        });
      }

      return makeJsonResponse({}, false, 404);
    });

    render(<SNMPDeviceDetail deviceId="device-1" />);

    await screen.findByText('Edge-Switch-42');
    fireEvent.click(screen.getByRole('button', { name: 'Edit device' }));

    await screen.findByText('Edit SNMP device');
    fireEvent.change(screen.getByLabelText('Device name'), { target: { value: 'Edge-Switch-99' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));

    await waitFor(() => {
      const patchCalls = fetchWithAuthMock.mock.calls.filter(([url, options]) =>
        String(url) === '/snmp/devices/device-1' && options?.method === 'PATCH'
      );
      expect(patchCalls).toHaveLength(1);
    });

    await screen.findByText('Edge-Switch-99');
  });
});
