import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import RestoreWizard from './RestoreWizard';
import { formatDateTime } from '@/lib/dateTimeFormat';
import { fetchWithAuth } from '../../stores/auth';

vi.mock('../../stores/auth', () => ({
  fetchWithAuth: vi.fn(),
}));
const showToastMock = vi.fn();
vi.mock('../shared/Toast', () => ({ showToast: (input: unknown) => showToastMock(input) }));

const fetchMock = vi.mocked(fetchWithAuth);

const makeJsonResponse = (payload: unknown, ok = true, status = ok ? 200 : 500): Response =>
  ({
    ok,
    status,
    statusText: ok ? 'OK' : 'ERROR',
    json: vi.fn().mockResolvedValue(payload),
  }) as unknown as Response;

describe('RestoreWizard', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('shows restore history and renders the latest restore job after creation', async () => {
    fetchMock.mockImplementation(async (input, init) => {
      const url = String(input);
      const method = init?.method ?? 'GET';

      if (url === '/backup/snapshots') {
        return makeJsonResponse({
          data: [
            {
              id: 'snap-1',
              label: 'Server snapshot',
              deviceName: 'RECEPTION-PC',
              status: 'Ready',
              size: '4 GB',
            },
          ],
        });
      }

      if (url === '/backup/snapshots/snap-1/browse') {
        return makeJsonResponse({ data: [] });
      }

      if (url === '/backup/restore?limit=6') {
        return makeJsonResponse({
          data: [
            {
              id: 'restore-1',
              snapshotId: 'snap-1',
              deviceId: 'device-1',
              deviceName: 'FRONT-DESK-01',
              restoreType: 'full',
              status: 'completed',
              targetPath: null,
              createdAt: '2026-03-31T10:00:00.000Z',
              updatedAt: '2026-03-31T10:10:00.000Z',
              startedAt: '2026-03-31T10:01:00.000Z',
              completedAt: '2026-03-31T10:10:00.000Z',
              restoredSize: 2048,
              restoredFiles: 3,
              errorSummary: null,
              resultDetails: { status: 'completed' },
            },
          ],
        });
      }

      if (url === '/backup/restore' && method === 'POST') {
        return makeJsonResponse({
          id: 'restore-2',
          snapshotId: 'snap-1',
          deviceId: 'device-1',
          restoreType: 'full',
          status: 'pending',
          targetPath: null,
          createdAt: '2026-03-31T11:00:00.000Z',
          updatedAt: '2026-03-31T11:00:00.000Z',
          startedAt: null,
          completedAt: null,
          restoredSize: null,
          restoredFiles: null,
          commandId: 'cmd-1',
          errorSummary: null,
          resultDetails: null,
        });
      }

      return makeJsonResponse({}, false, 404);
    });

    render(<RestoreWizard />);

    await screen.findByText('Restore Wizard');
    expect(await screen.findByText('Recent restore history')).toBeTruthy();
    expect(screen.getByText('FRONT-DESK-01')).toBeTruthy();
    expect(screen.queryByText('restore-1')).toBeNull();

    for (let index = 0; index < 4; index += 1) {
      fireEvent.click(screen.getByRole('button', { name: /Continue/i }));
    }

    fireEvent.click(screen.getByRole('button', { name: /Start restore/i }));

    // A readable confirmation naming the device, never the raw job UUID.
    const banner = await screen.findByTestId('restore-success-banner');
    expect(banner.textContent).toContain('Restore queued on RECEPTION-PC.');
    expect(banner.textContent).not.toContain('restore-2');
    expect(screen.getByText('Latest restore job')).toBeTruthy();
    expect(screen.getByText(/pending/i)).toBeTruthy();

    // "View progress" takes the operator to the Latest restore job panel.
    const scrollIntoView = vi.fn();
    Element.prototype.scrollIntoView = scrollIntoView;
    fireEvent.click(screen.getByRole('button', { name: /View progress/i }));
    expect(scrollIntoView).toHaveBeenCalledTimes(1);
    expect(scrollIntoView.mock.contexts[0]).toBe(screen.getByTestId('restore-latest-job'));
  });

  it('asks for confirmation before restoring a backup without an integrity attestation, then resubmits', async () => {
    let posts = 0;
    fetchMock.mockImplementation(async (input, init) => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      if (url === '/backup/snapshots') return makeJsonResponse({ data: [{ id: 'snap-1', label: 'Server snapshot', deviceName: 'RECEPTION-PC' }] });
      if (url === '/backup/snapshots/snap-1/browse') return makeJsonResponse({ data: [] });
      if (url === '/backup/restore?limit=6') return makeJsonResponse({ data: [] });
      if (url === '/backup/restore' && method === 'POST') {
        posts += 1;
        if (posts === 1) return makeJsonResponse({
          error: 'Confirm the restore.',
          code: 'STEP_UP_REQUIRED',
          stepUp: {
            operation: 'backup_unattested_restore',
            method: 'confirm',
            reason: 'unattested_legacy',
            resource: { snapshotId: 'snapshot-1', targetDeviceId: 'device-1', commandType: 'bmr_recover' },
          },
        }, false, 403);
        return makeJsonResponse({ id: 'restore-2', snapshotId: 'snap-1', status: 'pending', restoreType: 'full' });
      }
      return makeJsonResponse({}, false, 404);
    });

    render(<RestoreWizard />);
    await screen.findByText('Restore Wizard');
    for (let index = 0; index < 4; index += 1) {
      fireEvent.click(screen.getByRole('button', { name: /Continue/i }));
    }
    fireEvent.click(screen.getByRole('button', { name: /Start restore/i }));

    const prompt = await screen.findByTestId('unattested-restore-stepup');
    expect(prompt.textContent).toMatch(/no integrity attestation/i);
    expect(showToastMock).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'error' }));
    expect(screen.queryByTestId('restore-success-banner')).toBeNull();

    fireEvent.click(screen.getByTestId('unattested-restore-stepup-confirm'));
    await screen.findByTestId('restore-success-banner');
    const bodies = fetchMock.mock.calls
      .filter(([url, init]) => url === '/backup/restore' && init?.method === 'POST')
      .map(([, init]) => JSON.parse(String(init!.body)));
    expect(bodies).toHaveLength(2);
    expect(bodies[0]).not.toHaveProperty('confirmUnattestedRestore');
    expect(bodies[1]).toMatchObject({ snapshotId: 'snap-1', confirmUnattestedRestore: true });
  });

  it('shows each snapshot\'s integrity status on its card and in the review', async () => {
    fetchMock.mockImplementation(async (input) => {
      const url = String(input);
      if (url === '/backup/snapshots') {
        return makeJsonResponse({ data: [
          { id: 'snap-1', label: 'Server snapshot', integrityStatus: 'unattested_legacy' },
          { id: 'snap-2', label: 'Newer snapshot', integrityStatus: 'attested' },
          { id: 'snap-3', label: 'Old API snapshot' },
        ] });
      }
      if (url === '/backup/restore?limit=6') return makeJsonResponse({ data: [] });
      return makeJsonResponse({ data: [] });
    });

    render(<RestoreWizard />);
    await screen.findByText('Server snapshot');
    const labels = screen.getAllByTestId('snapshot-integrity-badge').map((el) => el.textContent);
    expect(labels).toEqual(['Not verified', 'Verified']);

    for (let index = 0; index < 4; index += 1) {
      fireEvent.click(screen.getByRole('button', { name: /Continue/i }));
    }
    expect(screen.getByTestId('restore-review-snapshot').textContent).toContain('Not verified');
  });

  it('cancels a queued restore from the Latest restore job panel', async () => {
    const pendingJob = {
      id: 'restore-2',
      snapshotId: 'snap-1',
      deviceId: 'device-1',
      deviceName: 'FRONT-DESK-01',
      restoreType: 'full',
      status: 'pending',
      targetPath: null,
      createdAt: '2026-03-31T11:00:00.000Z',
      updatedAt: '2026-03-31T11:00:00.000Z',
      restoredSize: null,
      restoredFiles: null,
      commandId: 'cmd-1',
      errorSummary: null,
      resultDetails: null,
    };
    let history: unknown[] = [pendingJob];
    fetchMock.mockImplementation(async (input, init) => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      if (url === '/backup/snapshots') return makeJsonResponse({ data: [{ id: 'snap-1', label: 'Server snapshot' }] });
      if (url === '/backup/snapshots/snap-1/browse') return makeJsonResponse({ data: [] });
      if (url === '/backup/restore?limit=6') return makeJsonResponse({ data: history });
      if (url === '/backup/restore/restore-2/cancel' && method === 'POST') {
        const cancelled = { ...pendingJob, status: 'cancelled', errorSummary: 'Cancelled by user' };
        history = [cancelled];
        return makeJsonResponse({ data: cancelled });
      }
      return makeJsonResponse({}, false, 404);
    });

    render(<RestoreWizard />);

    const cancel = await screen.findByRole('button', { name: /Cancel restore/i });
    fireEvent.click(cancel);

    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith('/backup/restore/restore-2/cancel', expect.objectContaining({ method: 'POST' }))
    );
    await waitFor(() => expect(showToastMock).toHaveBeenCalledWith(expect.objectContaining({ type: 'success', message: 'Restore cancelled.' })));
    await waitFor(() => expect(screen.queryByRole('button', { name: /Cancel restore/i })).toBeNull());
  });

  it('surfaces the stop-signal warning when a running restore is cancelled but the agent was not reached', async () => {
    const runningJob = {
      id: 'restore-3',
      snapshotId: 'snap-1',
      deviceId: 'device-1',
      restoreType: 'full',
      status: 'running',
      createdAt: '2026-03-31T11:00:00.000Z',
      updatedAt: '2026-03-31T11:00:00.000Z',
    };
    fetchMock.mockImplementation(async (input, init) => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      if (url === '/backup/snapshots') return makeJsonResponse({ data: [{ id: 'snap-1', label: 'Server snapshot' }] });
      if (url === '/backup/snapshots/snap-1/browse') return makeJsonResponse({ data: [] });
      if (url === '/backup/restore?limit=6') return makeJsonResponse({ data: [runningJob] });
      if (url === '/backup/restore/restore-3/cancel' && method === 'POST') {
        return makeJsonResponse({
          data: { ...runningJob, status: 'cancelled' },
          warning: 'Restore marked as cancelled but the stop signal could not be delivered to the agent.',
        });
      }
      return makeJsonResponse({}, false, 404);
    });

    render(<RestoreWizard />);
    fireEvent.click(await screen.findByRole('button', { name: /Cancel restore/i }));

    await waitFor(() => expect(showToastMock).toHaveBeenCalledWith(expect.objectContaining({
      type: 'warning',
      message: 'Restore marked as cancelled but the stop signal could not be delivered to the agent.',
    })));
    // Partial success: the warning replaces the clean "Restore cancelled." toast.
    expect(showToastMock).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'success' }));
  });

  it.each([
    { restoreMode: 'rebuild', label: 'Rebuild to VHDX' },
    { restoreMode: 'vm', label: 'Restore as VM' },
    { restoreMode: 'instant_boot', label: 'Instant boot' },
  ])('offers no Cancel for a queued $restoreMode job (it has its own lifecycle)', async ({ restoreMode, label }) => {
    fetchMock.mockImplementation(async (input) => {
      const url = String(input);
      if (url === '/backup/snapshots') return makeJsonResponse({ data: [{ id: 'snap-1', label: 'Server snapshot' }] });
      if (url === '/backup/snapshots/snap-1/browse') return makeJsonResponse({ data: [] });
      if (url === '/backup/restore?limit=6') {
        return makeJsonResponse({ data: [{ id: 'restore-9', snapshotId: 'snap-1', deviceId: 'device-1', deviceName: 'HV-HOST', restoreType: 'full', restoreMode, status: 'pending', createdAt: '2026-03-31T10:00:00.000Z', updatedAt: '2026-03-31T10:00:00.000Z' }] });
      }
      return makeJsonResponse({}, false, 404);
    });

    render(<RestoreWizard />);
    expect(await screen.findByText(new RegExp(`^${label} ·`))).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Cancel restore/i })).toBeNull();
  });

  it('offers no Cancel for a restore that already finished', async () => {
    fetchMock.mockImplementation(async (input) => {
      const url = String(input);
      if (url === '/backup/snapshots') return makeJsonResponse({ data: [{ id: 'snap-1', label: 'Server snapshot' }] });
      if (url === '/backup/snapshots/snap-1/browse') return makeJsonResponse({ data: [] });
      if (url === '/backup/restore?limit=6') {
        return makeJsonResponse({ data: [{ id: 'restore-1', snapshotId: 'snap-1', deviceId: 'device-1', restoreType: 'full', status: 'completed', createdAt: '2026-03-31T10:00:00.000Z', updatedAt: '2026-03-31T10:10:00.000Z' }] });
      }
      return makeJsonResponse({}, false, 404);
    });

    render(<RestoreWizard />);
    await screen.findByText('Latest restore job');
    expect(screen.queryByRole('button', { name: /Cancel restore/i })).toBeNull();
  });

  it('surfaces the restore API error when restore startup fails', async () => {
    fetchMock.mockImplementation(async (input, init) => {
      const url = String(input);
      const method = init?.method ?? 'GET';

      if (url === '/backup/snapshots') {
        return makeJsonResponse({
          data: [
            {
              id: 'snap-1',
              label: 'Server snapshot',
              status: 'Ready',
              size: '4 GB',
            },
          ],
        });
      }

      if (url === '/backup/snapshots/snap-1/browse') {
        return makeJsonResponse({ data: [] });
      }

      if (url === '/backup/restore?limit=6') {
        return makeJsonResponse({ data: [] });
      }

      if (url === '/backup/restore' && method === 'POST') {
        return makeJsonResponse({
          error: 'Device is offline, cannot execute command',
        }, false, 409);
      }

      return makeJsonResponse({}, false, 404);
    });

    render(<RestoreWizard />);

    await screen.findByText('Restore Wizard');

    for (let index = 0; index < 4; index += 1) {
      fireEvent.click(screen.getByRole('button', { name: /Continue/i }));
    }

    fireEvent.click(screen.getByRole('button', { name: /Start restore/i }));

    await waitFor(() => {
      expect(screen.getByText('Device is offline, cannot execute command')).toBeTruthy();
    });
  });

  it('hydrates the latest restore job from restore history before a new restore is started', async () => {
    fetchMock.mockImplementation(async (input) => {
      const url = String(input);

      if (url === '/backup/snapshots') {
        return makeJsonResponse({
          data: [
            {
              id: 'snap-1',
              label: 'Server snapshot',
              status: 'Ready',
              size: '4 GB',
            },
          ],
        });
      }

      if (url === '/backup/snapshots/snap-1/browse') {
        return makeJsonResponse({ data: [] });
      }

      if (url === '/backup/restore?limit=6') {
        return makeJsonResponse({
          data: [
            {
              id: 'restore-history-1',
              snapshotId: 'snap-1',
              deviceId: 'device-1',
              restoreType: 'full',
              status: 'running',
              targetPath: '/restore-target',
              createdAt: '2026-03-31T11:00:00.000Z',
              updatedAt: '2026-03-31T11:05:00.000Z',
              startedAt: '2026-03-31T11:01:00.000Z',
              completedAt: null,
              restoredSize: 1024,
              restoredFiles: 2,
              commandId: 'cmd-history-1',
              errorSummary: null,
              resultDetails: { status: 'running' },
            },
          ],
        });
      }

      return makeJsonResponse({}, false, 404);
    });

    render(<RestoreWizard />);

    await screen.findByText('Latest restore job');
    expect(screen.getAllByText('running').length).toBeGreaterThan(0);
    expect(screen.getByText(/Command: cmd-history-1/i)).toBeTruthy();
    expect(screen.getByText(/Target path: \/restore-target/i)).toBeTruthy();
  });

  const renderWithLatestResult = async (resultDetails: Record<string, unknown>, status = 'completed') => {
    fetchMock.mockImplementation(async (input) => {
      const url = String(input);
      if (url === '/backup/snapshots') {
        return makeJsonResponse({ data: [{ id: 'snap-1', label: 'Server snapshot', size: '4 GB' }] });
      }
      if (url === '/backup/snapshots/snap-1/browse') return makeJsonResponse({ data: [] });
      if (url === '/backup/restore?limit=6') {
        return makeJsonResponse({
          data: [{
            id: 'restore-q',
            snapshotId: 'snap-1',
            deviceId: 'device-1',
            restoreType: 'full',
            status,
            targetPath: null,
            createdAt: '2026-03-31T11:00:00.000Z',
            updatedAt: '2026-03-31T11:05:00.000Z',
            completedAt: '2026-03-31T11:05:00.000Z',
            restoredSize: 1024,
            restoredFiles: 3,
            commandId: 'cmd-q',
            errorSummary: null,
            resultDetails,
          }],
        });
      }
      return makeJsonResponse({}, false, 404);
    });
    render(<RestoreWizard />);
    await screen.findByText('Latest restore job');
  };

  it('shows the restricted-descriptor count and a collapsible path list', async () => {
    await renderWithLatestResult({
      status: 'completed',
      securityDescriptorQuarantined: 3,
      securityDescriptorQuarantinedPaths: ['C:\\Data\\a.txt', 'C:\\Data\\b.txt'],
    });

    const notice = await screen.findByTestId('restore-result-restricted-descriptors');
    expect(notice.textContent).toContain('3');
    const list = screen.getByTestId('restore-result-restricted-descriptors-paths');
    expect(list.tagName).toBe('DETAILS');
    expect(list.textContent).toContain('C:\\Data\\a.txt');
    expect(list.textContent).toContain('C:\\Data\\b.txt');
    // The count exceeds the listed paths — say so rather than implying the list is complete.
    expect(screen.getByTestId('restore-result-restricted-descriptors-unlisted').textContent).toContain('1');
  });

  it('shows the restricted-descriptor count without a list when the helper sent none', async () => {
    await renderWithLatestResult({ status: 'completed', securityDescriptorQuarantined: 4 });
    expect((await screen.findByTestId('restore-result-restricted-descriptors')).textContent).toContain('4');
    expect(screen.queryByTestId('restore-result-restricted-descriptors-paths')).toBeNull();
  });

  it('renders no restricted-descriptor notice for a result without the fields', async () => {
    await renderWithLatestResult({ status: 'completed' });
    expect(screen.queryByTestId('restore-result-restricted-descriptors')).toBeNull();
    expect(screen.queryByTestId('restore-result-restricted-descriptors')).toBeNull();
  });

  it('blocks the restore until an alternate destination path is typed (#6349)', async () => {
    // The wizard shipped with the demo path '/restore/nyc-db-14' pre-filled.
    // It was unreachable so nobody saw it; mounted, that is a restore pointed
    // at the wrong directory one click away.
    fetchMock.mockImplementation(async (input) => {
      const url = String(input);
      if (url === '/backup/snapshots') {
        return makeJsonResponse({ data: [{ id: 'snap-1', label: 'Server snapshot', status: 'Ready', size: '4 GB' }] });
      }
      if (url === '/backup/snapshots/snap-1/browse') return makeJsonResponse({ data: [] });
      if (url === '/backup/restore?limit=6') return makeJsonResponse({ data: [] });
      return makeJsonResponse({}, false, 404);
    });

    render(<RestoreWizard />);
    await screen.findByText('Restore Wizard');

    for (let index = 0; index < 3; index += 1) {
      fireEvent.click(screen.getByRole('button', { name: /Continue/i }));
    }

    fireEvent.click(screen.getByRole('button', { name: /Alternate path/i }));

    const input = screen.getByLabelText('Alternate path') as HTMLInputElement;
    expect(input.value).toBe('');

    fireEvent.click(screen.getByRole('button', { name: /Continue/i }));
    const start = screen.getByRole('button', { name: /Start restore/i }) as HTMLButtonElement;
    expect(start.disabled).toBe(true);

    fireEvent.click(screen.getByRole('button', { name: /Back/i }));
    fireEvent.change(screen.getByLabelText('Alternate path'), { target: { value: '/var/restore' } });
    fireEvent.click(screen.getByRole('button', { name: /Continue/i }));

    expect((screen.getByRole('button', { name: /Start restore/i }) as HTMLButtonElement).disabled).toBe(false);
  });

  it('toasts a failed restore through runAction, not just the inline banner (#6349)', async () => {
    fetchMock.mockImplementation(async (input, init) => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      if (url === '/backup/snapshots') {
        return makeJsonResponse({ data: [{ id: 'snap-1', label: 'Server snapshot', status: 'Ready', size: '4 GB' }] });
      }
      if (url === '/backup/snapshots/snap-1/browse') return makeJsonResponse({ data: [] });
      if (url === '/backup/restore?limit=6') return makeJsonResponse({ data: [] });
      if (url === '/backup/restore' && method === 'POST') {
        return makeJsonResponse({ error: 'Device is offline, cannot execute command' }, false, 409);
      }
      return makeJsonResponse({}, false, 404);
    });

    render(<RestoreWizard />);
    await screen.findByText('Restore Wizard');

    for (let index = 0; index < 4; index += 1) {
      fireEvent.click(screen.getByRole('button', { name: /Continue/i }));
    }
    fireEvent.click(screen.getByRole('button', { name: /Start restore/i }));

    await waitFor(() => {
      expect(showToastMock).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'error', message: 'Device is offline, cannot execute command' }),
      );
    });
  });

  it('pre-populates the snapshot + selective-file selection carried from SnapshotBrowser (#6456)', async () => {
    fetchMock.mockImplementation(async (input) => {
      const url = String(input);
      if (url === '/backup/snapshots') {
        return makeJsonResponse({
          data: [
            { id: 'snap-1', label: 'Server snapshot', status: 'Ready', size: '4 GB' },
            { id: 'snap-2', label: 'Other snapshot', status: 'Ready', size: '2 GB' },
          ],
        });
      }
      if (url === '/backup/snapshots/snap-2/browse') {
        return makeJsonResponse({
          data: [
            { name: 'report.txt', path: '/Documents/report.txt', type: 'file', sizeBytes: 10 },
            { name: 'notes.txt', path: '/Documents/notes.txt', type: 'file', sizeBytes: 20 },
          ],
        });
      }
      if (url === '/backup/restore?limit=6') return makeJsonResponse({ data: [] });
      return makeJsonResponse({}, false, 404);
    });

    render(
      <RestoreWizard
        initialSnapshotId="snap-2"
        initialSelectedPaths={['/Documents/report.txt']}
      />
    );

    await screen.findByText('Restore Wizard');

    // Step 0: the carried snapshot is selected, not the first one in the list.
    expect(screen.getByRole('button', { name: /Other snapshot/i }).className).toContain('border-primary');

    fireEvent.click(screen.getByRole('button', { name: /Continue/i }));
    // Step 1: restore type defaults to selective because paths were carried.
    expect(screen.getByRole('button', { name: /Selective Restore/i }).className).toContain('border-primary');

    fireEvent.click(screen.getByRole('button', { name: /Continue/i }));
    // Step 2: the carried file is pre-checked without the operator re-selecting it.
    const checkbox = await screen.findByRole('checkbox', { name: /report\.txt/i });
    expect((checkbox as HTMLInputElement).checked).toBe(true);
  });

  it('formats the snapshot size from the real API field (sizeBytes) instead of showing "--" (#6496)', async () => {
    // The real /backup/snapshots response carries `sizeBytes` (a number), never
    // a pre-formatted `size` string — reading `snapshot.size` always fell back
    // to '--' in production.
    fetchMock.mockImplementation(async (input) => {
      const url = String(input);
      if (url === '/backup/snapshots') {
        return makeJsonResponse({
          data: [{ id: 'snap-1', label: 'Server snapshot', sizeBytes: 1181116006 }],
        });
      }
      if (url === '/backup/snapshots/snap-1/browse') return makeJsonResponse({ data: [] });
      if (url === '/backup/restore?limit=6') return makeJsonResponse({ data: [] });
      return makeJsonResponse({}, false, 404);
    });

    render(<RestoreWizard />);
    await screen.findByText('Restore Wizard');

    expect(await screen.findByText('1.10 GB')).toBeTruthy();
    expect(screen.queryByText('--')).toBeNull();
  });

  it('shows the snapshot capture time instead of a hard-coded "Ready" status (#6496)', async () => {
    // /backup/snapshots carries no status field; the card used to print a
    // fabricated "Ready" for every row. It now shows the real createdAt.
    const createdAt = '2026-09-20T14:08:00.000Z';
    fetchMock.mockImplementation(async (input) => {
      const url = String(input);
      if (url === '/backup/snapshots') {
        return makeJsonResponse({
          data: [{ id: 'snap-1', label: 'Server snapshot', sizeBytes: 1024, createdAt }],
        });
      }
      if (url === '/backup/snapshots/snap-1/browse') return makeJsonResponse({ data: [] });
      if (url === '/backup/restore?limit=6') return makeJsonResponse({ data: [] });
      return makeJsonResponse({}, false, 404);
    });

    render(<RestoreWizard />);
    await screen.findByText('Server snapshot');

    expect(screen.queryByText('Ready')).toBeNull();
    expect(screen.getByText(formatDateTime(createdAt))).toBeTruthy();
  });

  it('renders no status text when the snapshot has no createdAt (#6496)', async () => {
    fetchMock.mockImplementation(async (input) => {
      const url = String(input);
      if (url === '/backup/snapshots') {
        return makeJsonResponse({
          data: [{ id: 'snap-1', label: 'Server snapshot', sizeBytes: 1024, createdAt: null }],
        });
      }
      if (url === '/backup/snapshots/snap-1/browse') return makeJsonResponse({ data: [] });
      if (url === '/backup/restore?limit=6') return makeJsonResponse({ data: [] });
      return makeJsonResponse({}, false, 404);
    });

    render(<RestoreWizard />);
    const label = await screen.findByText('Server snapshot');

    const meta = label.previousElementSibling as HTMLElement;
    expect(meta.children).toHaveLength(1);
    expect(meta.textContent).toBe('1.00 KB');
    expect(screen.queryByText('Ready')).toBeNull();
  });

  it('formats snapshot file sizes as bytes/KB/MB instead of raw byte counts (#6496)', async () => {
    fetchMock.mockImplementation(async (input) => {
      const url = String(input);
      if (url === '/backup/snapshots') {
        return makeJsonResponse({
          data: [{ id: 'snap-1', label: 'Server snapshot', sizeBytes: 2097152 }],
        });
      }
      if (url === '/backup/snapshots/snap-1/browse') {
        return makeJsonResponse({
          data: [{ name: 'db.bak', path: '/db.bak', type: 'file', sizeBytes: 2097152 }],
        });
      }
      if (url === '/backup/restore?limit=6') return makeJsonResponse({ data: [] });
      return makeJsonResponse({}, false, 404);
    });

    render(<RestoreWizard />);
    await screen.findByText('Restore Wizard');

    fireEvent.click(screen.getByRole('button', { name: /Continue/i }));
    fireEvent.click(screen.getByRole('button', { name: /Selective restore/i }));
    fireEvent.click(screen.getByRole('button', { name: /Continue/i }));

    expect(await screen.findByText('2.00 MB')).toBeTruthy();
    expect(screen.queryByText('2097152 B')).toBeNull();
  });

  it('does not claim the default destination restores in place (#2562)', async () => {
    // With no targetPath the agent writes under <temp>/breeze-restore/<source
    // path> and never touches the originals. The card used to be labelled
    // "Original location — Restore files in place", which is the opposite.
    fetchMock.mockImplementation(async (input) => {
      const url = String(input);
      if (url === '/backup/snapshots') {
        return makeJsonResponse({ data: [{ id: 'snap-1', label: 'Server snapshot', sizeBytes: 1024 }] });
      }
      if (url === '/backup/snapshots/snap-1/browse') return makeJsonResponse({ data: [] });
      if (url === '/backup/restore?limit=6') return makeJsonResponse({ data: [] });
      return makeJsonResponse({}, false, 404);
    });

    render(<RestoreWizard />);
    await screen.findByText('Restore Wizard');
    for (let index = 0; index < 3; index += 1) {
      fireEvent.click(screen.getByRole('button', { name: /Continue/i }));
    }

    expect(screen.queryByText(/Restore files in place/i)).toBeNull();
    expect(screen.queryByText(/^Original location$/i)).toBeNull();
    expect(screen.getByRole('button', { name: /Staging folder on the device/i })).toBeTruthy();
    expect(screen.getByText(/originals are never overwritten/i)).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: /Continue/i }));
    expect(screen.queryByText(/^Original path$/)).toBeNull();
    expect(screen.getAllByText(/Staging folder on the device/i).length).toBeGreaterThan(0);
  });

  it('echoes the typed alternate destination path on the Review step (#6496)', async () => {
    fetchMock.mockImplementation(async (input) => {
      const url = String(input);
      if (url === '/backup/snapshots') {
        return makeJsonResponse({ data: [{ id: 'snap-1', label: 'Server snapshot', sizeBytes: 4 * 1024 ** 3 }] });
      }
      if (url === '/backup/snapshots/snap-1/browse') return makeJsonResponse({ data: [] });
      if (url === '/backup/restore?limit=6') return makeJsonResponse({ data: [] });
      return makeJsonResponse({}, false, 404);
    });

    render(<RestoreWizard />);
    await screen.findByText('Restore Wizard');

    for (let index = 0; index < 3; index += 1) {
      fireEvent.click(screen.getByRole('button', { name: /Continue/i }));
    }
    fireEvent.click(screen.getByRole('button', { name: /Alternate path/i }));
    fireEvent.change(screen.getByLabelText('Alternate path'), { target: { value: '/var/restore/target' } });
    fireEvent.click(screen.getByRole('button', { name: /Continue/i }));

    expect(await screen.findByText(/\/var\/restore\/target/)).toBeTruthy();
  });

  it('leaves a 401 to the auth redirect instead of banner-ing "Unauthorized" (#6349)', async () => {
    // fetchWithAuth has already kicked off the session-expired redirect by the
    // time runAction sees a 401, so the wizard must stay quiet rather than
    // flashing a meaningless error under a navigating page.
    fetchMock.mockImplementation(async (input, init) => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      if (url === '/backup/snapshots') {
        return makeJsonResponse({ data: [{ id: 'snap-1', label: 'Server snapshot', status: 'Ready', size: '4 GB' }] });
      }
      if (url === '/backup/snapshots/snap-1/browse') return makeJsonResponse({ data: [] });
      if (url === '/backup/restore?limit=6') return makeJsonResponse({ data: [] });
      if (url === '/backup/restore' && method === 'POST') {
        return makeJsonResponse({ error: 'Unauthorized' }, false, 401);
      }
      return makeJsonResponse({}, false, 404);
    });

    render(<RestoreWizard />);
    await screen.findByText('Restore Wizard');

    for (let index = 0; index < 4; index += 1) {
      fireEvent.click(screen.getByRole('button', { name: /Continue/i }));
    }
    const start = screen.getByRole('button', { name: /Start restore/i }) as HTMLButtonElement;
    fireEvent.click(start);

    // The button un-disables once the in-flight flag clears, which is the
    // observable signal that the catch/finally ran.
    await waitFor(() => expect(start.disabled).toBe(false));
    expect(showToastMock).not.toHaveBeenCalled();
    expect(screen.queryByText('Unauthorized')).toBeNull();
  });

  describe('names the device and drops raw internals (#7213)', () => {
    const historyRow = (over: Record<string, unknown>) => ({
      id: '6f1c2b1e-0000-4000-8000-00000000abcd',
      snapshotId: 'snap-1',
      deviceId: 'device-1',
      deviceName: 'FRONT-DESK-01',
      restoreType: 'full',
      restoreMode: null,
      status: 'completed',
      targetPath: null,
      createdAt: '2026-03-31T10:00:00.000Z',
      updatedAt: '2026-03-31T10:10:00.000Z',
      startedAt: null,
      completedAt: null,
      restoredSize: 2048,
      restoredFiles: 3,
      errorSummary: null,
      resultDetails: { status: 'completed', secretInternalKey: 'raw-json-marker' },
      ...over,
    });

    const mockApi = (history: unknown[], browse: unknown[] = []) => {
      fetchMock.mockImplementation(async (input) => {
        const url = String(input);
        if (url === '/backup/snapshots') {
          return makeJsonResponse({
            data: [
              { id: 'snap-1', label: 'Nightly', deviceId: 'device-1', deviceName: 'FRONT-DESK-01', sizeBytes: 1024 },
              { id: 'snap-2', label: 'Nightly', deviceId: 'device-2', deviceName: 'ACCOUNTING-02', sizeBytes: 1024 },
            ],
          });
        }
        if (url.startsWith('/backup/snapshots/') && url.endsWith('/browse')) return makeJsonResponse({ data: browse });
        if (url === '/backup/restore?limit=6') return makeJsonResponse({ data: history });
        return makeJsonResponse({}, false, 404);
      });
    };

    it('names the device on each snapshot card', async () => {
      mockApi([]);
      render(<RestoreWizard />);
      await screen.findByText('Restore Wizard');
      expect(await screen.findByText('FRONT-DESK-01')).toBeTruthy();
      expect(screen.getByText('ACCOUNTING-02')).toBeTruthy();
    });

    it('titles history rows with the device, not the restore job UUID', async () => {
      const row = historyRow({});
      mockApi([row]);
      render(<RestoreWizard />);
      await screen.findByText('Restore Wizard');
      await waitFor(() => expect(screen.getAllByText(/FRONT-DESK-01/).length).toBeGreaterThan(0));
      expect(screen.queryByText(row.id)).toBeNull();
    });

    it('labels VM restores and instant boots by what they are, not "full restore"', async () => {
      mockApi([
        historyRow({ id: 'r-vm', restoreMode: 'vm' }),
        historyRow({ id: 'r-ib', restoreMode: 'instant_boot' }),
      ]);
      render(<RestoreWizard />);
      await screen.findByText('Restore Wizard');
      expect(await screen.findByText(/Restore as VM/i)).toBeTruthy();
      expect(screen.getByText(/Instant boot/i)).toBeTruthy();
    });

    it('does not dump the raw result payload JSON', async () => {
      mockApi([historyRow({})]);
      render(<RestoreWizard />);
      await screen.findByText('Restore Wizard');
      await waitFor(() => expect(screen.getAllByText(/FRONT-DESK-01/).length).toBeGreaterThan(0));
      expect(screen.queryByText('Result payload')).toBeNull();
      expect(screen.queryByText(/raw-json-marker/)).toBeNull();
    });

    it('uses the singular for a single selected file on Review', async () => {
      mockApi([], [{ name: 'a.txt', path: '/a.txt', type: 'file', sizeBytes: 1 }]);
      render(<RestoreWizard />);
      await screen.findByText('Restore Wizard');
      fireEvent.click(screen.getByRole('button', { name: /Continue/i }));
      fireEvent.click(screen.getByRole('button', { name: /Selective Restore/i }));
      fireEvent.click(screen.getByRole('button', { name: /Continue/i }));
      fireEvent.click(await screen.findByRole('checkbox', { name: /a\.txt/i }));
      fireEvent.click(screen.getByRole('button', { name: /Continue/i }));
      fireEvent.click(screen.getByRole('button', { name: /Continue/i }));
      expect(await screen.findByText('1 file selected')).toBeTruthy();
      expect(screen.queryByText('1 files selected')).toBeNull();
    });
  });
});
