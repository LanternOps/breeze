import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import BackupVerificationTab from './BackupVerificationTab';
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

const deviceId = '11111111-1111-1111-1111-111111111111';

const mockVerifications = [
  {
    id: 'v-1',
    deviceId,
    verificationType: 'integrity',
    status: 'passed',
    startedAt: '2026-03-27T10:00:00Z',
    completedAt: '2026-03-27T10:00:05Z',
    filesVerified: 42,
    filesFailed: 0,
    sizeBytes: 1048576,
  },
];

const mockReadiness = {
  data: {
    devices: [
      {
        deviceId,
        readinessScore: 88,
        estimatedRtoMinutes: 15,
        estimatedRpoMinutes: 60,
        riskFactors: [],
      },
    ],
  },
};

describe('BackupVerificationTab', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fetchMock.mockImplementation(async (input) => {
      const url = String(input);
      if (url.includes('/backup/verifications')) {
        return makeJsonResponse({ data: mockVerifications });
      }
      if (url.includes('/backup/recovery-readiness')) {
        return makeJsonResponse(mockReadiness);
      }
      if (url.includes('/backup/verify')) {
        return makeJsonResponse(
          { data: { verification: mockVerifications[0], readiness: null } },
          true,
          201
        );
      }
      return makeJsonResponse({});
    });
  });

  it('renders readiness score and verification history', async () => {
    render(<BackupVerificationTab deviceId={deviceId} />);

    await screen.findByText('88');
    await screen.findByText('Passed');
    await screen.findByText('42');
  });

  it('shows loading state initially', () => {
    render(<BackupVerificationTab deviceId={deviceId} />);
    expect(screen.getByText('Loading verification data...')).toBeTruthy();
  });

  it('triggers integrity check on button click', async () => {
    render(<BackupVerificationTab deviceId={deviceId} />);

    await screen.findByText('88');
    fireEvent.click(screen.getByRole('button', { name: /integrity check/i }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        '/backup/verify',
        expect.objectContaining({ method: 'POST' })
      );
    });
  });

  it('renders empty state when no verifications exist', async () => {
    fetchMock.mockImplementation(async (input) => {
      const url = String(input);
      if (url.includes('/backup/verifications')) {
        return makeJsonResponse({ data: [] });
      }
      if (url.includes('/backup/recovery-readiness')) {
        return makeJsonResponse({ data: { devices: [] } });
      }
      return makeJsonResponse({});
    });

    render(<BackupVerificationTab deviceId={deviceId} />);
    expect(
      await screen.findAllByText('No verification history. Run a verification to check backup integrity.')
    ).toHaveLength(2);
  });

  it('disables verification actions and shows an offline message when the device is offline', async () => {
    render(<BackupVerificationTab deviceId={deviceId} deviceStatus="offline" />);

    await screen.findByText('Device is offline. Verification requires a connected agent.');
    expect(screen.getByRole('button', { name: /integrity check/i }).hasAttribute('disabled')).toBe(true);
    expect(screen.getByRole('button', { name: /test restore/i }).hasAttribute('disabled')).toBe(true);
  });

  it('shows an explicit dispatch failure message and keeps retry actions available', async () => {
    fetchMock.mockImplementation(async (input, init) => {
      const url = String(input);
      if (url.includes('/backup/verifications')) {
        return makeJsonResponse({ data: mockVerifications });
      }
      if (url.includes('/backup/recovery-readiness')) {
        return makeJsonResponse(mockReadiness);
      }
      if (url.includes('/backup/verify')) {
        return makeJsonResponse({ error: 'Queue unavailable' }, false, 502);
      }
      return makeJsonResponse({});
    });

    render(<BackupVerificationTab deviceId={deviceId} deviceStatus="online" />);

    await screen.findByText('88');
    fireEvent.click(screen.getByRole('button', { name: /integrity check/i }));

    await screen.findByText('Verification could not be started: Queue unavailable');
    expect(screen.getByRole('button', { name: /integrity check/i }).hasAttribute('disabled')).toBe(false);
  });
});
