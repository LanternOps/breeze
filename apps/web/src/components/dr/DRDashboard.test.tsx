import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import DRDashboard from './DRDashboard';
import { fetchWithAuth } from '../../stores/auth';

// Org scope, so the fleet-view gate stays open and the data paths under test run.
vi.mock('@/hooks/useOrgScope', () => ({
  useOrgScope: () => ({ ready: true, status: 'resolved', scope: 'org', orgId: 'org-1', org: null, error: null }),
  getOrgScope: () => ({ ready: true, status: 'resolved', scope: 'org', orgId: 'org-1', org: null, error: null }),
}));
vi.mock('../../stores/auth', () => ({
  registerOrgIdProvider: vi.fn(),
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

  it('formats the plan table Updated column with the app long date format, not a raw US locale string (#6496)', async () => {
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
              createdAt: '2026-09-20T20:15:17.000Z',
              updatedAt: '2026-09-20T20:15:17.000Z',
            },
          ],
        });
      }
      if (url === '/dr/plans/plan-1') {
        return makeJsonResponse({ data: { groups: [] } });
      }
      if (url === '/dr/executions?limit=100') {
        return makeJsonResponse({ data: [] });
      }
      return makeJsonResponse({}, false, 404);
    });

    render(<DRDashboard />);
    await screen.findByText('Primary Site Failover');

    // Assert the shape, not an exact calendar day: `formatDateTime` renders
    // in the test runner's local timezone, so a UTC timestamp near a day
    // boundary can land on Sep 20 or Sep 21 depending on the runner/shard.
    expect(screen.queryByText(/\d{1,2}\/\d{1,2}\/2026/)).toBeNull();
    expect(screen.getByText(/^[A-Z][a-z]{2} \d{1,2}, 2026,/)).toBeTruthy();
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

// #6382: executing a plan is the highest-stakes button on this page. A refusal
// used to render the server's machine token verbatim ("resource_not_found"),
// which named neither the missing prerequisite nor the remedy.
describe('DRDashboard execute failure copy (#6382)', () => {
  const planRow = {
    id: 'plan-1',
    name: 'Primary Site Failover',
    description: null,
    status: 'active',
    rpoTargetMinutes: 15,
    rtoTargetMinutes: 60,
    createdAt: '2026-03-29T00:00:00.000Z',
    updatedAt: '2026-03-29T00:00:00.000Z',
  };

  const mockExecuteFailure = (body: unknown, status: number) => {
    fetchMock.mockImplementation(async (input, init) => {
      const url = String(input);
      const method = (init as RequestInit | undefined)?.method ?? 'GET';
      if (url === '/dr/plans') return makeJsonResponse({ data: [planRow] });
      if (url === '/dr/plans/plan-1' && method === 'GET') return makeJsonResponse({ data: { groups: [] } });
      if (url === '/dr/executions?limit=100') return makeJsonResponse({ data: [] });
      if (url === '/dr/plans/plan-1/execute') return makeJsonResponse(body, false, status);
      return makeJsonResponse({}, false, 404);
    });
  };

  const startExecution = async () => {
    render(<DRDashboard />);
    fireEvent.click((await screen.findByText('Execute')).closest('button')!);
    fireEvent.click(await screen.findByRole('button', { name: /Start Execution/i }));
  };

  beforeEach(() => {
    vi.clearAllMocks();
    window.location.hash = '';
  });

  it('explains a missing restorable snapshot instead of echoing the token', async () => {
    mockExecuteFailure({ error: 'no_restorable_snapshot' }, 404);
    await startExecution();

    expect(
      await screen.findByText(/no restorable backup snapshot/i)
    ).toBeInTheDocument();
    expect(screen.queryByText('no_restorable_snapshot')).toBeNull();
  });

  it('explains a missing backup:write permission instead of echoing the token', async () => {
    mockExecuteFailure({ error: 'backup_write_required' }, 403);
    await startExecution();

    expect(await screen.findByText(/backup write permission/i)).toBeInTheDocument();
    expect(screen.queryByText('backup_write_required')).toBeNull();
  });
});
