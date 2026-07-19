// @vitest-environment jsdom
import { act, fireEvent, render, screen } from '@testing-library/react';

vi.mock('../../lib/helperFetch', () => ({
  helperRequest: vi.fn(),
  getTauriInvoke: vi.fn(async () => null),
  requireDevBearerToken: vi.fn(),
}));

import WorkspacePanel from './WorkspacePanel';
import { useWorkspaceStore, type FinderFile } from '../../stores/workspaceStore';
import { useChatStore } from '../../stores/chatStore';

function file(overrides: Partial<FinderFile> = {}): FinderFile {
  return {
    id: 'f1',
    sourceId: 's1',
    deviceKey: '__shared__',
    relPath: 'clients/alder/b.pdf',
    parentPath: 'clients/alder',
    name: 'b.pdf',
    isDir: false,
    ext: 'pdf',
    size: 1024,
    mtime: '2026-07-01T00:00:00.000Z',
    openPath: '\\\\srv\\share\\clients\\alder\\b.pdf',
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  useChatStore.setState({ username: 'todd', agentConfig: null });
  useWorkspaceStore.setState({
    available: true,
    features: [],
    contentEnabled: false,
    contentFeatures: [],
    sources: [{ id: 's1', displayName: 'Firm Share', kind: 'smb' }],
    results: [],
    entries: [],
    recent: [],
    department: [],
    filings: [],
    projects: [],
    loading: false,
    error: null,
    filingBusy: null,
    browsePath: null,
    filters: {},
    sort: { search: null, browse: { col: 'name', dir: 'asc' }, recents: { col: 'mtime', dir: 'desc' } },
  });
});

// Regression test for the tab-switch stale-error bug: Browse successfully
// loads entries (browsePath set), then — while WorkspacePanel is already
// mounted — an unrelated Search failure sets the single global `error`
// field. Switching back to Browse must not mask the already-loaded entries
// behind a stale ErrorRow — Browse's own mount effect no-ops on revisit
// (browsePath is already set), so nothing re-fetches to clear `error` on
// its own; WorkspacePanel's tab switch must clear it.
it('switching tabs clears a stale error from a different view instead of masking already-loaded content', () => {
  useWorkspaceStore.setState({
    browsePath: { sourceId: 's1', parentPath: '' },
    entries: [file({ id: 'f1', name: 'alder-easement.pdf' })],
  });

  render(<WorkspacePanel onClose={() => {}} />);

  // Simulates a Search failure that happens while the user is already on
  // the Search tab (error is global, not scoped to the tab that set it) —
  // set it *after* mount so this exercises the tab-switch guard, not the
  // separate mount-time clear covered below.
  act(() => {
    useWorkspaceStore.setState({ error: 'Search is unavailable right now.' });
  });
  expect(screen.getByText('Search is unavailable right now.')).toBeInTheDocument();

  fireEvent.click(screen.getByRole('tab', { name: 'Browse' }));

  // The previously-loaded Browse entries render; the stale error is gone.
  expect(screen.getByText('alder-easement.pdf')).toBeInTheDocument();
  expect(screen.queryByText('Search is unavailable right now.')).not.toBeInTheDocument();
});

// Regression test for the mount-time stale-error bug: `error` lives in the
// module-level store, which survives WorkspacePanel unmounting (App.tsx
// conditionally renders the panel — closing and reopening Files is a normal
// user action, not a tab switch, so the tab-switch guard above never runs
// for it). A leftover error from a session before the panel was last closed
// must not resurface as a stale ErrorRow on the freshly-mounted panel's
// default (Search) tab, masking the correct empty-query EmptyState.
it('mounting a fresh panel clears a leftover error instead of masking the default tab\'s correct state', () => {
  useWorkspaceStore.setState({
    // Simulates a Browse failure that happened before the panel was closed
    // (or before the user ever switched tabs), left over in the store.
    error: 'Could not reach the index.',
  });

  render(<WorkspacePanel onClose={() => {}} />);

  // Search tab (the default) shows its correct empty-query EmptyState, not
  // the stale error.
  expect(screen.queryByText('Could not reach the index.')).not.toBeInTheDocument();
  expect(screen.getByText("Search your firm's files")).toBeInTheDocument();
});

// Regression test for the debounced-search-not-cancelled bug: typing a query
// on Search arms a 300ms debounce timer. Switching to another tab before it
// fires must cancel that timer outright — otherwise it fires later, calls
// the (now wrong-context) `search()`, and a subsequent failure would mask
// the tab the user actually navigated to behind a stale ErrorRow. Neither
// the tab-switch nor the mount-time error clear (above) touch this, since
// both only clear `error` at the moment of switching/mounting, not a timer
// that fires afterward.
it('switching tabs before the search debounce fires cancels the pending search', () => {
  vi.useFakeTimers();
  try {
    const searchSpy = vi.fn().mockResolvedValue(undefined);
    useWorkspaceStore.setState({ search: searchSpy });

    render(<WorkspacePanel onClose={() => {}} />);

    fireEvent.change(screen.getByPlaceholderText('Search shared files...'), {
      target: { value: 'alder' },
    });

    // Switch away before the 300ms debounce elapses.
    fireEvent.click(screen.getByRole('tab', { name: 'Browse' }));

    act(() => {
      vi.advanceTimersByTime(1000);
    });

    // The cancelled timer must never call search() at all.
    expect(searchSpy).not.toHaveBeenCalled();
  } finally {
    vi.useRealTimers();
  }
});

// Regression test for the debounce-effect's `tab` dependency re-arming a
// redundant fetch: type a query on Search (debounce fires, search succeeds,
// FileTable renders), navigate to Browse, then back to Search with the same
// query/filters. Nothing changed, so no new fetch should be scheduled —
// otherwise the already-correct results would flicker back to SkeletonRows
// (or worse, a flaky refetch could mask them behind a stale ErrorRow) purely
// from revisiting an already-loaded view.
it('returning to Search with an unchanged query does not re-issue the search', async () => {
  vi.useFakeTimers();
  try {
    const searchSpy = vi.fn().mockResolvedValue(undefined);
    useWorkspaceStore.setState({
      search: searchSpy,
      browsePath: { sourceId: 's1', parentPath: '' },
      entries: [file({ id: 'f1', name: 'alder-easement.pdf' })],
    });

    render(<WorkspacePanel onClose={() => {}} />);

    fireEvent.change(screen.getByPlaceholderText('Search shared files...'), {
      target: { value: 'alder' },
    });

    // Let the debounce fire and the search's success handler (which records
    // the query/filters key) run.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(300);
    });
    expect(searchSpy).toHaveBeenCalledTimes(1);

    // Navigate away, then back to Search — query/filters are unchanged.
    fireEvent.click(screen.getByRole('tab', { name: 'Browse' }));
    fireEvent.click(screen.getByRole('tab', { name: 'Search' }));

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });

    // No redundant re-fetch of the already-loaded results.
    expect(searchSpy).toHaveBeenCalledTimes(1);
  } finally {
    vi.useRealTimers();
  }
});
