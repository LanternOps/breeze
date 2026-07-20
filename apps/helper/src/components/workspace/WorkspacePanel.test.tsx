// @vitest-environment jsdom
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';

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

// Finding 4b: an empty Browse folder must distinguish "genuinely empty" from
// "filtered to nothing". With an active project/docType chip the copy has to
// point at the filter, not imply the folder itself is empty.
it('Browse empty state reflects an active filter: "No matches in this folder" + clear-filters hint', async () => {
  useWorkspaceStore.setState({
    browse: vi.fn().mockResolvedValue(undefined),
    browsePath: { sourceId: 's1', parentPath: 'clients' },
    entries: [],
    filters: { docType: 'Contract' },
  });

  render(<WorkspacePanel onClose={() => {}} />);
  fireEvent.click(screen.getByRole('tab', { name: 'Browse' }));

  expect(await screen.findByText('No matches in this folder')).toBeInTheDocument();
  expect(screen.getByText('Clear filters to see everything.')).toBeInTheDocument();
  expect(screen.queryByText('This folder is empty')).not.toBeInTheDocument();
});

it('Browse empty state with no active filter still reads "This folder is empty"', async () => {
  useWorkspaceStore.setState({
    browse: vi.fn().mockResolvedValue(undefined),
    browsePath: { sourceId: 's1', parentPath: 'clients' },
    entries: [],
    filters: {},
  });

  render(<WorkspacePanel onClose={() => {}} />);
  fireEvent.click(screen.getByRole('tab', { name: 'Browse' }));

  expect(await screen.findByText('This folder is empty')).toBeInTheDocument();
  expect(screen.queryByText('No matches in this folder')).not.toBeInTheDocument();
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

// Browse-chips extension (controller adjudication): the plan's Architecture
// line authorizes project/docType — the same two params Task 6 gave
// /helper/search — on the browse endpoint too. Browse's chip row must show
// only those two (Date/Source/Kind stay Search-only, since browse doesn't
// accept the other params), and picking a value must re-issue the browse
// fetch for the current folder with the new filter.
it('Browse tab shows only Project/Doc type chips, and selecting one re-issues the browse fetch', async () => {
  const browseSpy = vi.fn().mockResolvedValue(undefined);
  useWorkspaceStore.setState({
    browse: browseSpy,
    browsePath: { sourceId: 's1', parentPath: '' },
    entries: [
      file({
        id: 'f1',
        name: 'alder-easement.pdf',
        inferredProjectLabel: 'Henderson Water Main Replacement',
        inferredDocType: 'easement',
      }),
    ],
  });

  render(<WorkspacePanel onClose={() => {}} />);
  fireEvent.click(screen.getByRole('tab', { name: 'Browse' }));

  // Only Project/Doc type render — no Date/Source/Kind chips on Browse.
  // Scoped to the chip row itself: FileTable's sortable "Project" column
  // header button would otherwise collide with the chip's own "Project" name.
  const chipRow = document.querySelector('.ws-filter-chip-row') as HTMLElement;
  expect(within(chipRow).getByRole('button', { name: 'Project' })).toBeInTheDocument();
  expect(within(chipRow).getByRole('button', { name: 'Doc type' })).toBeInTheDocument();
  expect(within(chipRow).queryByRole('button', { name: 'Date' })).not.toBeInTheDocument();
  expect(within(chipRow).queryByRole('button', { name: 'Kind' })).not.toBeInTheDocument();

  // The mount-time "open first source" effect must not have fired — browsePath
  // was already set, so it no-ops. The chip/tab effect DOES fire once here
  // though: lastBrowseKeyRef seeds to null (not from browsePath + current
  // filters — see Finding 2 in WorkspacePanel.tsx), so the first Browse entry
  // after mount always re-fetches once, regardless of a preset browsePath.
  await waitFor(() => expect(browseSpy).toHaveBeenCalledTimes(1));
  expect(browseSpy).toHaveBeenNthCalledWith(1, 's1', '');

  fireEvent.pointerDown(within(chipRow).getByRole('button', { name: 'Project' }), { button: 0 });
  // Menu item, not FileTable's own "Henderson Water Main Replacement" cell.
  const option = await screen.findByRole('menuitem', { name: 'Henderson Water Main Replacement' });
  fireEvent.click(option);

  expect(useWorkspaceStore.getState().filters.project).toBe('Henderson Water Main Replacement');
  await waitFor(() => expect(browseSpy).toHaveBeenCalledTimes(2));
  expect(browseSpy).toHaveBeenNthCalledWith(2, 's1', '');
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

// Regression test for the finding: the skip guard above checked only the
// (query, filters) key, not whether `error` was currently set, and nothing
// else clears `error` when the query changes within the same tab. So: search
// "alder" (succeeds, key recorded), search "boblegal" (fails — ErrorRow
// shows; failures don't update the key), then retype "alder" exactly — the
// guard saw a key match and bailed with no fetch and no error clear, leaving
// the stale ErrorRow masking alder's valid results indefinitely. Gate the
// skip on `!error` too so a revisit while an error is showing still re-fetches.
it('retyping a previously-successful query clears a stale error left by an intervening failed search', async () => {
  vi.useFakeTimers();
  try {
    const searchSpy = vi.fn(async (q: string) => {
      if (q === 'alder') {
        useWorkspaceStore.setState({
          results: [file({ id: 'f1', name: 'alder-easement.pdf' })],
          error: null,
          loading: false,
        });
      } else {
        useWorkspaceStore.setState({
          error: 'Search is unavailable right now.',
          loading: false,
        });
      }
    });
    useWorkspaceStore.setState({ search: searchSpy });

    render(<WorkspacePanel onClose={() => {}} />);
    const input = screen.getByPlaceholderText('Search shared files...');

    fireEvent.change(input, { target: { value: 'alder' } });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(300);
    });
    expect(screen.getByText('alder-easement.pdf')).toBeInTheDocument();

    fireEvent.change(input, { target: { value: 'boblegal' } });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(300);
    });
    expect(screen.getByText('Search is unavailable right now.')).toBeInTheDocument();

    // Retype "alder" exactly — same query/filters key as the earlier success.
    fireEvent.change(input, { target: { value: 'alder' } });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(300);
    });

    // The stale ErrorRow must be gone and alder's results must render again.
    expect(screen.queryByText('Search is unavailable right now.')).not.toBeInTheDocument();
    expect(screen.getByText('alder-easement.pdf')).toBeInTheDocument();
  } finally {
    vi.useRealTimers();
  }
});

// Regression test for the Critical auto-retry loop: the store's search() writes
// `error` twice per attempt (null → message). When `error` was a dependency of
// the debounce effect, those writes re-ran the effect, re-armed the timer, and
// refetched a persistently failing query forever. With `error` read via
// getState() (not a dependency), a single failing query must issue exactly ONE
// search and hold a stable ErrorRow no matter how far fake timers advance.
it('a persistently failing query issues exactly one search and holds a stable ErrorRow (no auto-retry loop)', async () => {
  vi.useFakeTimers();
  try {
    const searchSpy = vi.fn(async () => {
      // Mirror the real store search()'s two error writes per attempt — the
      // exact writes that used to re-arm the debounce timer.
      useWorkspaceStore.setState({ loading: true, error: null });
      useWorkspaceStore.setState({ loading: false, error: 'Search is unavailable right now.' });
    });
    useWorkspaceStore.setState({ search: searchSpy });

    render(<WorkspacePanel onClose={() => {}} />);
    fireEvent.change(screen.getByPlaceholderText('Search shared files...'), {
      target: { value: 'boblegal' },
    });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(300);
    });
    expect(searchSpy).toHaveBeenCalledTimes(1);
    expect(screen.getByText('Search is unavailable right now.')).toBeInTheDocument();

    // Advance well past many debounce windows with NO further input.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
    });

    // Still exactly one call; the ErrorRow is stable (no flicker/retry loop).
    expect(searchSpy).toHaveBeenCalledTimes(1);
    expect(screen.getByText('Search is unavailable right now.')).toBeInTheDocument();
  } finally {
    vi.useRealTimers();
  }
});

// Regression test for the empty-query stale-error mask: a failed search leaves
// the single global `error` set; clearing the input to '' must clear that
// error (via the effect's empty-query branch) so the "Search your firm's
// files" EmptyState shows instead of the stale ErrorRow.
it('clearing the query to empty while an ErrorRow shows restores the empty state', async () => {
  vi.useFakeTimers();
  try {
    const searchSpy = vi.fn(async () => {
      useWorkspaceStore.setState({ error: 'Search is unavailable right now.', loading: false });
    });
    useWorkspaceStore.setState({ search: searchSpy });

    render(<WorkspacePanel onClose={() => {}} />);
    const input = screen.getByPlaceholderText('Search shared files...');

    fireEvent.change(input, { target: { value: 'boblegal' } });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(300);
    });
    expect(screen.getByText('Search is unavailable right now.')).toBeInTheDocument();

    // Clear the input — the empty-query branch clears the store error.
    fireEvent.change(input, { target: { value: '' } });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });

    expect(screen.queryByText('Search is unavailable right now.')).not.toBeInTheDocument();
    expect(screen.getByText("Search your firm's files")).toBeInTheDocument();
  } finally {
    vi.useRealTimers();
  }
});

// Regression test for the Browse tab/filter desync: the chip effect omitted
// `tab` from its deps, so a filters.project change made while on another tab
// (Search's chip row writes the same shared slice) left Browse showing active
// chips over a stale list when the user returned. With `tab` in the deps and a
// lastBrowseKeyRef guard, returning to Browse after such a change must re-issue
// the current folder's browse with the new filter.
it('re-fetches Browse on return when a shared filter changed while off the tab', async () => {
  const browseSpy = vi.fn().mockResolvedValue(undefined);
  useWorkspaceStore.setState({
    browse: browseSpy,
    browsePath: { sourceId: 's1', parentPath: 'docs' },
    entries: [file({ id: 'f1', name: 'alder-easement.pdf' })],
  });

  render(<WorkspacePanel onClose={() => {}} />);

  // Enter Browse: lastBrowseKeyRef seeds to null (Finding 2 — it no longer
  // trusts browsePath + current filters at seed time), so this first entry
  // after mount re-fetches once even though a folder was already loaded.
  fireEvent.click(screen.getByRole('tab', { name: 'Browse' }));
  await waitFor(() => expect(browseSpy).toHaveBeenCalledTimes(1));
  expect(browseSpy).toHaveBeenNthCalledWith(1, 's1', 'docs');

  // Leave Browse, then change the shared filters.project slice from another tab.
  fireEvent.click(screen.getByRole('tab', { name: 'Search' }));
  act(() => {
    useWorkspaceStore.getState().setFilter('project', 'Henderson Water Main Replacement');
  });
  expect(browseSpy).toHaveBeenCalledTimes(1); // still off Browse → no new fetch yet

  // Return to Browse: the filter changed, so the current folder must re-fetch.
  fireEvent.click(screen.getByRole('tab', { name: 'Browse' }));
  await waitFor(() => expect(browseSpy).toHaveBeenCalledTimes(2));
  expect(browseSpy).toHaveBeenNthCalledWith(2, 's1', 'docs');
});

// Regression test for Finding 1 (verification review, asymmetric browse
// guard): the browse skip guard checked only the (sourceId, parentPath,
// project, docType) key, not whether `error` was currently set — unlike the
// search debounce effect's guard, which is error-aware. Repro: browse
// (s1, docs) unfiltered succeeds (key recorded) -> a project chip set while
// on Browse re-issues the fetch and it FAILS (error set; the key is only
// recorded on success, so lastBrowseKeyRef is unchanged) -> clearing the
// chip mutates only `filters`, never `error` -> the effect re-runs with a
// key that once again matches the earlier unfiltered success, and a
// key-only guard skips, leaving a stale ErrorRow masking the folder's
// still-valid entries indefinitely.
it('clearing a filter after a failed browse re-fetches instead of leaving a stale ErrorRow', async () => {
  const browseSpy = vi.fn(async () => {
    const { project } = useWorkspaceStore.getState().filters;
    if (project) {
      useWorkspaceStore.setState({ error: 'Could not reach the index.', loading: false });
    } else {
      // Deliberately does NOT touch `browsePath` — it's already correct
      // ({ sourceId: 's1', parentPath: 'docs' }) from the initial setState
      // below, and reassigning it to a fresh object on every success would
      // change its identity, which is itself a dependency of the effect
      // under test — an unrelated re-render/re-run loop that has nothing to
      // do with the guard behavior this test is verifying.
      useWorkspaceStore.setState({
        entries: [file({ id: 'f1', name: 'alder-easement.pdf' })],
        error: null,
        loading: false,
      });
    }
  });
  useWorkspaceStore.setState({
    browse: browseSpy,
    browsePath: { sourceId: 's1', parentPath: 'docs' },
  });

  render(<WorkspacePanel onClose={() => {}} />);
  fireEvent.click(screen.getByRole('tab', { name: 'Browse' }));

  // First entry after mount: lastBrowseKeyRef seeds to null (Finding 2), so
  // this fetch runs, succeeds unfiltered, and records the success key.
  await waitFor(() => expect(browseSpy).toHaveBeenCalledTimes(1));
  expect(screen.getByText('alder-easement.pdf')).toBeInTheDocument();

  // Set a project filter — the chip/tab effect re-fetches and it fails.
  act(() => {
    useWorkspaceStore.getState().setFilter('project', 'Henderson Water Main Replacement');
  });
  await waitFor(() => expect(browseSpy).toHaveBeenCalledTimes(2));
  expect(screen.getByText('Could not reach the index.')).toBeInTheDocument();

  // Clear the filter: the recomputed key matches the earlier unfiltered
  // success, but `error` is still set, so the guard must still re-fetch
  // instead of skipping and leaving the ErrorRow stuck over valid entries.
  act(() => {
    useWorkspaceStore.getState().clearFilter('project');
  });
  await waitFor(() => expect(browseSpy).toHaveBeenCalledTimes(3));
  expect(screen.queryByText('Could not reach the index.')).not.toBeInTheDocument();
  expect(screen.getByText('alder-easement.pdf')).toBeInTheDocument();
});

// Regression test for Finding 2 (verification review, over-trusting seed):
// lastBrowseKeyRef used to be seeded on mount from persisted browsePath +
// *current* filters, conflating "what was successfully fetched" with
// "current filter state". Repro: browse unfiltered succeeds -> a project
// chip gets set (e.g. from Search) -> the panel is closed and reopened
// (WorkspacePanel unmounts/remounts; `browsePath`/`filters` survive in the
// module-level store) -> entering Browse must re-fetch, since the old seed
// would otherwise match the *current* (filtered) state at mount and skip,
// rendering stale unfiltered entries under an active filter chip.
it('remounting the panel with a filter set after the last fetch re-fetches Browse on entry', async () => {
  const browseSpy = vi.fn().mockResolvedValue(undefined);
  useWorkspaceStore.setState({
    browse: browseSpy,
    browsePath: { sourceId: 's1', parentPath: 'docs' },
    entries: [file({ id: 'f1', name: 'alder-easement.pdf' })],
    filters: { project: 'Henderson Water Main Replacement' },
  });

  const { unmount } = render(<WorkspacePanel onClose={() => {}} />);
  unmount();

  render(<WorkspacePanel onClose={() => {}} />);
  fireEvent.click(screen.getByRole('tab', { name: 'Browse' }));

  await waitFor(() => expect(browseSpy).toHaveBeenCalledWith('s1', 'docs'));
});
