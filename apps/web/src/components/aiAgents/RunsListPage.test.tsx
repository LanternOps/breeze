import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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
  profile: 'full' as const,
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
  profile: 'full' as const,
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
  localStorage.clear();
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

  it('shows the empty state when there are no runs, with a description and a link to configure agents', async () => {
    mockEndpoints({ runs: [] });
    render(<RunsListPage />);

    await waitFor(() => expect(screen.getByTestId('runs-list-empty')).toBeInTheDocument());
    expect(screen.getByText('No runs yet.')).toBeInTheDocument();
    expect(screen.getByText(/will appear here/i)).toBeInTheDocument();
    const link = screen.getByText('Configure AI agents');
    expect(link).toHaveAttribute('href', '/settings/ai-agents');
  });

  it('shows a Clear filters action in the filtered-empty state instead of the settings link', async () => {
    mockEndpoints({ runs: [] });
    render(<RunsListPage />);
    await waitFor(() => expect(screen.getByTestId('runs-list-empty')).toBeInTheDocument());

    fireEvent.change(screen.getByTestId('runs-list-filter-status'), { target: { value: 'failed' } });
    await waitFor(() => expect(screen.getByText('No runs match these filters.')).toBeInTheDocument());
    expect(screen.queryByText('Configure AI agents')).not.toBeInTheDocument();
    expect(screen.getAllByText('Clear filters').length).toBeGreaterThan(0);
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

  // Review finding #2: the column was mislabeled "Target" while its cell
  // renders `orgName` — the list DTO carries no device hostname to target,
  // only the organization — so the header reverts to "Organization"
  // (`common:labels.organization`), always visible in fleet view or not.
  it('shows an Organization column with each row\'s orgName, in fleet view or not', async () => {
    mockCurrentOrgId = null;
    mockAllOrgs = true;
    mockEndpoints();
    render(<RunsListPage />);

    await waitFor(() => expect(screen.getByTestId('runs-list-row-run-1')).toBeInTheDocument());
    expect(screen.getByRole('columnheader', { name: 'Organization' })).toBeInTheDocument();
    expect(screen.getAllByText('Acme Corp')).toHaveLength(2);
  });

  // Phase 2 wave P2-2 (#4189, Task 14) — a sweep-profile run is a fleet-wide
  // scheduled read, not a device incident, so it reads very differently from
  // the alert/anomaly runs beside it in the list.
  it('badges a sweep-profile run beside its verdict', async () => {
    mockEndpoints({ runs: [{ ...RUN_1, id: 'run-9', profile: 'sweep' as const }] });
    render(<RunsListPage />);

    await waitFor(() => expect(screen.getByTestId('runs-list-row-run-9')).toBeInTheDocument());
    expect(screen.getByTestId('ai-agent-run-profile-sweep-run-9')).toHaveTextContent('Sweep');
  });

  it('omits the sweep badge for every other run profile', async () => {
    mockEndpoints({ runs: [{ ...RUN_1, id: 'run-8', profile: 'verdict' as const }, RUN_2] });
    render(<RunsListPage />);

    await waitFor(() => expect(screen.getByTestId('runs-list-row-run-8')).toBeInTheDocument());
    expect(screen.queryByTestId('ai-agent-run-profile-sweep-run-8')).not.toBeInTheDocument();
    expect(screen.queryByTestId('ai-agent-run-profile-sweep-run-2')).not.toBeInTheDocument();
  });

  // Phase 2 wave P2-3 (#4190) — a narrative-profile run is the weekly org
  // report, not a device outcome; the badge is what tells the two apart.
  it('badges a narrative-profile run beside its verdict', async () => {
    mockEndpoints({ runs: [{ ...RUN_1, id: 'run-7', profile: 'narrative' as const }] });
    render(<RunsListPage />);

    await waitFor(() => expect(screen.getByTestId('runs-list-table')).toBeInTheDocument());
    expect(screen.getByTestId('ai-agent-run-profile-narrative-run-7')).toHaveTextContent('Weekly report');
    // The two profile badges are mutually exclusive.
    expect(screen.queryByTestId('ai-agent-run-profile-sweep-run-7')).not.toBeInTheDocument();
  });

  it('omits the narrative badge for every other run profile', async () => {
    mockEndpoints({ runs: [{ ...RUN_1, id: 'run-6', profile: 'sweep' as const }, RUN_2] });
    render(<RunsListPage />);

    await waitFor(() => expect(screen.getByTestId('runs-list-table')).toBeInTheDocument());
    expect(screen.queryByTestId('ai-agent-run-profile-narrative-run-6')).not.toBeInTheDocument();
    expect(screen.queryByTestId('ai-agent-run-profile-narrative-run-2')).not.toBeInTheDocument();
  });

  // P2-4 (#4191, Task 12) — a triage-profile run is a ticket outcome, not a
  // device incident; the badge is what tells the two apart in a mixed list,
  // same as the sweep/narrative badges above.
  it('badges a triage-profile run beside its verdict', async () => {
    mockEndpoints({ runs: [{ ...RUN_1, id: 'run-5', profile: 'triage' as const }] });
    render(<RunsListPage />);

    await waitFor(() => expect(screen.getByTestId('runs-list-table')).toBeInTheDocument());
    expect(screen.getByTestId('ai-agent-run-profile-triage-run-5')).toBeInTheDocument();
    // The three profile badges are mutually exclusive.
    expect(screen.queryByTestId('ai-agent-run-profile-sweep-run-5')).not.toBeInTheDocument();
    expect(screen.queryByTestId('ai-agent-run-profile-narrative-run-5')).not.toBeInTheDocument();
  });

  it('omits the triage badge for every other run profile', async () => {
    mockEndpoints({ runs: [{ ...RUN_1, id: 'run-4', profile: 'sweep' as const }, RUN_2] });
    render(<RunsListPage />);

    await waitFor(() => expect(screen.getByTestId('runs-list-table')).toBeInTheDocument());
    expect(screen.queryByTestId('ai-agent-run-profile-triage-run-4')).not.toBeInTheDocument();
    expect(screen.queryByTestId('ai-agent-run-profile-triage-run-2')).not.toBeInTheDocument();
  });

  // Review finding #2: Organization is not fleet-view-only.
  it('shows the Organization column even when a single org is selected', async () => {
    mockEndpoints();
    render(<RunsListPage />);

    await waitFor(() => expect(screen.getByTestId('runs-list-row-run-1')).toBeInTheDocument());
    expect(screen.getByRole('columnheader', { name: 'Organization' })).toBeInTheDocument();
    expect(screen.getAllByText('Acme Corp').length).toBeGreaterThan(0);
  });
});

// Review finding #1 — columns: Started (relative + absolute), Duration, and
// Cost moved behind a "Show cost" toggle that defaults off and persists.
describe('RunsListPage columns', () => {
  it('renders Started as a visible relative time with the absolute time in dateTime/title/sr-only text', async () => {
    mockEndpoints({ runs: [RUN_1] });
    render(<RunsListPage />);

    await waitFor(() => expect(screen.getByTestId('runs-list-row-run-1')).toBeInTheDocument());
    const time = screen.getByTestId('runs-list-row-run-1').querySelector('time');
    expect(time).not.toBeNull();
    expect(time).toHaveAttribute('dateTime', RUN_1.queuedAt);
    const title = time!.getAttribute('title');
    expect(title).toBeTruthy();
    // Review finding #4: `<time>` maps to the ARIA `generic` role, which
    // PROHIBITS naming — `aria-label` is stripped from the accessibility
    // tree, not merely redundant with `title`. The absolute timestamp must
    // instead be exposed as real text content (an `sr-only` span), which a
    // `generic` element's flattened text still carries to assistive tech.
    expect(time).not.toHaveAttribute('aria-label');
    const srOnly = time!.querySelector('.sr-only');
    expect(srOnly).not.toBeNull();
    expect(srOnly!.textContent).toContain(title);
    // The visible text is relative, not the raw ISO timestamp.
    expect(time!.textContent).not.toBe(RUN_1.queuedAt);
  });

  it('computes Duration from queuedAt to finishedAt for a finished run', async () => {
    const run = { ...RUN_1, queuedAt: '2026-08-20T10:00:00.000Z', finishedAt: '2026-08-20T10:05:12.000Z' };
    mockEndpoints({ runs: [run] });
    render(<RunsListPage />);

    await waitFor(() => expect(screen.getByTestId('runs-list-row-run-1')).toBeInTheDocument());
    expect(screen.getByTestId('runs-list-row-run-1')).toHaveTextContent('5m 12s');
  });

  it('shows a Duration column header even for a run that has not finished', async () => {
    mockEndpoints({ runs: [RUN_2] }); // RUN_2.finishedAt is null.
    render(<RunsListPage />);

    await waitFor(() => expect(screen.getByTestId('runs-list-row-run-2')).toBeInTheDocument());
    expect(screen.getByRole('columnheader', { name: 'Duration' })).toBeInTheDocument();
  });

  it('hides the Cost column by default and reveals it via the Show cost toggle', async () => {
    mockEndpoints({ runs: [RUN_1] });
    render(<RunsListPage />);

    await waitFor(() => expect(screen.getByTestId('runs-list-row-run-1')).toBeInTheDocument());
    expect(screen.queryByRole('columnheader', { name: 'Cost' })).not.toBeInTheDocument();
    expect(screen.getByTestId('runs-list-toggle-cost')).toHaveAttribute('aria-pressed', 'false');

    fireEvent.click(screen.getByTestId('runs-list-toggle-cost'));

    await waitFor(() => expect(screen.getByRole('columnheader', { name: 'Cost' })).toBeInTheDocument());
    expect(screen.getByTestId('runs-list-toggle-cost')).toHaveAttribute('aria-pressed', 'true');
  });

  it('persists the Show cost preference in localStorage across a remount', async () => {
    mockEndpoints({ runs: [RUN_1] });
    const { unmount } = render(<RunsListPage />);
    await waitFor(() => expect(screen.getByTestId('runs-list-row-run-1')).toBeInTheDocument());

    fireEvent.click(screen.getByTestId('runs-list-toggle-cost'));
    await waitFor(() => expect(screen.getByRole('columnheader', { name: 'Cost' })).toBeInTheDocument());
    unmount();

    render(<RunsListPage />);
    await waitFor(() => expect(screen.getByTestId('runs-list-row-run-1')).toBeInTheDocument());
    await waitFor(() => expect(screen.getByRole('columnheader', { name: 'Cost' })).toBeInTheDocument());
  });
});

// Review finding #2 — deep link from the agents list: `?agentId=` (legacy)
// and `#agent=<id>` (repo's hash-for-transient-UI-state convention) both
// pre-select the agent filter; the hash wins when both are present.
describe('RunsListPage agent deep link', () => {
  afterEach(() => {
    window.history.pushState({}, '', '/');
  });

  it('pre-selects the agent filter from the #agent=<id> hash', async () => {
    window.history.pushState({}, '', '/ai-agents/runs#agent=a1');
    mockEndpoints();
    render(<RunsListPage />);

    await waitFor(() => expect(screen.getByTestId('runs-list-filter-agent')).toHaveValue('a1'));
    await waitFor(() => {
      const runsCall = fetchMock.mock.calls.find(([url]) => (url as string).startsWith('/ai/agents/runs'));
      expect(runsCall?.[0]).toContain('agentId=a1');
    });
  });

  it('pre-selects the agent filter from the legacy ?agentId= query param when there is no hash', async () => {
    window.history.pushState({}, '', '/ai-agents/runs?agentId=a1');
    mockEndpoints();
    render(<RunsListPage />);

    await waitFor(() => expect(screen.getByTestId('runs-list-filter-agent')).toHaveValue('a1'));
  });

  it('prefers the #agent hash over the legacy ?agentId= query param when both are present', async () => {
    window.history.pushState({}, '', '/ai-agents/runs?agentId=a2#agent=a1');
    mockEndpoints();
    render(<RunsListPage />);

    await waitFor(() => expect(screen.getByTestId('runs-list-filter-agent')).toHaveValue('a1'));
  });

  it('leaves the agent filter unset when neither the hash nor the query param is present', async () => {
    window.history.pushState({}, '', '/ai-agents/runs');
    mockEndpoints();
    render(<RunsListPage />);

    await waitFor(() => expect(screen.getByTestId('runs-list-row-run-1')).toBeInTheDocument());
    expect(screen.getByTestId('runs-list-filter-agent')).toHaveValue('');
  });

  // Review finding #1: a malformed percent-escape in the hash used to throw
  // inside `decodeURIComponent`, uncaught, inside the mount layout effect —
  // before the gated first fetch ever ran, so the page rendered blank
  // forever. The bad hash must degrade to "no deep link" instead.
  it('does not blank the page when the hash has a malformed percent-escape', async () => {
    window.history.pushState({}, '', '/ai-agents/runs#agent=%');
    mockEndpoints();
    render(<RunsListPage />);

    await waitFor(() => expect(screen.getByTestId('runs-list-row-run-1')).toBeInTheDocument());
    expect(screen.getByTestId('runs-list-filter-agent')).toHaveValue('');
  });

  // Review finding #5: the previous `if (fromUrl !== undefined)` guard meant
  // a `hashchange` that removed the hash (fromUrl becomes undefined) never
  // cleared an already-applied filter. `applyDeepLink` now always sets the
  // filter (falling back to '').
  it('clears the agent filter when the #agent hash is removed', async () => {
    window.history.pushState({}, '', '/ai-agents/runs#agent=a1');
    mockEndpoints();
    render(<RunsListPage />);
    await waitFor(() => expect(screen.getByTestId('runs-list-filter-agent')).toHaveValue('a1'));

    window.history.pushState({}, '', '/ai-agents/runs');
    fireEvent(window, new Event('hashchange'));

    await waitFor(() => expect(screen.getByTestId('runs-list-filter-agent')).toHaveValue(''));
  });
});

// Review finding #3 — a deep-linked agent id that matches nothing in the
// loaded agents list (a stale link, a deleted/renamed agent, or a
// partner-wide agent invisible under this caller's RLS context) used to
// desync the filter: the dropdown fell back to its first option ("All
// agents") while `agentFilter` state still held the unmatched id, so every
// request kept sending an `agentId` the UI no longer visibly reflected.
describe('RunsListPage agent filter desync', () => {
  afterEach(() => {
    window.history.pushState({}, '', '/');
  });

  it('drops a deep-linked agent filter that matches no loaded agent option, and clears the hash', async () => {
    window.history.pushState({}, '', '/ai-agents/runs#agent=ghost-agent');
    mockEndpoints(); // agents: [{ id: 'a1', ... }] — no 'ghost-agent'.
    render(<RunsListPage />);

    // The deep link applies immediately, before the agents list resolves —
    // there is no `<option value="ghost-agent">` yet for the `<select>` to
    // reflect (a mismatched controlled value renders as unselected), so the
    // applied state is observed through the outgoing runs request instead.
    await waitFor(() => {
      const runsCall = fetchMock.mock.calls.find(([url]) => (url as string).startsWith('/ai/agents/runs'));
      expect(runsCall?.[0]).toContain('agentId=ghost-agent');
    });

    // Once the agents list has genuinely loaded, the unmatched filter is
    // dropped and the dropdown falls back to "All agents" for real.
    await waitFor(() => expect(screen.getByTestId('runs-list-filter-agent')).toHaveValue(''));
    expect(window.location.hash).toBe('');
  });

  it('keeps a deep-linked agent filter that DOES match a loaded agent option', async () => {
    window.history.pushState({}, '', '/ai-agents/runs#agent=a1');
    mockEndpoints(); // agents: [{ id: 'a1', ... }]
    render(<RunsListPage />);

    await waitFor(() => expect(screen.getByTestId('runs-list-filter-agent')).toHaveValue('a1'));
    // Give the agents-loaded validation effect a tick to run — it must not
    // clear a filter that legitimately matches.
    await act(async () => {
      await Promise.resolve();
    });
    expect(screen.getByTestId('runs-list-filter-agent')).toHaveValue('a1');
  });

  it('does not drop the filter while the agents list has not yet loaded (fetch failure)', async () => {
    window.history.pushState({}, '', '/ai-agents/runs#agent=a1');
    fetchMock.mockImplementation((url: string) => {
      if (url.startsWith('/ai/agents/runs')) return Promise.resolve(json({ data: [], nextCursor: null }));
      if (url.startsWith('/ai/agents')) return Promise.reject(new Error('network error'));
      return Promise.resolve(json({ data: [] }));
    });
    render(<RunsListPage />);

    // The agents list never loads (no `<option value="a1">` to reflect), so
    // the applied filter is observed via the outgoing runs request and the
    // "Clear filters" affordance — both state-driven, not select-DOM-driven.
    await waitFor(() => {
      const runsCall = fetchMock.mock.calls.find(([url]) => (url as string).startsWith('/ai/agents/runs'));
      expect(runsCall?.[0]).toContain('agentId=a1');
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    // The agents fetch failed — we never confirmed the filter is invalid, so
    // it must not be cleared out from under the deep link.
    expect(screen.getByTestId('runs-list-clear-filters')).toBeInTheDocument();
  });
});

// Critique finding #4 — the whole row is a click target, not just the
// agent-name link, and clicking the link itself must not double-navigate.
describe('RunsListPage row navigation', () => {
  function withMockedLocation() {
    const realLocation = window.location;
    const assign = vi.fn();
    Object.defineProperty(window, 'location', { configurable: true, value: { ...realLocation, assign } });
    return {
      assign,
      restore: () => Object.defineProperty(window, 'location', { configurable: true, value: realLocation }),
    };
  }

  it('navigates to the run detail page when clicking anywhere in the row', async () => {
    mockEndpoints();
    const { assign, restore } = withMockedLocation();
    try {
      render(<RunsListPage />);
      await waitFor(() => expect(screen.getByTestId('runs-list-row-run-1')).toBeInTheDocument());

      fireEvent.click(screen.getByTestId('runs-list-row-run-1'));
      expect(assign).toHaveBeenCalledWith('/ai-agents/runs/run-1');
    } finally {
      restore();
    }
  });

  it('does not double-navigate when the agent-name link itself is clicked', async () => {
    mockEndpoints();
    const { assign, restore } = withMockedLocation();
    try {
      render(<RunsListPage />);
      await waitFor(() => expect(screen.getByTestId('runs-list-row-link-run-1')).toBeInTheDocument());

      fireEvent.click(screen.getByTestId('runs-list-row-link-run-1'));
      // The link's own click handler stops propagation, so the row's
      // click-anywhere handler must not also fire.
      expect(assign).not.toHaveBeenCalled();
    } finally {
      restore();
    }
  });
});

// Critique finding #8 — a single "Clear filters" affordance, shown only
// when a filter is active.
describe('RunsListPage clear filters', () => {
  it('hides the clear-filters control when no filter is active', async () => {
    mockEndpoints();
    render(<RunsListPage />);
    await waitFor(() => expect(screen.getByTestId('runs-list-row-run-1')).toBeInTheDocument());

    expect(screen.queryByTestId('runs-list-clear-filters')).not.toBeInTheDocument();
  });

  it('shows the control once a filter is active, and clears both filters on click', async () => {
    mockEndpoints();
    render(<RunsListPage />);
    await waitFor(() => expect(screen.getByTestId('runs-list-row-run-1')).toBeInTheDocument());

    fireEvent.change(screen.getByTestId('runs-list-filter-status'), { target: { value: 'failed' } });
    await waitFor(() => expect(screen.getByTestId('runs-list-clear-filters')).toBeInTheDocument());

    fireEvent.click(screen.getByTestId('runs-list-clear-filters'));
    await waitFor(() => expect(screen.queryByTestId('runs-list-clear-filters')).not.toBeInTheDocument());
    expect(screen.getByTestId('runs-list-filter-status')).toHaveValue('');
    expect(screen.getByTestId('runs-list-filter-agent')).toHaveValue('');
  });
});

// Critique finding #1 — a non-terminal row must update on its own: the page
// polls page 1 every 10s while any visible row is live, merging fresh rows
// in by id, stops once every row is terminal, and pauses while hidden.
describe('RunsListPage polling', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
  });

  it('polls every 10s while a row is non-terminal and merges the fresh status in', async () => {
    mockEndpoints({ runs: [{ ...RUN_1, status: 'running' as const }] });
    render(<RunsListPage />);

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(screen.getByTestId('runs-list-row-run-1')).toHaveTextContent('Running');
    expect(screen.getByTestId('run-live-indicator')).toBeInTheDocument();

    mockEndpoints({ runs: [{ ...RUN_1, status: 'completed' as const }] });
    await act(async () => {
      vi.advanceTimersByTime(10_000);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(screen.getByTestId('runs-list-row-run-1')).toHaveTextContent('Completed');
    expect(screen.queryByTestId('run-live-indicator')).not.toBeInTheDocument();
  });

  // Review finding P2-1 (#4187 critique): a filtered, all-terminal result set
  // is inert (the filter itself pins the rows it can contain), so it keeps
  // the pre-fix "stop entirely" behavior. The unfiltered idle-poll cases are
  // covered below.
  it('does not poll when filtered and every visible row is already terminal', async () => {
    mockEndpoints(); // RUN_1 completed, RUN_2 failed — both terminal.
    render(<RunsListPage />);
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(screen.getByTestId('runs-list-row-run-1')).toBeInTheDocument();

    fireEvent.change(screen.getByTestId('runs-list-filter-status'), { target: { value: 'failed' } });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    const callsAfterLoad = fetchMock.mock.calls.length;

    await act(async () => {
      vi.advanceTimersByTime(30_000);
      await Promise.resolve();
    });

    expect(fetchMock.mock.calls.length).toBe(callsAfterLoad);
  });

  // Review finding P2-1 (#4187 critique): merging by id alone can never
  // surface a run that started after the initial page load — polling must
  // also stay alive with nothing on screen, at a slower idle cadence, and
  // prepend ids it hasn't seen yet.
  it('keeps a slow idle poll on the unfiltered page-1 view even when nothing is live, and prepends a newly started run', async () => {
    mockEndpoints(); // RUN_1 completed, RUN_2 failed — both terminal, unfiltered.
    render(<RunsListPage />);
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(screen.getByTestId('runs-list-row-run-1')).toBeInTheDocument();
    const callsAfterLoad = fetchMock.mock.calls.length;

    // Under 30s: idle cadence hasn't elapsed yet, no extra poll.
    await act(async () => {
      vi.advanceTimersByTime(10_000);
      await Promise.resolve();
    });
    expect(fetchMock.mock.calls.length).toBe(callsAfterLoad);

    // A run that started after the initial load — not merged into the
    // existing rows by id, so a naive merge-by-id poll would drop it.
    const RUN_3 = { ...RUN_1, id: 'run-3', status: 'running' as const, queuedAt: '2026-08-21T10:00:00.000Z' };
    mockEndpoints({ runs: [RUN_3, RUN_1, RUN_2] });

    await act(async () => {
      vi.advanceTimersByTime(20_000); // total 30s — the idle cadence.
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(fetchMock.mock.calls.length).toBeGreaterThan(callsAfterLoad);
    expect(screen.getByTestId('runs-list-row-run-3')).toBeInTheDocument();
    expect(screen.getByTestId('runs-list-row-run-1')).toBeInTheDocument();
    expect(screen.getByTestId('runs-list-row-run-2')).toBeInTheDocument();
    // Prepended: run-3 renders before run-1 in the table.
    const rows = screen.getAllByRole('row').map((row) => row.getAttribute('data-testid'));
    expect(rows.indexOf('runs-list-row-run-3')).toBeLessThan(rows.indexOf('runs-list-row-run-1'));
  });

  it('polls at the fast 10s cadence (not the 30s idle cadence) once a row is live', async () => {
    mockEndpoints({ runs: [{ ...RUN_1, status: 'running' as const }] });
    render(<RunsListPage />);
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(screen.getByTestId('runs-list-row-run-1')).toBeInTheDocument();
    const callsAfterLoad = fetchMock.mock.calls.length;

    await act(async () => {
      vi.advanceTimersByTime(10_000);
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(fetchMock.mock.calls.length).toBeGreaterThan(callsAfterLoad);
  });

  // Review finding P2-2 (#4187 critique): overlapping poll responses must
  // apply in request order, not resolution order.
  it('discards a stale poll response that resolves after a newer one', async () => {
    mockEndpoints({ runs: [{ ...RUN_1, status: 'running' as const }] });
    render(<RunsListPage />);
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(screen.getByTestId('runs-list-row-run-1')).toBeInTheDocument();

    let resolveOlder!: (value: Response) => void;
    let resolveNewer!: (value: Response) => void;
    const responses = [
      new Promise<Response>((resolve) => {
        resolveOlder = resolve;
      }),
      new Promise<Response>((resolve) => {
        resolveNewer = resolve;
      }),
    ];
    let call = 0;
    fetchMock.mockImplementation((url: string) => {
      if (url.startsWith('/ai/agents/runs')) {
        return responses[call++] ?? Promise.resolve(json({ data: [], nextCursor: null }));
      }
      return Promise.resolve(json({ data: [] }));
    });

    // Two poll ticks fire back to back (10s cadence while live) before either
    // response resolves.
    await act(async () => {
      vi.advanceTimersByTime(10_000);
      await Promise.resolve();
    });
    await act(async () => {
      vi.advanceTimersByTime(10_000);
      await Promise.resolve();
    });

    // Resolve the NEWER request first with a fresh status, then the OLDER
    // request with a stale one — the stale one must not win.
    resolveNewer(json({ data: [{ ...RUN_1, status: 'completed' as const }], nextCursor: null }));
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    resolveOlder(json({ data: [{ ...RUN_1, status: 'running' as const }], nextCursor: null }));
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(screen.getByTestId('runs-list-row-run-1')).toHaveTextContent('Completed');
  });

  it('pauses polling while the document is hidden', async () => {
    mockEndpoints({ runs: [{ ...RUN_1, status: 'running' as const }] });
    render(<RunsListPage />);

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });
    const callsAfterLoad = fetchMock.mock.calls.length;

    await act(async () => {
      vi.advanceTimersByTime(10_000);
      await Promise.resolve();
    });

    expect(fetchMock.mock.calls.length).toBe(callsAfterLoad);
  });
});
