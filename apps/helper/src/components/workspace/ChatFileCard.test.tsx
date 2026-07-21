// @vitest-environment jsdom
import { fireEvent, render, screen } from '@testing-library/react';

const { mockInvoke } = vi.hoisted(() => ({ mockInvoke: vi.fn(async () => undefined) }));

vi.mock('../../lib/helperFetch', () => ({
  helperRequest: vi.fn(),
  getTauriInvoke: vi.fn(async () => mockInvoke),
  requireDevBearerToken: vi.fn(),
}));

import ChatFileCard, { openWorkspaceFile, type WorkspaceFileSummary } from './ChatFileCard';
import { useChatStore } from '../../stores/chatStore';
import { useWorkspaceStore } from '../../stores/workspaceStore';

function summary(overrides: Partial<WorkspaceFileSummary> = {}): WorkspaceFileSummary {
  return {
    fileIndexId: 'f1',
    relPath: 'Projects/Henderson/easement.pdf',
    project: 'Henderson',
    docType: 'Easement',
    openPath: '/srv/share/Projects/Henderson/easement.pdf',
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockInvoke.mockResolvedValue(undefined);
  useChatStore.setState({ username: 'todd', agentConfig: null });
});

it('renders name and a project — docType meta line, and an Open button', () => {
  render(<ChatFileCard files={[summary()]} />);
  expect(screen.getByText('easement.pdf')).toBeInTheDocument();
  expect(screen.getByText('Henderson — Easement')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Open' })).toBeInTheDocument();
});

it('renders nothing for an empty file list', () => {
  const { container } = render(<ChatFileCard files={[]} />);
  expect(container).toBeEmptyDOMElement();
});

it('omits the meta line when project and docType are both absent', () => {
  render(<ChatFileCard files={[summary({ project: null, docType: null })]} />);
  expect(screen.getByText('easement.pdf')).toBeInTheDocument();
  expect(screen.queryByText('Henderson — Easement')).not.toBeInTheDocument();
});

it('clicking Open records activity and invokes open_workspace_path with the openPath', async () => {
  const recordActivitySpy = vi.spyOn(useWorkspaceStore.getState(), 'recordActivity');
  render(<ChatFileCard files={[summary()]} />);

  fireEvent.click(screen.getByRole('button', { name: 'Open' }));
  await Promise.resolve();
  await Promise.resolve();

  expect(recordActivitySpy).toHaveBeenCalledWith('f1', 'open', 'todd');
  expect(mockInvoke).toHaveBeenCalledWith('open_workspace_path', {
    input: { path: '/srv/share/Projects/Henderson/easement.pdf' },
  });
});

it('the Open button is disabled when openPath is null', () => {
  render(<ChatFileCard files={[summary({ openPath: null })]} />);
  expect(screen.getByRole('button', { name: 'Open' })).toBeDisabled();
});

describe('openWorkspaceFile', () => {
  it('returns false and does nothing when openPath is null', async () => {
    const ok = await openWorkspaceFile('f1', null, 'todd');
    expect(ok).toBe(false);
    expect(mockInvoke).not.toHaveBeenCalled();
  });

  it('falls back to the clipboard and returns false when invoke throws', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });
    mockInvoke.mockRejectedValueOnce(new Error('nope'));

    const ok = await openWorkspaceFile('f1', '/a/b.pdf', 'todd');

    expect(ok).toBe(false);
    expect(writeText).toHaveBeenCalledWith('/a/b.pdf');
  });
});
