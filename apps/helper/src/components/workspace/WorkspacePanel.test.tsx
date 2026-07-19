// @vitest-environment jsdom
import { fireEvent, render, screen } from '@testing-library/react';

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
// loads entries (browsePath set), then an unrelated Search failure sets the
// single global `error` field. Switching back to Browse must not mask the
// already-loaded entries behind a stale ErrorRow — Browse's own mount effect
// no-ops on revisit (browsePath is already set), so nothing re-fetches to
// clear `error` on its own; WorkspacePanel's tab switch must clear it.
it('switching tabs clears a stale error from a different view instead of masking already-loaded content', () => {
  useWorkspaceStore.setState({
    browsePath: { sourceId: 's1', parentPath: '' },
    entries: [file({ id: 'f1', name: 'alder-easement.pdf' })],
    // Simulates a Search failure that happened while the user was on the
    // Search tab (error is global, not scoped to the tab that set it).
    error: 'Search is unavailable right now.',
  });

  render(<WorkspacePanel onClose={() => {}} />);

  // Starts on the Search tab (component default) — the stale error is
  // legitimately visible there.
  expect(screen.getByText('Search is unavailable right now.')).toBeInTheDocument();

  fireEvent.click(screen.getByRole('tab', { name: 'Browse' }));

  // The previously-loaded Browse entries render; the stale error is gone.
  expect(screen.getByText('alder-easement.pdf')).toBeInTheDocument();
  expect(screen.queryByText('Search is unavailable right now.')).not.toBeInTheDocument();
});
