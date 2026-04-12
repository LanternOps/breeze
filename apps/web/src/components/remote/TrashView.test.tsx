import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import TrashView from './TrashView';

const mockListTrash = vi.fn();
const mockRestoreFromTrash = vi.fn();
const mockPurgeTrash = vi.fn();

vi.mock('./fileOperations', async () => {
  const actual = await vi.importActual<typeof import('./fileOperations')>('./fileOperations');
  return {
    ...actual,
    listTrash: (...args: unknown[]) => mockListTrash(...args),
    restoreFromTrash: (...args: unknown[]) => mockRestoreFromTrash(...args),
    purgeTrash: (...args: unknown[]) => mockPurgeTrash(...args),
  };
});

const twoItems = [
  {
    originalPath: '/tmp/one.txt',
    trashId: 'trash-1',
    deletedAt: '2026-04-11T10:00:00Z',
    deletedBy: 'me',
    isDirectory: false,
    sizeBytes: 10,
  },
  {
    originalPath: '/tmp/two.txt',
    trashId: 'trash-2',
    deletedAt: '2026-04-11T10:00:00Z',
    deletedBy: 'me',
    isDirectory: false,
    sizeBytes: 10,
  },
];

function seed() {
  // Use mockResolvedValueOnce so tests that queue additional Once responses
  // (e.g. for the post-restore fetchTrash call) consume them in FIFO order.
  // A default fallback ensures extra calls (e.g. inline error recovery) also work.
  mockListTrash.mockResolvedValueOnce(twoItems);
  mockListTrash.mockResolvedValue(twoItems);
}

describe('TrashView restore outcomes', () => {
  beforeEach(() => {
    mockListTrash.mockReset();
    mockRestoreFromTrash.mockReset();
    mockPurgeTrash.mockReset();
    seed();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('shows an amber warning when restore results are all unverified', async () => {
    mockRestoreFromTrash.mockResolvedValueOnce({
      results: [
        { trashId: 'trash-1', status: 'failure', error: 'timed out', unverified: true },
        { trashId: 'trash-2', status: 'failure', error: 'timed out', unverified: true },
      ],
    });

    render(<TrashView deviceId="dev-1" onRestore={() => {}} />);
    await screen.findByText('/tmp/one.txt');

    // Select all via header checkbox
    const checkboxes = screen.getAllByRole('checkbox');
    fireEvent.click(checkboxes[0]);
    fireEvent.click(screen.getByText(/Restore Selected/));

    const banner = await screen.findByText(/2 unverified — refresh to verify/i);
    expect(banner.className).toMatch(/amber/);
  });

  it('shows a red error banner with counts on mixed failure + unverified', async () => {
    mockRestoreFromTrash.mockResolvedValueOnce({
      results: [
        { trashId: 'trash-1', status: 'failure', error: 'permission denied' },
        { trashId: 'trash-2', status: 'failure', error: 'timed out', unverified: true },
      ],
    });

    render(<TrashView deviceId="dev-1" onRestore={() => {}} />);
    await screen.findByText('/tmp/one.txt');

    const checkboxes = screen.getAllByRole('checkbox');
    fireEvent.click(checkboxes[0]);
    fireEvent.click(screen.getByText(/Restore Selected/));

    await waitFor(() => {
      expect(screen.getByText(/1 failed/)).toBeInTheDocument();
      expect(screen.getByText(/1 unverified/)).toBeInTheDocument();
    });
  });

  it('does not show any banner on fully successful restore', async () => {
    mockRestoreFromTrash.mockResolvedValueOnce({
      results: [
        { trashId: 'trash-1', status: 'success', restoredPath: '/tmp/one.txt' },
        { trashId: 'trash-2', status: 'success', restoredPath: '/tmp/two.txt' },
      ],
    });
    mockListTrash.mockResolvedValueOnce([]);

    render(<TrashView deviceId="dev-1" onRestore={() => {}} />);
    await screen.findByText('/tmp/one.txt');

    const checkboxes = screen.getAllByRole('checkbox');
    fireEvent.click(checkboxes[0]);
    fireEvent.click(screen.getByText(/Restore Selected/));

    await waitFor(() => {
      expect(screen.queryByText(/failed/i)).toBeNull();
      expect(screen.queryByText(/unverified/i)).toBeNull();
    });
  });
});
