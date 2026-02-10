import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import SNMPDeviceList from './SNMPDeviceList';
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

describe('SNMPDeviceList actions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(window, 'confirm').mockImplementation(() => true);
  });

  it('wires poll and delete actions to SNMP API routes', async () => {
    let devices = [
      {
        id: 'device-1',
        name: 'Core-A',
        ipAddress: '10.0.0.1',
        snmpVersion: 'v2c',
        templateName: 'Cisco Core',
        status: 'online',
        lastPolledAt: '2026-02-09T10:00:00.000Z',
        pollingInterval: 300
      }
    ];

    fetchWithAuthMock.mockImplementation(async (input, init) => {
      const url = String(input);
      const method = init?.method ?? 'GET';

      if (url === '/snmp/devices' && method === 'GET') {
        return makeJsonResponse({ data: devices });
      }

      if (url === '/snmp/devices/device-1/poll' && method === 'POST') {
        return makeJsonResponse({ data: { status: 'queued' } });
      }

      if (url === '/snmp/devices/device-1' && method === 'DELETE') {
        devices = [];
        return makeJsonResponse({ data: { id: 'device-1' } });
      }

      return makeJsonResponse({}, false, 404);
    });

    render(<SNMPDeviceList />);

    await screen.findByText('Core-A');

    fireEvent.click(screen.getByRole('button', { name: 'Poll' }));
    await waitFor(() => {
      const pollCalls = fetchWithAuthMock.mock.calls.filter(([url, init]) =>
        String(url) === '/snmp/devices/device-1/poll' && init?.method === 'POST'
      );
      expect(pollCalls).toHaveLength(1);
    });

    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    await waitFor(() => {
      const deleteCalls = fetchWithAuthMock.mock.calls.filter(([url, init]) =>
        String(url) === '/snmp/devices/device-1' && init?.method === 'DELETE'
      );
      expect(deleteCalls).toHaveLength(1);
    });

    await screen.findByText('No SNMP devices found.');
  });

  it('wires add and edit actions to SNMP API routes', async () => {
    let devices = [
      {
        id: 'device-1',
        name: 'Core-A',
        ipAddress: '10.0.0.1',
        snmpVersion: 'v2c',
        templateName: 'Cisco Core',
        status: 'online',
        lastPolledAt: null,
        pollingInterval: 300
      }
    ];

    fetchWithAuthMock.mockImplementation(async (input, init) => {
      const url = String(input);
      const method = init?.method ?? 'GET';

      if (url === '/snmp/devices' && method === 'GET') {
        return makeJsonResponse({ data: devices });
      }

      if (url === '/snmp/devices' && method === 'POST') {
        const body = JSON.parse(String(init?.body ?? '{}'));
        devices = [
          ...devices,
          {
            id: 'device-2',
            name: body.name,
            ipAddress: body.ipAddress,
            snmpVersion: body.snmpVersion,
            templateName: null,
            status: 'offline',
            lastPolledAt: null,
            pollingInterval: body.pollingInterval ?? 300
          }
        ];
        return makeJsonResponse({ data: { id: 'device-2' } }, true, 201);
      }

      if (url === '/snmp/devices/device-1' && method === 'PATCH') {
        const body = JSON.parse(String(init?.body ?? '{}'));
        devices = devices.map((device) => (
          device.id === 'device-1'
            ? { ...device, name: body.name ?? device.name, ipAddress: body.ipAddress ?? device.ipAddress }
            : device
        ));
        return makeJsonResponse({ data: { id: 'device-1' } });
      }

      return makeJsonResponse({}, false, 404);
    });

    render(<SNMPDeviceList />);

    await screen.findByText('Core-A');

    fireEvent.click(screen.getByRole('button', { name: 'Add device' }));
    fireEvent.change(screen.getByPlaceholderText('Device name'), { target: { value: 'Edge-B' } });
    fireEvent.change(screen.getByPlaceholderText('IP address'), { target: { value: '10.0.0.2' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create device' }));

    await waitFor(() => {
      const createCalls = fetchWithAuthMock.mock.calls.filter(([url, init]) =>
        String(url) === '/snmp/devices' && init?.method === 'POST'
      );
      expect(createCalls).toHaveLength(1);
    });

    await screen.findByText('Edge-B');

    const editButtons = screen.getAllByRole('button', { name: 'Edit' });
    fireEvent.click(editButtons[0]!);
    fireEvent.change(screen.getByPlaceholderText('Device name'), { target: { value: 'Core-A-Renamed' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));

    await waitFor(() => {
      const patchCalls = fetchWithAuthMock.mock.calls.filter(([url, init]) =>
        String(url) === '/snmp/devices/device-1' && init?.method === 'PATCH'
      );
      expect(patchCalls).toHaveLength(1);
    });

    await screen.findByText('Core-A-Renamed');
  });
});
