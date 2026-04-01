import type { ReactNode } from 'react';
import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import DRExecutionView from './DRExecutionView';
import { fetchWithAuth } from '../../stores/auth';

vi.mock('../../stores/auth', () => ({
  fetchWithAuth: vi.fn(),
}));

vi.mock('../shared/Dialog', () => ({
  Dialog: ({ open, children }: { open: boolean; children: ReactNode }) => (open ? <div>{children}</div> : null),
}));

vi.mock('../shared/ConfirmDialog', () => ({
  ConfirmDialog: () => null,
}));

const fetchMock = vi.mocked(fetchWithAuth);

const makeJsonResponse = (payload: unknown, ok = true, status = ok ? 200 : 500): Response =>
  ({
    ok,
    status,
    statusText: ok ? 'OK' : 'ERROR',
    json: vi.fn().mockResolvedValue(payload),
  }) as unknown as Response;

describe('DRExecutionView', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders halt reason and per-device failure detail', async () => {
    fetchMock.mockImplementation(async (input) => {
      const url = String(input);
      if (url === '/dr/executions/execution-1') {
        return makeJsonResponse({
          data: {
            id: 'execution-1',
            executionType: 'failover',
            status: 'failed',
            startedAt: '2026-03-31T10:00:00.000Z',
            completedAt: '2026-03-31T10:10:00.000Z',
            initiatedBy: 'user-1',
            createdAt: '2026-03-31T10:00:00.000Z',
            plan: { id: 'plan-1', name: 'Primary Site Failover' },
            groups: [
              { id: 'group-1', name: 'Tier 1', sequence: 0, devices: ['device-1'], estimatedDurationMinutes: 10 },
            ],
            results: {
              haltReason: 'Group Tier 1 failed',
              groupResults: [
                {
                  groupId: 'group-1',
                  status: 'failed',
                  devices: [{ deviceId: 'device-1', status: 'failed', error: 'VM restore target is offline' }],
                },
              ],
            },
          },
        });
      }
      if (url === '/devices?limit=500') {
        return makeJsonResponse({ data: [{ id: 'device-1', hostname: 'srv-01' }] });
      }
      return makeJsonResponse({}, false, 404);
    });

    render(<DRExecutionView open executionId="execution-1" onClose={() => {}} />);

    expect(await screen.findByText('Group Tier 1 failed')).toBeTruthy();
    expect(screen.getByText('VM restore target is offline')).toBeTruthy();
    expect(screen.getByText('srv-01')).toBeTruthy();
  });
});
