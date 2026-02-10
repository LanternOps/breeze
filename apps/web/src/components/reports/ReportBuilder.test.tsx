import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import ReportBuilder from './ReportBuilder';
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

describe('ReportBuilder live preview', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders live table rows from report API data', async () => {
    fetchWithAuthMock.mockResolvedValueOnce(
      makeJsonResponse({
        data: {
          rows: [
            {
              hostname: 'api-atlas-01',
              osType: 'windows',
              osVersion: '11',
              status: 'online',
              lastSeenAt: '2026-02-09T16:22:00.000Z'
            }
          ]
        }
      })
    );

    render(<ReportBuilder mode="builder" />);

    await screen.findByText('api-atlas-01');
    expect(screen.queryByText('atlas-01')).toBeNull();
  });

  it('groups live API rows when group-by is selected', async () => {
    fetchWithAuthMock.mockResolvedValueOnce(
      makeJsonResponse({
        data: {
          rows: [
            { hostname: 'a-1', status: 'online', osType: 'windows', osVersion: '11' },
            { hostname: 'a-2', status: 'online', osType: 'windows', osVersion: '11' },
            { hostname: 'a-3', status: 'offline', osType: 'macos', osVersion: '14' }
          ]
        }
      })
    );

    render(<ReportBuilder mode="builder" />);

    await screen.findByText('a-1');

    fireEvent.change(screen.getByDisplayValue('No grouping'), {
      target: { value: 'status' }
    });

    await waitFor(() => {
      expect(screen.getAllByText('Count').length).toBeGreaterThan(0);
    });
    expect(screen.queryByText('online')).not.toBeNull();
  });

  it('renders chart series from live summary payload', async () => {
    fetchWithAuthMock.mockImplementation(async (_url, init) => {
      const body = init?.body ? JSON.parse(String(init.body)) as { type?: string } : {};

      if (body.type === 'alert_summary') {
        return makeJsonResponse({
          data: {
            rows: [{ severity: 'critical', status: 'open', title: 'CPU spike' }],
            summary: { urgentSpike: 7, triageBacklog: 2 }
          }
        });
      }

      return makeJsonResponse({
        data: {
          rows: [{ hostname: 'seed-device', status: 'online', osType: 'windows', osVersion: '11' }]
        }
      });
    });

    render(<ReportBuilder mode="builder" />);

    await screen.findByText('seed-device');

    fireEvent.click(screen.getByRole('button', { name: /alerts/i }));
    fireEvent.click(screen.getByRole('button', { name: /^bar$/i }));

    await waitFor(() => {
      expect(screen.queryByText('Urgent Spike')).not.toBeNull();
    });
    expect(screen.queryByText('Triage Backlog')).not.toBeNull();
  });
});
