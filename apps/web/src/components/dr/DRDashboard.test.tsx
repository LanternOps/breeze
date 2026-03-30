import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import DRDashboard from './DRDashboard';
import { fetchWithAuth } from '../../stores/auth';

vi.mock('../../stores/auth', () => ({
  fetchWithAuth: vi.fn(),
}));

vi.mock('./DRPlanEditor', () => ({
  default: ({ open }: { open: boolean }) => (open ? <div>DR Plan Editor</div> : null),
}));

vi.mock('./DRExecutionView', () => ({
  default: ({ open }: { open: boolean }) => (open ? <div>DR Execution View</div> : null),
}));

vi.mock('../shared/Dialog', () => ({
  Dialog: ({ open, children }: { open: boolean; children: any }) => (open ? <div>{children}</div> : null),
}));

const fetchMock = vi.mocked(fetchWithAuth);

const makeJsonResponse = (payload: unknown, ok = true, status = ok ? 200 : 500): Response =>
  ({
    ok,
    status,
    statusText: ok ? 'OK' : 'ERROR',
    json: vi.fn().mockResolvedValue(payload),
  }) as unknown as Response;

describe('DRDashboard', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.location.hash = '';
    fetchMock.mockImplementation(async (input) => {
      const url = String(input);
      if (url === '/dr/plans' || url === '/dr/executions?limit=100') {
        return makeJsonResponse({ data: [] });
      }
      return makeJsonResponse({}, false, 404);
    });
  });

  it('renders the alpha banner, Create Plan button, and empty plans table', async () => {
    render(<DRDashboard />);

    await screen.findByText('Disaster Recovery');
    expect(screen.getByText(/Disaster Recovery orchestration is in early access/i)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Create Plan' })).toBeTruthy();
    expect(
      await screen.findByText(
        'No recovery plans yet. Create a plan to define staged restore order and objectives.'
      )
    ).toBeTruthy();
  });

  it('renders two tabs and switches to the executions view', async () => {
    render(<DRDashboard />);

    await screen.findByText(/No recovery plans yet/i);
    expect(screen.getByRole('button', { name: 'Plans' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Executions' })).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Executions' }));

    await screen.findByText('No DR executions have been launched yet.');
  });

  it('renders plan rows when data exists', async () => {
    fetchMock.mockImplementation(async (input) => {
      const url = String(input);
      if (url === '/dr/plans') {
        return makeJsonResponse({
          data: [
            {
              id: 'plan-1',
              name: 'Primary Site Failover',
              description: 'Recover critical workloads',
              status: 'active',
              rpoTargetMinutes: 15,
              rtoTargetMinutes: 60,
              createdAt: '2026-03-29T00:00:00.000Z',
              updatedAt: '2026-03-29T00:00:00.000Z',
            },
          ],
        });
      }
      if (url === '/dr/plans/plan-1') {
        return makeJsonResponse({
          data: { groups: [{ id: 'g-1', name: 'Tier 1', sequence: 1 }] },
        });
      }
      if (url === '/dr/executions?limit=100') {
        return makeJsonResponse({ data: [] });
      }
      return makeJsonResponse({}, false, 404);
    });

    render(<DRDashboard />);

    expect(await screen.findByText('Primary Site Failover')).toBeTruthy();
  });

  it('shows error state on fetch failure', async () => {
    fetchMock.mockImplementation(async (input) => {
      const url = String(input);
      if (url === '/dr/plans') {
        return makeJsonResponse({}, false, 500);
      }
      if (url === '/dr/executions?limit=100') {
        return makeJsonResponse({ data: [] });
      }
      return makeJsonResponse({}, false, 404);
    });

    render(<DRDashboard />);

    expect(await screen.findByText(/Failed to load/i)).toBeTruthy();
  });

  it('opens the create plan flow when the button is clicked', async () => {
    render(<DRDashboard />);

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Create Plan' })).toBeTruthy();
    });

    fireEvent.click(screen.getByRole('button', { name: 'Create Plan' }));

    expect(screen.getByText('DR Plan Editor')).toBeTruthy();
  });
});
