import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import DeviceSecurityTab from './DeviceSecurityTab';
import { fetchWithAuth } from '../../stores/auth';

let edrFlagOn = true;
vi.mock('../../lib/featureFlags', async (orig) => ({
  ...(await orig<typeof import('../../lib/featureFlags')>()),
  ENABLE_ENDPOINT_AV_FEATURES: true,
  get ENABLE_EDR_INTEGRATIONS() { return edrFlagOn; },
}));

vi.mock('./DeviceEdrPanel', () => ({
  default: ({ orgId }: { orgId: string }) => <div data-testid="edr-panel-stub">{orgId}</div>
}));

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

const deviceId = '11111111-1111-1111-1111-111111111111';
const orgId = '22222222-2222-2222-2222-222222222222';

describe('DeviceSecurityTab', () => {
  afterEach(() => {
    edrFlagOn = true;
  });

  beforeEach(() => {
    vi.clearAllMocks();

    fetchWithAuthMock.mockImplementation(async (input, init) => {
      const url = String(input);
      const method = init?.method ?? 'GET';

      if (url === `/security/status/${deviceId}` && method === 'GET') {
        return makeJsonResponse({
          data: {
            deviceId,
            deviceName: 'FIN-WS-014',
            provider: { name: 'Microsoft Defender', vendor: 'Microsoft' },
            providerVersion: '1.0',
            definitionsVersion: '1.0',
            definitionsUpdatedAt: new Date().toISOString(),
            lastScanAt: new Date().toISOString(),
            lastScanType: 'quick',
            realTimeProtection: true,
            firewallEnabled: true,
            encryptionStatus: 'encrypted',
            status: 'protected',
            threatsDetected: 1
          }
        });
      }

      if (url.startsWith(`/security/threats/${deviceId}`) && method === 'GET') {
        return makeJsonResponse({
          data: [
            {
              id: 'thr-1',
              name: 'Trojan:Win32/Emotet',
              severity: 'critical',
              status: 'active',
              detectedAt: new Date().toISOString(),
              filePath: 'C:\\malware.exe'
            }
          ]
        });
      }

      if (url.startsWith(`/security/scans/${deviceId}`) && method === 'GET') {
        return makeJsonResponse({
          data: [
            {
              id: 'scan-1',
              scanType: 'quick',
              status: 'completed',
              startedAt: new Date().toISOString(),
              finishedAt: new Date().toISOString(),
              threatsFound: 1
            }
          ]
        });
      }

      if (url === `/security/scan/${deviceId}` && method === 'POST') {
        return makeJsonResponse({ data: { id: 'scan-2' } }, true, 202);
      }

      if (url === '/security/threats/thr-1/quarantine' && method === 'POST') {
        return makeJsonResponse({ data: { id: 'thr-1' } });
      }

      return makeJsonResponse({}, false, 404);
    });
  });

  it('renders device security status, recent threats, and recent scans', async () => {
    render(<DeviceSecurityTab deviceId={deviceId} orgId={orgId} />);

    await screen.findByText(/FIN-WS-014/i);
    await screen.findByText('Trojan:Win32/Emotet');
    await screen.findByText(/threats found: 1/i);

    expect(fetchWithAuthMock).toHaveBeenCalledWith(`/security/status/${deviceId}`);
    expect(fetchWithAuthMock).toHaveBeenCalledWith(`/security/threats/${deviceId}?limit=10`);
    expect(fetchWithAuthMock).toHaveBeenCalledWith(`/security/scans/${deviceId}?limit=10`);
  });

  it('renders the EDR panel with the device orgId when the flag is on', async () => {
    render(<DeviceSecurityTab deviceId="dev-1" orgId="org-9" />);

    expect(await screen.findByTestId('edr-panel-stub')).toHaveTextContent('org-9');
  });

  it('does NOT render the EDR panel when ENABLE_EDR_INTEGRATIONS is off', async () => {
    edrFlagOn = false;
    render(<DeviceSecurityTab deviceId="dev-1" orgId="org-9" />);
    await waitFor(() => expect(screen.queryByTestId('edr-panel-stub')).toBeNull());
  });

  it('runs a full scan from the device security operations panel', async () => {
    render(<DeviceSecurityTab deviceId={deviceId} orgId={orgId} />);

    await screen.findByText(/FIN-WS-014/i);

    fireEvent.click(screen.getByRole('button', { name: /run full scan/i }));

    await waitFor(() => {
      expect(fetchWithAuthMock).toHaveBeenCalledWith(
        `/security/scan/${deviceId}`,
        expect.objectContaining({ method: 'POST' })
      );
    });
  });

  it('quarantines an active threat from the threat card', async () => {
    render(<DeviceSecurityTab deviceId={deviceId} orgId={orgId} />);

    await screen.findByText('Trojan:Win32/Emotet');

    fireEvent.click(screen.getByRole('button', { name: /quarantine/i }));

    await waitFor(() => {
      expect(fetchWithAuthMock).toHaveBeenCalledWith('/security/threats/thr-1/quarantine', expect.objectContaining({ method: 'POST' }));
    });
  });
});
