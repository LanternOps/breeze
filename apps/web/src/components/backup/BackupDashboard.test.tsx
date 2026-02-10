import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import BackupDashboard from './BackupDashboard';
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

describe('BackupDashboard usage history chart', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders provider usage timeline from API history payload', async () => {
    fetchWithAuthMock.mockImplementation(async (input) => {
      const url = String(input);

      if (url === '/backup/dashboard') {
        return makeJsonResponse({
          data: {
            stats: [{ id: 'storage_used', name: 'Storage Used', value: '1.5 TB', change: '+4.2%' }],
            recentJobs: [
              {
                id: 'job-1',
                device: 'edge-01',
                config: 'Primary S3',
                status: 'completed',
                started: '10m ago',
                duration: '2m',
                size: '1.2 GB'
              }
            ],
            storageProviders: [
              { id: 's3', name: 'S3', used: '1.2 TB', total: '2 TB', percent: 60 },
              { id: 'local', name: 'Local', used: '300 GB', total: '1 TB', percent: 30 }
            ],
            attentionItems: []
          }
        });
      }

      if (url === '/backup/usage-history?days=14') {
        return makeJsonResponse({
          data: {
            points: [
              {
                timestamp: '2026-02-01T00:00:00.000Z',
                totalBytes: 1000,
                providers: [
                  { provider: 's3', bytes: 700 },
                  { provider: 'local', bytes: 300 }
                ]
              },
              {
                timestamp: '2026-02-02T00:00:00.000Z',
                totalBytes: 2000,
                providers: [
                  { provider: 's3', bytes: 1300 },
                  { provider: 'local', bytes: 700 }
                ]
              }
            ]
          }
        });
      }

      return makeJsonResponse({}, false, 404);
    });

    render(<BackupDashboard />);

    await screen.findByText('Storage by Provider');
    expect(await screen.findByLabelText('Provider usage history chart')).not.toBeNull();
    expect(screen.queryByText('Chart placeholder: integrate provider usage history.')).toBeNull();
  });
});
