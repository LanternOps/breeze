import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../stores/auth', () => ({ fetchWithAuth: vi.fn() }));

// Pin the org-scope selectors so the page doesn't try to read a real store —
// same pattern as AlertsPage.test.tsx. Defaults to a single org selected
// (not fleet view); a test flips both to exercise the Organization column.
let mockCurrentOrgId: string | null = 'org-1';
let mockAllOrgs = false;
vi.mock('../../stores/orgStore', () => ({
  useOrgStore: (selector: (s: { currentOrgId: string | null; allOrgs: boolean }) => unknown) =>
    selector({ currentOrgId: mockCurrentOrgId, allOrgs: mockAllOrgs }),
}));

import RunsListPage from './RunsListPage';
import { fetchWithAuth } from '../../stores/auth';

const fetchMock = vi.mocked(fetchWithAuth);

const json = (payload: unknown, ok = true, status = 200): Response =>
  ({ ok, status, statusText: 'OK', json: vi.fn().mockResolvedValue(payload) }) as unknown as Response;

const RUN_1 = {
  schemaVersion: 1 as const,
  id: 'run-1',
  agentId: 'a1',
  agentName: 'Triage',
  orgId: 'org-1',
  orgName: 'Acme Corp',
  deviceId: 'd1',
  status: 'completed' as const,
  triggerKind: 'alert' as const,
  runVerdict: 'remediated' as const,
  queuedAt: '2026-08-20T10:00:00.000Z',
  finishedAt: '2026-08-20T10:05:00.000Z',
  costCents: 42,
};

const RUN_2 = {
  schemaVersion: 1 as const,
  id: 'run-2',
  agentId: 'a1',
  agentName: 'Triage',
  orgId: 'org-1',
  orgName: 'Acme Corp',
  deviceId: null,
  status: 'failed' as const,
  triggerKind: 'manual' as const,
  runVerdict: null,
  queuedAt: '2026-08-19T10:00:00.000Z',
  finishedAt: null,
  costCents: 0,
};

function mockEndpoints(opts: {
  runs?: unknown[];
  nextCursor?: string | null;
  agents?: unknown[];
  runsOk?: boolean;
  runsStatus?: number;
} = {}) {
  const {
    runs = [RUN_1, RUN_2],
    nextCursor = null,
    agents = [{ id: 'a1', name: 'Triage', kind: 'triage' }],
    runsOk = true,
    runsStatus = 200,
  } = opts;
  fetchMock.mockImplementation((url: string) => {
    if (url.startsWith('/ai/agents/runs')) {
      return Promise.resolve(json({ data: runs, nextCursor }, runsOk, runsStatus));
    }
    if (url.startsWith('/ai/agents')) {
      return Promise.resolve(json({ data: agents }));
    }
    return Promise.resolve(json({ data: [] }));
  });
}

beforeEach(() => {
  fetchMock.mockReset();
  mockCurrentOrgId = 'org-1';
  mockAllOrgs = false;
});

describe('RunsListPage', () => {
  it('loads and renders the runs list', async () => {
    mockEndpoints();
    render(<RunsListPage />);

    await waitFor(() => expect(screen.getByTestId('runs-list-row-run-1')).toBeInTheDocument());
    expect(screen.getByTestId('runs-list-row-run-2')).toBeInTheDocument();
  });

  it('renders a translated trigger label for an anomaly-triggered run (wave 6 PR 4, #3828)', async () => {
    mockEndpoints({ runs: [{ ...RUN_1, id: 'run-3', triggerKind: 'anomaly' as const }] });
    render(<RunsListPage />);

    await waitFor(() => expect(screen.getByTestId('runs-list-row-run-3')).toBeInTheDocument());
    expect(screen.getByTestId('runs-list-row-run-3')).toHaveTextContent('Anomaly');
  });

  it('shows an error state when the list fails to load', async () => {
    mockEndpoints({ runsOk: false, runsStatus: 500 });
    render(<RunsListPage />);

    await waitFor(() => expect(screen.getByTestId('runs-list-error')).toBeInTheDocument());
  });

  it('shows the empty state when there are no runs', async () => {
    mockEndpoints({ runs: [] });
    render(<RunsListPage />);

    await waitFor(() => expect(screen.getByTestId('runs-list-empty')).toBeInTheDocument());
  });

  it('shows a Load more button when a nextCursor is returned, and appends on click', async () => {
    mockEndpoints({ runs: [RUN_1], nextCursor: 'cursor-a' });
    render(<RunsListPage />);

    await waitFor(() => expect(screen.getByTestId('runs-list-row-run-1')).toBeInTheDocument());
    const loadMore = screen.getByTestId('runs-list-load-more');
    expect(loadMore).toBeInTheDocument();

    // Next page: no further cursor, and returns run-2 so we can see it appended
    // rather than replacing run-1.
    fetchMock.mockImplementation((url: string) => {
      if (url.startsWith('/ai/agents/runs')) {
        expect(url).toContain('cursor=cursor-a');
        return Promise.resolve(json({ data: [RUN_2], nextCursor: null }));
      }
      return Promise.resolve(json({ data: [] }));
    });
    fireEvent.click(loadMore);

    await waitFor(() => expect(screen.getByTestId('runs-list-row-run-2')).toBeInTheDocument());
    // The first page's row must still be present — append, not replace.
    expect(screen.getByTestId('runs-list-row-run-1')).toBeInTheDocument();
    expect(screen.queryByTestId('runs-list-load-more')).not.toBeInTheDocument();
  });

  it('refetches page 1 with the status filter applied when changed', async () => {
    mockEndpoints();
    render(<RunsListPage />);

    await waitFor(() => expect(screen.getByTestId('runs-list-row-run-1')).toBeInTheDocument());

    fetchMock.mockImplementation((url: string) => {
      if (url.startsWith('/ai/agents/runs')) {
        expect(url).toContain('status=failed');
        return Promise.resolve(json({ data: [RUN_2], nextCursor: null }));
      }
      return Promise.resolve(json({ data: [] }));
    });
    fireEvent.change(screen.getByTestId('runs-list-filter-status'), { target: { value: 'failed' } });

    await waitFor(() => expect(screen.getByTestId('runs-list-row-run-2')).toBeInTheDocument());
    expect(screen.queryByTestId('runs-list-row-run-1')).not.toBeInTheDocument();
  });

  it('links each row to its run detail page', async () => {
    mockEndpoints();
    render(<RunsListPage />);

    await waitFor(() => expect(screen.getByTestId('runs-list-row-run-1')).toBeInTheDocument());
    const link = screen.getByTestId('runs-list-row-link-run-1');
    expect(link).toHaveAttribute('href', '/ai-agents/runs/run-1');
  });

  // Review fix (#3828): the route is registered `org-or-all` in
  // routeScope.ts, whose contract requires an Organization column in
  // All-organizations view — mirrors AlertsPage/AlertList's showOrgColumn.
  it('shows an Organization column with each row\'s orgName in All-organizations (fleet) view', async () => {
    mockCurrentOrgId = null;
    mockAllOrgs = true;
    mockEndpoints();
    render(<RunsListPage />);

    await waitFor(() => expect(screen.getByTestId('runs-list-row-run-1')).toBeInTheDocument());
    expect(screen.getByRole('columnheader', { name: 'Organization' })).toBeInTheDocument();
    expect(screen.getAllByText('Acme Corp')).toHaveLength(2);
  });

  it('hides the Organization column when a single org is selected', async () => {
    mockEndpoints();
    render(<RunsListPage />);

    await waitFor(() => expect(screen.getByTestId('runs-list-row-run-1')).toBeInTheDocument());
    expect(screen.queryByText('Acme Corp')).not.toBeInTheDocument();
  });
});
