import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import SNMPDeviceEditor from './SNMPDeviceEditor';
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

describe('SNMPDeviceEditor', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('loads device/templates and wires test + save actions', async () => {
    const onSaved = vi.fn();

    fetchWithAuthMock.mockImplementation(async (input, init) => {
      const url = String(input);
      const method = init?.method ?? 'GET';

      if (url === '/snmp/templates' && method === 'GET') {
        return makeJsonResponse({
          data: [
            { id: 'tpl-1', name: 'Cisco Core' },
            { id: 'tpl-2', name: 'Juniper Edge' }
          ]
        });
      }

      if (url === '/snmp/devices/device-1' && method === 'GET') {
        return makeJsonResponse({
          data: {
            id: 'device-1',
            name: 'Core-A',
            ipAddress: '10.0.0.10',
            port: 161,
            snmpVersion: 'v2c',
            pollingInterval: 300,
            templateId: 'tpl-1',
            community: 'public'
          }
        });
      }

      if (url === '/snmp/devices/device-1/test' && method === 'POST') {
        return makeJsonResponse({
          data: {
            status: 'queued'
          }
        });
      }

      if (url === '/snmp/devices/device-1' && method === 'PATCH') {
        return makeJsonResponse({
          data: { id: 'device-1' }
        });
      }

      return makeJsonResponse({}, false, 404);
    });

    render(<SNMPDeviceEditor deviceId="device-1" onSaved={onSaved} />);

    await screen.findByDisplayValue('Core-A');

    fireEvent.change(screen.getByLabelText('Device name'), { target: { value: 'Core-A-Renamed' } });
    fireEvent.click(screen.getByRole('button', { name: 'Test connection' }));

    await waitFor(() => {
      const testCalls = fetchWithAuthMock.mock.calls.filter(([url, init]) =>
        String(url) === '/snmp/devices/device-1/test' && init?.method === 'POST'
      );
      expect(testCalls).toHaveLength(1);
    });

    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));

    await waitFor(() => {
      const saveCalls = fetchWithAuthMock.mock.calls.filter(([url, init]) =>
        String(url) === '/snmp/devices/device-1' && init?.method === 'PATCH'
      );
      expect(saveCalls).toHaveLength(1);
    });

    expect(onSaved).toHaveBeenCalledWith('device-1');
  });

  it('creates a new device when used without deviceId', async () => {
    const onSaved = vi.fn();

    fetchWithAuthMock.mockImplementation(async (input, init) => {
      const url = String(input);
      const method = init?.method ?? 'GET';

      if (url === '/snmp/templates' && method === 'GET') {
        return makeJsonResponse({
          data: [{ id: 'tpl-1', name: 'Cisco Core' }]
        });
      }

      if (url === '/snmp/devices' && method === 'POST') {
        return makeJsonResponse({
          data: { id: 'device-2' }
        }, true, 201);
      }

      return makeJsonResponse({}, false, 404);
    });

    render(<SNMPDeviceEditor onSaved={onSaved} />);

    await screen.findByText('Create SNMP device');
    fireEvent.change(screen.getByLabelText('Device name'), { target: { value: 'Edge-B' } });
    fireEvent.change(screen.getByLabelText('IP address'), { target: { value: '10.0.0.22' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create device' }));

    await waitFor(() => {
      const createCalls = fetchWithAuthMock.mock.calls.filter(([url, init]) =>
        String(url) === '/snmp/devices' && init?.method === 'POST'
      );
      expect(createCalls).toHaveLength(1);
    });

    expect(onSaved).toHaveBeenCalledWith('device-2');
  });
});
