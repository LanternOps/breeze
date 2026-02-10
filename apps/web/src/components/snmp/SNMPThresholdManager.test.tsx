import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import SNMPThresholdManager from './SNMPThresholdManager';
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

describe('SNMPThresholdManager', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('loads devices and threshold rows from API data', async () => {
    fetchWithAuthMock.mockImplementation(async (input) => {
      const url = String(input);
      if (url === '/snmp/devices') {
        return makeJsonResponse({
          data: [{ id: 'device-1', name: 'HQ Core', ipAddress: '10.0.0.10' }]
        });
      }
      if (url.startsWith('/snmp/thresholds/')) {
        return makeJsonResponse({
          data: [{
            id: 'threshold-1',
            oid: '1.3.6.1.2.1.2.2.1.10.1',
            operator: '>',
            threshold: '100',
            severity: 'critical',
            message: 'Ingress critical',
            isActive: true
          }]
        });
      }

      return makeJsonResponse({}, false, 404);
    });

    render(<SNMPThresholdManager />);

    await screen.findByText('Thresholds for HQ Core');
    await screen.findByText('Ingress critical');
    expect(screen.getByText('1.3.6.1.2.1.2.2.1.10.1')).not.toBeNull();
    expect(screen.queryByText('Core-Switch-01')).toBeNull();
  });

  it('creates a new threshold and refreshes the list', async () => {
    let thresholdsFetchCount = 0;

    fetchWithAuthMock.mockImplementation(async (input, init) => {
      const url = String(input);

      if (url === '/snmp/devices') {
        return makeJsonResponse({
          data: [{ id: 'device-1', name: 'HQ Core', ipAddress: '10.0.0.10' }]
        });
      }

      if (url === '/snmp/thresholds/device-1') {
        thresholdsFetchCount += 1;
        if (thresholdsFetchCount === 1) {
          return makeJsonResponse({ data: [] });
        }

        return makeJsonResponse({
          data: [{
            id: 'threshold-2',
            oid: '1.3.6.1.2.1.2.2.1.16.1',
            operator: '>',
            threshold: '90',
            severity: 'high',
            message: 'Egress high',
            isActive: true
          }]
        });
      }

      if (url === '/snmp/thresholds' && init?.method === 'POST') {
        return makeJsonResponse({ data: { id: 'threshold-2' } }, true, 201);
      }

      return makeJsonResponse({}, false, 404);
    });

    render(<SNMPThresholdManager />);

    await screen.findByText('No thresholds configured for this device.');

    fireEvent.change(screen.getByPlaceholderText('OID (e.g. 1.3.6.1.2.1.25.3.3.1.2)'), {
      target: { value: '1.3.6.1.2.1.2.2.1.16.1' }
    });
    fireEvent.change(screen.getByPlaceholderText('Threshold value'), {
      target: { value: '90' }
    });
    fireEvent.change(screen.getByPlaceholderText('Optional message'), {
      target: { value: 'Egress high' }
    });

    fireEvent.click(screen.getByRole('button', { name: 'Add rule' }));

    await waitFor(() => {
      const createCalls = fetchWithAuthMock.mock.calls.filter(([url, init]) =>
        String(url) === '/snmp/thresholds' && init?.method === 'POST'
      );
      expect(createCalls).toHaveLength(1);
      const body = JSON.parse(String(createCalls[0]?.[1]?.body ?? '{}'));
      expect(body).toMatchObject({
        deviceId: 'device-1',
        oid: '1.3.6.1.2.1.2.2.1.16.1',
        threshold: '90',
        message: 'Egress high'
      });
    });

    await screen.findByText('Egress high');
  });
});
