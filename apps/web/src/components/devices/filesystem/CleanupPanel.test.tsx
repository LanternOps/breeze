import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/stores/auth', () => ({ fetchWithAuth: vi.fn() }));
const { showToastMock } = vi.hoisted(() => ({ showToastMock: vi.fn() }));
vi.mock('@/components/shared/Toast', () => ({ showToast: showToastMock }));

import { fetchWithAuth } from '@/stores/auth';
import CleanupPanel from './CleanupPanel';
import type { FilesystemCleanupPreview } from './filesystemTabUtils';

const fetchMock = vi.mocked(fetchWithAuth);

const RUN_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

const preview = (over: Partial<FilesystemCleanupPreview> = {}): FilesystemCleanupPreview => ({
  cleanupRunId: RUN_ID,
  snapshotId: 'snap-1',
  scanPath: 'C:\\',
  estimatedBytes: 3072,
  candidateCount: 3,
  categories: [
    { category: 'temp_files', count: 2, estimatedBytes: 2048 },
    { category: 'browser_cache', count: 1, estimatedBytes: 1024 },
  ],
  candidates: [
    { path: 'C:\\Windows\\Temp\\big', category: 'temp_files', sizeBytes: 1536 },
    { path: 'C:\\Windows\\Temp\\small', category: 'temp_files', sizeBytes: 512 },
    { path: 'C:\\Users\\a\\Cache\\c', category: 'browser_cache', sizeBytes: 1024 },
  ],
  ...over,
});

const json = (payload: unknown, status = 200): Response =>
  ({ ok: status >= 200 && status < 300, status, json: vi.fn().mockResolvedValue(payload) }) as unknown as Response;

describe('CleanupPanel', () => {
  beforeEach(() => vi.clearAllMocks());

  it('prompts for a preview when there is none', () => {
    render(<CleanupPanel deviceId="dev-1" volumeLabel="C:\\" preview={null} onExecuted={vi.fn()} />);
    expect(screen.getByText('Run Cleanup Preview to choose what to delete.')).toBeInTheDocument();
    expect(screen.queryByTestId('cleanup-execute')).not.toBeInTheDocument();
  });

  it('lists candidates sorted by size, largest first', () => {
    render(<CleanupPanel deviceId="dev-1" volumeLabel="C:\\" preview={preview()} onExecuted={vi.fn()} />);
    const rows = screen.getAllByTestId(/^cleanup-candidate-(?!checkbox-)/);
    expect(rows.map((r) => r.getAttribute('data-path'))).toEqual([
      'C:\\Windows\\Temp\\big',
      'C:\\Users\\a\\Cache\\c',
      'C:\\Windows\\Temp\\small',
    ]);
  });

  it('starts with nothing selected and disables Execute', () => {
    render(<CleanupPanel deviceId="dev-1" volumeLabel="C:\\" preview={preview()} onExecuted={vi.fn()} />);
    expect(screen.getByTestId('cleanup-execute')).toBeDisabled();
  });

  it('select-all-in-category checks exactly that category and updates the byte total', async () => {
    render(<CleanupPanel deviceId="dev-1" volumeLabel="C:\\" preview={preview()} onExecuted={vi.fn()} />);

    await userEvent.click(screen.getByTestId('cleanup-category-select-all-temp_files'));

    expect(screen.getByTestId('cleanup-candidate-checkbox-C:\\Windows\\Temp\\big')).toBeChecked();
    expect(screen.getByTestId('cleanup-candidate-checkbox-C:\\Windows\\Temp\\small')).toBeChecked();
    expect(screen.getByTestId('cleanup-candidate-checkbox-C:\\Users\\a\\Cache\\c')).not.toBeChecked();
    expect(screen.getByTestId('cleanup-selection-summary')).toHaveTextContent('2.0 KB');
  });

  it('opens a destructive confirm listing volume, count, bytes and the first 10 paths', async () => {
    render(<CleanupPanel deviceId="dev-1" volumeLabel="C:\\" preview={preview()} onExecuted={vi.fn()} />);
    await userEvent.click(screen.getByTestId('cleanup-category-select-all-temp_files'));
    await userEvent.click(screen.getByTestId('cleanup-execute'));

    const dialog = await screen.findByTestId('cleanup-confirm-dialog');
    expect(within(dialog).getByText(/^Delete /)).toHaveTextContent('C:\\');
    expect(within(dialog).getByText(/2 item\(s\)/)).toBeInTheDocument();
    expect(within(dialog).getByText(/2\.0 KB/)).toBeInTheDocument();
    expect(within(dialog).getByText('C:\\Windows\\Temp\\big')).toBeInTheDocument();
    // Nothing is deleted until Confirm is pressed.
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('caps the confirm path list at 10 and says how many there are', async () => {
    const many = preview({
      candidates: Array.from({ length: 14 }, (_, i) => ({
        path: `C:\\Windows\\Temp\\f${i}`, category: 'temp_files', sizeBytes: 100 - i,
      })),
      categories: [{ category: 'temp_files', count: 14, estimatedBytes: 1000 }],
    });
    render(<CleanupPanel deviceId="dev-1" volumeLabel="C:\\" preview={many} onExecuted={vi.fn()} />);
    await userEvent.click(screen.getByTestId('cleanup-category-select-all-temp_files'));
    await userEvent.click(screen.getByTestId('cleanup-execute'));

    const dialog = await screen.findByTestId('cleanup-confirm-dialog');
    expect(within(dialog).getAllByTestId(/^cleanup-confirm-path-/)).toHaveLength(10);
    expect(within(dialog).getByText('First 10 of 14 paths')).toBeInTheDocument();
  });

  it('posts cleanupRunId and ONLY the checked paths', async () => {
    fetchMock.mockResolvedValue(json({
      success: true,
      data: {
        cleanupRunId: RUN_ID, status: 'executed', bytesReclaimed: 2048,
        selectedCount: 2, failedCount: 0, rejectedPaths: [], partial: false, budgetMs: 240_000,
        actions: [
          { path: 'C:\\Windows\\Temp\\big', category: 'temp_files', sizeBytes: 1536, status: 'completed' },
          { path: 'C:\\Windows\\Temp\\small', category: 'temp_files', sizeBytes: 512, status: 'completed' },
        ],
      },
    }));
    const onExecuted = vi.fn();
    render(<CleanupPanel deviceId="dev-1" volumeLabel="C:\\" preview={preview()} onExecuted={onExecuted} />);

    await userEvent.click(screen.getByTestId('cleanup-category-select-all-temp_files'));
    await userEvent.click(screen.getByTestId('cleanup-execute'));
    await userEvent.click(await screen.findByTestId('cleanup-confirm-button'));

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toBe('/devices/dev-1/filesystem/cleanup-execute');
    expect(init?.method).toBe('POST');
    expect(JSON.parse(String(init?.body))).toEqual({
      cleanupRunId: RUN_ID,
      paths: ['C:\\Windows\\Temp\\big', 'C:\\Windows\\Temp\\small'],
    });
    await waitFor(() => expect(onExecuted).toHaveBeenCalled());
  });

  it('renders all five outcome counts and an amber failure list, never a green box', async () => {
    fetchMock.mockResolvedValue(json({
      success: true,
      data: {
        cleanupRunId: RUN_ID, status: 'executed', bytesReclaimed: 1536,
        selectedCount: 3, failedCount: 1, rejectedPaths: ['C:\\nope'], partial: false, budgetMs: 240_000,
        actions: [
          { path: 'C:\\Windows\\Temp\\big', category: 'temp_files', sizeBytes: 1536, status: 'completed' },
          { path: 'C:\\Windows\\Temp\\small', category: 'temp_files', sizeBytes: 512, status: 'skipped_locked' },
          { path: 'C:\\nope', category: 'temp_files', sizeBytes: 0, status: 'rejected' },
          { path: 'C:\\Users\\a\\Cache\\c', category: 'browser_cache', sizeBytes: 1024, status: 'failed', error: 'denied' },
        ],
      },
    }));
    render(<CleanupPanel deviceId="dev-1" volumeLabel="C:\\" preview={preview()} onExecuted={vi.fn()} />);

    await userEvent.click(screen.getByTestId('cleanup-category-select-all-temp_files'));
    await userEvent.click(screen.getByTestId('cleanup-execute'));
    await userEvent.click(await screen.findByTestId('cleanup-confirm-button'));

    const result = await screen.findByTestId('cleanup-result');
    expect(within(result).getByTestId('cleanup-count-completed')).toHaveTextContent('1');
    expect(within(result).getByTestId('cleanup-count-skipped_locked')).toHaveTextContent('1');
    expect(within(result).getByTestId('cleanup-count-rejected')).toHaveTextContent('1');
    expect(within(result).getByTestId('cleanup-count-skipped_budget')).toHaveTextContent('0');
    const failures = within(result).getByTestId('cleanup-failures');
    expect(failures.className).toContain('amber');
    expect(failures.className).not.toContain('green');
    expect(within(failures).getByText(/denied/)).toBeInTheDocument();
  });

  it('surfaces a failed execute through runAction and keeps the selection', async () => {
    fetchMock.mockResolvedValue(json({ success: false, error: 'all cleanup actions failed' }, 500));
    const onExecuted = vi.fn();
    render(<CleanupPanel deviceId="dev-1" volumeLabel="C:\\" preview={preview()} onExecuted={onExecuted} />);

    await userEvent.click(screen.getByTestId('cleanup-category-select-all-temp_files'));
    await userEvent.click(screen.getByTestId('cleanup-execute'));
    await userEvent.click(await screen.findByTestId('cleanup-confirm-button'));

    // runAction toasts the failure; the panel must not pretend it succeeded.
    await waitFor(() => expect(showToastMock).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'error' }),
    ));
    expect(onExecuted).not.toHaveBeenCalled();
    expect(screen.queryByTestId('cleanup-result')).not.toBeInTheDocument();
    expect(screen.getByTestId('cleanup-candidate-checkbox-C:\\Windows\\Temp\\big')).toBeChecked();
  });

  it('states that trash targets delete their contents at execution time', async () => {
    render(<CleanupPanel deviceId="dev-1" volumeLabel="C:\\" preview={preview()} onExecuted={vi.fn()} />);
    await userEvent.click(screen.getByTestId('cleanup-category-select-all-temp_files'));
    await userEvent.click(screen.getByTestId('cleanup-execute'));

    const dialog = await screen.findByTestId('cleanup-confirm-dialog');
    expect(within(dialog).getByTestId('cleanup-confirm-contents-note'))
      .toHaveTextContent('at the moment this runs');
  });

  it('translates a 409 preview_expired instead of toasting the raw token', async () => {
    fetchMock.mockResolvedValue(json({ success: false, error: 'preview_expired' }, 409));
    render(<CleanupPanel deviceId="dev-1" volumeLabel="C:\\" preview={preview()} onExecuted={vi.fn()} />);

    await userEvent.click(screen.getByTestId('cleanup-category-select-all-temp_files'));
    await userEvent.click(screen.getByTestId('cleanup-execute'));
    await userEvent.click(await screen.findByTestId('cleanup-confirm-button'));

    await waitFor(() => expect(showToastMock).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'error',
        message: 'This cleanup preview is more than 24 hours old. Run Cleanup Preview again.',
      }),
    ));
  });

  it.each([200, 500])('discards a stale execute response (%s) after replacing the volume preview', async (status) => {
    let finish!: (response: Response) => void;
    fetchMock.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const onExecuted = vi.fn();
    const view = render(<CleanupPanel deviceId="dev-1" volumeLabel="C:" preview={preview()} onExecuted={onExecuted} />);
    await userEvent.click(screen.getByTestId('cleanup-category-select-all-temp_files'));
    await userEvent.click(screen.getByTestId('cleanup-execute'));
    await userEvent.click(await screen.findByTestId('cleanup-confirm-button'));
    view.rerender(<CleanupPanel deviceId="dev-1" volumeLabel="D:" preview={preview({ cleanupRunId: 'new-run', scanPath: 'D:', candidates: [{ path: 'D:/temp/new', category: 'temp_files', sizeBytes: 1 }] })} onExecuted={onExecuted} />);
    await userEvent.click(screen.getByTestId('cleanup-category-select-all-temp_files'));
    await act(async () => finish(json({ success: status === 200, error: 'cleanup_finalize_failed', data: {
      cleanupRunId: RUN_ID, status: 'executed', bytesReclaimed: 2048, actions: [],
    } }, status)));
    expect(screen.queryByTestId('cleanup-result')).not.toBeInTheDocument();
    expect(screen.getByTestId('cleanup-candidate-checkbox-D:/temp/new')).toBeChecked();
    expect(onExecuted).not.toHaveBeenCalled();
  });

  it('states the whole candidate set and its reclaimable size, not just the selection', () => {
    render(<CleanupPanel deviceId="dev-1" volumeLabel="C:\\" preview={preview()} onExecuted={vi.fn()} />);
    // Issue #6376: the operator could not tell how much the preview offered in
    // total, only how much they had ticked.
    expect(screen.getByTestId('cleanup-preview-summary')).toHaveTextContent('3 candidates');
    expect(screen.getByTestId('cleanup-preview-summary')).toHaveTextContent('3.0 KB reclaimable');
  });

  it('counts what it actually rendered, not the server-reported candidateCount', () => {
    // The summary sits above the list it describes, so it must agree with that
    // list. Sourcing it from `candidateCount` would let the two disagree and
    // recreate exactly the #6376 confusion (a stated total the operator cannot
    // reach) rather than reporting it.
    render(
      <CleanupPanel
        deviceId="dev-1"
        volumeLabel="C:\\"
        preview={preview({ candidateCount: 99 })}
        onExecuted={vi.fn()}
      />,
    );
    expect(screen.getByTestId('cleanup-preview-summary')).toHaveTextContent('3 candidates');
    expect(screen.getAllByTestId(/^cleanup-candidate-C/)).toHaveLength(3);
  });

  it('says so when a preview came back with nothing to clean', () => {
    render(
      <CleanupPanel
        deviceId="dev-1"
        volumeLabel="C:\\"
        preview={preview({ candidates: [], categories: [], candidateCount: 0, estimatedBytes: 0 })}
        onExecuted={vi.fn()}
      />,
    );
    expect(screen.getByTestId('cleanup-no-candidates')).toBeInTheDocument();
  });

  it('clears the selection when the preview is replaced', () => {
    const { rerender } = render(
      <CleanupPanel deviceId="dev-1" volumeLabel="C:\\" preview={preview()} onExecuted={vi.fn()} />,
    );
    // A new preview pins a NEW run; carrying a stale selection across it would
    // submit paths that belong to a different pinned candidate set.
    rerender(
      <CleanupPanel
        deviceId="dev-1"
        volumeLabel="D:\\"
        preview={preview({ cleanupRunId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', candidates: [] , categories: [] })}
        onExecuted={vi.fn()}
      />,
    );
    expect(screen.getByTestId('cleanup-execute')).toBeDisabled();
  });
  it.each(['partial', 'failed', 'cleanup_dispatch_failed', 'cleanup_finalize_failed', 'all cleanup actions failed'])('renders terminal %s outcomes without success feedback', async (outcome) => {
    const data = { cleanupRunId: RUN_ID, status: outcome === 'partial' ? 'executed' : 'failed', bytesReclaimed: 0,
      actions: [{ path: '/bin', status: outcome === 'partial' ? 'partial' : outcome === 'all cleanup actions failed' ? 'failed' : 'completed', failedChildren: ['/bin/locked child'], skippedLinkCount: 2 }] };
    const terminalError = outcome.startsWith('cleanup_') || outcome === 'all cleanup actions failed';
    fetchMock.mockResolvedValue(json({ success: !terminalError, error: terminalError ? outcome : undefined, data }, terminalError ? 500 : 200));
    const onExecuted = vi.fn();
    render(<CleanupPanel deviceId="dev-1" volumeLabel="C:" preview={preview()} onExecuted={onExecuted} />);
    await userEvent.click(screen.getByTestId('cleanup-category-select-all-temp_files'));
    await userEvent.click(screen.getByTestId('cleanup-execute'));
    await userEvent.click(await screen.findByTestId('cleanup-confirm-button'));
    expect(await screen.findByTestId('cleanup-result')).toBeInTheDocument();
    expect(onExecuted).toHaveBeenCalled();
    expect(screen.getByTestId('cleanup-execute')).toBeDisabled();
    expect(showToastMock.mock.calls.some(([toast]) => toast.type === 'success')).toBe(false);
    if (outcome === 'partial') {
      expect(screen.getByTestId('cleanup-count-partial')).toHaveTextContent('1');
      expect(screen.getByTestId('cleanup-failures')).toHaveTextContent('locked child');
      expect(screen.getByTestId('cleanup-failures')).toHaveTextContent('2');
    } else expect(screen.getByTestId('cleanup-result')).toHaveTextContent('Cleanup failed');
    if (outcome === 'all cleanup actions failed') expect(screen.getByTestId('cleanup-failures')).toHaveTextContent('/bin');
  });
  it.each(['agent_update_required', 'cleanup_run_required', 'volume_required'])('translates %s', async (error) => {
    fetchMock.mockResolvedValue(json({ error, data: { minAgentVersion: '2.4.0' } }, 409));
    render(<CleanupPanel deviceId="dev-1" volumeLabel="C:" preview={preview()} onExecuted={vi.fn()} />);
    await userEvent.click(screen.getByTestId('cleanup-category-select-all-temp_files'));
    await userEvent.click(screen.getByTestId('cleanup-execute'));
    await userEvent.click(await screen.findByTestId('cleanup-confirm-button'));
    expect(showToastMock.mock.calls[0][0].message).not.toBe(error);
    if (error === 'agent_update_required') expect(showToastMock.mock.calls[0][0].message).toContain('2.4.0');
  });

});
