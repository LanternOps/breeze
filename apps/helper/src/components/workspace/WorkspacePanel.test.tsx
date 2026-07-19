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
