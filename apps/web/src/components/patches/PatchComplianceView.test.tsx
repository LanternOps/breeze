import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import PatchComplianceView from './PatchComplianceView';
import { fetchWithAuth } from '../../stores/auth';

vi.mock('../../stores/auth', () => ({
  fetchWithAuth: vi.fn(),
}));

const fetchMock = vi.mocked(fetchWithAuth);

const makeJsonResponse = (payload: unknown, ok = true, status = ok ? 200 : 500): Response =>
  ({
    ok,
    status,
    statusText: ok ? 'OK' : 'ERROR',
    json: vi.fn().mockResolvedValue(payload),
  }) as unknown as Response;

describe('PatchComplianceView', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('resolves pending patch ids before queuing bulk install', async () => {
    fetchMock.mockImplementation(async (input) => {
      const url = String(input);
      if (url === '/patches/compliance') {
        return makeJsonResponse({
          data: {
            summary: { total: 3, pending: 2, installed: 1, failed: 0, missing: 0 },
            compliancePercent: 50,
            totalDevices: 1,
            compliantDevices: 0,
            criticalSummary: { total: 1, patched: 0, pending: 1 },
            importantSummary: { total: 1, patched: 0, pending: 1 },
            devicesNeedingPatches: [
              {
                id: '11111111-1111-1111-1111-111111111111',
                name: 'Workstation-1',
                os: 'windows',
                missingCount: 2,
                criticalCount: 1,
                importantCount: 1,
                osMissing: 2,
                thirdPartyMissing: 0,
                pendingReboot: false,
                lastSeen: '2026-04-01T18:00:00.000Z',
              },
            ],
          },
        });
      }

      if (url === '/devices?limit=200') {
        return makeJsonResponse({
          devices: [
            {
              id: '11111111-1111-1111-1111-111111111111',
              hostname: 'Workstation-1',
              osType: 'windows',
              lastSeenAt: '2026-04-01T18:00:00.000Z',
            },
          ],
        });
      }

      if (url === '/devices/11111111-1111-1111-1111-111111111111/patches') {
        return makeJsonResponse({
          data: {
            pending: [
              { id: '22222222-2222-2222-2222-222222222222', title: 'KB5050001' },
              { id: '33333333-3333-3333-3333-333333333333', title: 'KB5050002' },
            ],
          },
        });
      }

      if (url === '/devices/11111111-1111-1111-1111-111111111111/patches/install') {
        return makeJsonResponse({
          success: true,
          commandId: 'cmd-install-1',
          commandStatus: 'sent',
          patchCount: 2,
        });
      }

      return makeJsonResponse({}, false, 404);
    });

    render(<PatchComplianceView ringId={null} />);

    await screen.findByText('Workstation-1');

    fireEvent.click(screen.getByRole('button', { name: 'Select Workstation-1' }));
    fireEvent.click(screen.getByRole('button', { name: /Install \(1\)/i }));
    fireEvent.click(screen.getByRole('button', { name: 'Confirm' }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        '/devices/11111111-1111-1111-1111-111111111111/patches/install',
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({
            patchIds: [
              '22222222-2222-2222-2222-222222222222',
              '33333333-3333-3333-3333-333333333333',
            ],
          }),
        })
      );
    });

    expect(await screen.findByText('Patch install queued on 1 device')).toBeTruthy();
  });
});
