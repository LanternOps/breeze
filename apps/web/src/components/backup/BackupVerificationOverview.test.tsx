import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import BackupVerificationOverview from './BackupVerificationOverview';
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

describe('BackupVerificationOverview', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fetchMock.mockImplementation(async (input) => {
      const url = String(input);
      if (url.includes('/backup/health')) {
        return makeJsonResponse({
          data: {
            verification: {
              total: 8,
              failedLast24h: 1,
            },
            readiness: {
              averageScore: 82.5,
              lowReadinessCount: 1,
            },
            escalations: {
              verificationFailures: 1,
              criticalVerificationFailures: 0,
            },
          },
        });
      }
      if (url.includes('/backup/recovery-readiness')) {
        return makeJsonResponse({
          data: {
            summary: {
              devices: 2,
              averageScore: 82.5,
              lowReadiness: 1,
              highReadiness: 1,
            },
            devices: [
              {
                deviceId: 'device-low',
                deviceName: 'Low Device',
                readinessScore: 65,
                estimatedRtoMinutes: 30,
                estimatedRpoMinutes: 60,
                riskFactors: [{ code: 'stale_verification', severity: 'high', message: 'Old verification' }],
              },
              {
                deviceId: 'device-high',
                deviceName: 'High Device',
                readinessScore: 91,
                estimatedRtoMinutes: 10,
                estimatedRpoMinutes: 15,
                riskFactors: [],
              },
            ],
          },
        });
      }
      if (url.includes('/backup/verifications')) {
        return makeJsonResponse({
          data: [
            {
              id: 'verify-real',
              deviceId: 'device-low',
              deviceName: 'Low Device',
              verificationType: 'integrity',
              status: 'failed',
              startedAt: '2026-04-01T00:00:00Z',
              filesVerified: 10,
              filesFailed: 2,
              details: { simulated: false, reason: 'Snapshot manifest missing' },
            },
            {
              id: 'verify-simulated',
              deviceId: 'device-high',
              deviceName: 'High Device',
              verificationType: 'test_restore',
              status: 'failed',
              startedAt: '2026-04-01T01:00:00Z',
              filesVerified: 0,
              filesFailed: 1,
              details: { simulated: true },
            },
          ],
        });
      }
      return makeJsonResponse({}, false, 404);
    });
  });

  it('renders the nested health and readiness payloads correctly', async () => {
    render(<BackupVerificationOverview />);

    await screen.findByText('82.5');
    expect(screen.getAllByText('Low Device').length).toBeGreaterThan(0);
    expect(screen.getByText('Devices scoring below the 85-point readiness threshold.')).toBeTruthy();
    expect(screen.queryByText('High Device')).toBeNull();
    expect(screen.getByText('Failed verification checks across all devices.')).toBeTruthy();
  });

  it('shows why a verification failed (#7213)', async () => {
    render(<BackupVerificationOverview />);
    expect(await screen.findByText('Snapshot manifest missing')).toBeTruthy();
  });

  it('does not show "0 / 100" or "all devices meet the threshold" when no device has been scored (#7213)', async () => {
    const base = fetchMock.getMockImplementation()!;
    fetchMock.mockImplementation(async (input, init) => {
      if (String(input).includes('/backup/recovery-readiness')) {
        return makeJsonResponse({ data: { summary: { devices: 0, averageScore: 0, lowReadiness: 0, highReadiness: 0 }, devices: [] } });
      }
      if (String(input).includes('/backup/health')) {
        return makeJsonResponse({ data: { verification: { total: 0, failedLast24h: 0 }, readiness: { averageScore: 0, lowReadinessCount: 0 } } });
      }
      return base(input, init);
    });
    render(<BackupVerificationOverview />);
    expect(await screen.findByText('No devices have a readiness score yet.')).toBeTruthy();
    expect(screen.queryByText('All devices meet the readiness threshold.')).toBeNull();
    expect(screen.queryByText('/ 100')).toBeNull();
  });
});
