import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import DeviceSecurityStatus from './DeviceSecurityStatus';
import SecurityScanManager from './SecurityScanManager';
import ThreatList from './ThreatList';
import { fetchWithAuth } from '@/stores/auth';

vi.mock('@/stores/auth', () => ({
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

describe('security UI smoke', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('queues a scan from SecurityScanManager', async () => {
    fetchWithAuthMock
      .mockResolvedValueOnce(makeJsonResponse({
        data: [
          { deviceId: 'dev-1', deviceName: 'FIN-WS-014', os: 'windows', status: 'protected' }
        ]
      }))
      .mockResolvedValueOnce(makeJsonResponse({ data: [] }))
      .mockResolvedValueOnce(makeJsonResponse({ data: { id: 'scan-1' } }, true, 202))
      .mockResolvedValueOnce(makeJsonResponse({
        data: [
          { deviceId: 'dev-1', deviceName: 'FIN-WS-014', os: 'windows', status: 'protected' }
        ]
      }))
      .mockResolvedValueOnce(makeJsonResponse({ data: [] }));

    render(<SecurityScanManager />);

    await screen.findByText('FIN-WS-014');

    const checkboxes = screen.getAllByRole('checkbox');
    fireEvent.click(checkboxes[0]);
    fireEvent.click(screen.getByRole('button', { name: /start scan/i }));

    await waitFor(() => {
      expect(fetchWithAuthMock).toHaveBeenCalledWith('/security/scan/dev-1', expect.objectContaining({ method: 'POST' }));
    });
  });

  it('loads DeviceSecurityStatus and runs quick scan', async () => {
    fetchWithAuthMock
      .mockResolvedValueOnce(makeJsonResponse({ data: [{ deviceId: 'dev-1' }] }))
      .mockResolvedValueOnce(makeJsonResponse({
        data: {
          deviceId: 'dev-1',
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
          threatsDetected: 0
        }
      }))
      .mockResolvedValueOnce(makeJsonResponse({ data: { id: 'scan-2' } }, true, 202))
      .mockResolvedValueOnce(makeJsonResponse({ data: [{ deviceId: 'dev-1' }] }))
      .mockResolvedValueOnce(makeJsonResponse({
        data: {
          deviceId: 'dev-1',
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
          threatsDetected: 0
        }
      }));

    render(<DeviceSecurityStatus showAvActions />);

    await screen.findByText(/FIN-WS-014/i);
    fireEvent.click(screen.getByRole('button', { name: /quick scan/i }));

    await waitFor(() => {
      expect(fetchWithAuthMock).toHaveBeenCalledWith('/security/scan/dev-1', expect.objectContaining({ method: 'POST' }));
    });
  });

  it('loads ThreatList and executes quarantine action', async () => {
    const threatPayload = {
      data: [
        {
          id: 'thr-1',
          deviceId: 'dev-1',
          deviceName: 'FIN-WS-014',
          name: 'Trojan:Win32/Emotet',
          category: 'trojan',
          severity: 'critical',
          status: 'active',
          detectedAt: new Date().toISOString(),
          filePath: 'C:\\malware.exe'
        }
      ]
    };

    fetchWithAuthMock
      .mockResolvedValueOnce(makeJsonResponse(threatPayload))
      .mockResolvedValueOnce(makeJsonResponse({ data: { id: 'thr-1' } }))
      .mockResolvedValueOnce(makeJsonResponse(threatPayload));

    render(<ThreatList />);

    await screen.findByText(/Trojan:Win32\/Emotet/i);

    const checkboxes = screen.getAllByRole('checkbox');
    fireEvent.click(checkboxes[1]);
    fireEvent.click(screen.getByRole('button', { name: /quarantine selected/i }));

    await waitFor(() => {
      expect(fetchWithAuthMock).toHaveBeenCalledWith('/security/threats/thr-1/quarantine', expect.objectContaining({ method: 'POST' }));
    });
  });
});
