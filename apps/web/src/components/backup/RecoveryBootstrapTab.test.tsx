import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import RecoveryBootstrapTab from './RecoveryBootstrapTab';
import { fetchWithAuth } from '../../stores/auth';

vi.mock('../../stores/auth', () => ({
  fetchWithAuth: vi.fn(),
  restoreAccessTokenFromCookie: vi.fn(async () => true),
}));

const fetchMock = vi.mocked(fetchWithAuth);

const makeJsonResponse = (payload: unknown, ok = true, status = ok ? 200 : 500): Response =>
  ({
    ok,
    status,
    statusText: ok ? 'OK' : 'ERROR',
    json: vi.fn().mockResolvedValue(payload),
    blob: vi.fn().mockResolvedValue(new Blob()),
  }) as unknown as Response;

describe('RecoveryBootstrapTab', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.localStorage.clear();
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    Object.assign(navigator, {
      clipboard: {
        writeText: vi.fn().mockResolvedValue(undefined),
      },
    });

    fetchMock.mockImplementation(async (input, init) => {
      const url = String(input);
      const method = (init as RequestInit | undefined)?.method ?? 'GET';

      if (url === '/backup/snapshots') {
        return makeJsonResponse({
          data: [
            {
              id: 'snapshot-1',
              label: 'Nightly Snapshot',
              timestamp: '2026-03-28T10:00:00Z',
              size: 2147483648,
            },
          ],
        });
      }

      if (url === '/backup/bmr/tokens?limit=100' && method === 'GET') {
        return makeJsonResponse({ data: [] });
      }

      if (url === '/backup/bmr/media?limit=100' && method === 'GET') {
        return makeJsonResponse({
          data: [
            {
              id: 'media-verified',
              tokenId: 'token-1',
              snapshotId: 'snapshot-1',
              platform: 'linux',
              architecture: 'amd64',
              status: 'ready_signed',
              checksumSha256: 'bundle-checksum',
              signatureFormat: 'minisign',
              signingKeyId: 'current',
              signedAt: '2026-03-31T10:08:00Z',
              metadata: {
                helperBinaryVersion: 'workspace-local',
                helperBinaryDigestVerified: true,
                helperBinarySourceType: 'local',
                helperBinarySourceRef: 'agent/bin/breeze-backup',
                helperBinaryManifestVersion: '1',
              },
              downloadPath: '/backup/bmr/media/media-verified/download',
              signatureDownloadPath: '/backup/bmr/media/media-verified/signature',
            },
          ],
        });
      }

      if (url === '/backup/bmr/boot-media?limit=100' && method === 'GET') {
        // W04b: GET /bmr/boot-media is now the static, release-built Linux
        // recovery ISO catalog (agent/recovery-media/) — no longer a
        // per-token artifact list.
        return makeJsonResponse({
          data: [
            {
              platform: 'linux',
              arch: 'amd64',
              version: '0.112.0',
              filename: 'breeze-recovery-linux-amd64.iso',
              downloadUrl: '/api/v1/agents/download/recovery-iso/linux/amd64',
              sha256: 'a'.repeat(64),
              size: 419430400,
            },
            {
              platform: 'linux',
              arch: 'arm64',
              version: '0.112.0',
              filename: 'breeze-recovery-linux-arm64.iso',
              downloadUrl: '/api/v1/agents/download/recovery-iso/linux/arm64',
              sha256: null,
              size: null,
            },
          ],
        });
      }

      if (url === '/backup/bmr/tokens' && method === 'POST') {
        return makeJsonResponse({
          id: 'token-1',
          token: 'brz_rec_123',
          deviceId: 'device-1',
          snapshotId: 'snapshot-1',
          restoreType: 'bare_metal',
          status: 'active',
          sessionStatus: 'pending',
          createdAt: '2026-03-31T10:00:00Z',
          expiresAt: '2026-04-01T10:00:00Z',
          bootstrap: {
            version: 1,
            minHelperVersion: '0.5.0',
            serverUrl: window.location.origin,
            releaseUrl: 'https://github.com/lanternops/breeze/releases/latest',
            commandTemplate: `breeze-backup bmr-recover --token <recovery-token> --server "${window.location.origin}"`,
            prerequisites: ['Boot into a recovery environment.'],
          },
        }, true, 201);
      }

      if (url === '/backup/bmr/recover/authenticate' && method === 'POST') {
        return makeJsonResponse({
          tokenId: 'token-1',
          deviceId: 'device-1',
          snapshotId: 'snapshot-1',
          restoreType: 'bare_metal',
          authenticatedAt: '2026-03-31T10:05:00Z',
          bootstrap: {
            version: 1,
            minHelperVersion: '0.5.0',
            serverUrl: window.location.origin,
            releaseUrl: 'https://github.com/lanternops/breeze/releases/latest',
            commandTemplate: `breeze-backup bmr-recover --token <recovery-token> --server "${window.location.origin}"`,
            prerequisites: ['Boot into a recovery environment.'],
            providerType: 's3',
            backupConfig: {
              id: 'cfg-1',
              name: 'Primary S3',
              provider: 's3',
            },
            download: {
              type: 'breeze_proxy',
              method: 'GET',
              url: `${window.location.origin}/api/v1/backup/bmr/recover/download`,
              pathPrefix: 'snapshots/provider-snap-1',
              expiresAt: '2026-03-31T11:05:00Z',
            },
            snapshot: {
              id: 'snap-db-1',
              label: 'Nightly Snapshot',
              timestamp: '2026-03-28T10:00:00Z',
            },
            targetConfig: {
              targetPaths: ['/mnt/recovery'],
            },
          },
        });
      }

      if (url === '/backup/bmr/tokens/token-1' && method === 'GET') {
        return makeJsonResponse({
          id: 'token-1',
          deviceId: 'device-1',
          device: {
            displayName: 'Server 01',
          },
          snapshotId: 'snapshot-1',
          restoreType: 'bare_metal',
          status: 'active',
          sessionStatus: 'pending',
          createdAt: '2026-03-31T10:00:00Z',
          expiresAt: '2026-04-01T10:00:00Z',
          bootstrap: {
            version: 1,
            minHelperVersion: '0.5.0',
            serverUrl: window.location.origin,
            releaseUrl: 'https://github.com/lanternops/breeze/releases/latest',
            commandTemplate: `breeze-backup bmr-recover --token <recovery-token> --server "${window.location.origin}"`,
            prerequisites: ['Boot into a recovery environment.'],
          },
        });
      }

      if (url === '/backup/bmr/tokens/token-active' && method === 'GET') {
        return makeJsonResponse({
          id: 'token-active',
          deviceId: 'device-1',
          snapshotId: 'snapshot-1',
          restoreType: 'full',
          status: 'active',
          sessionStatus: 'pending',
          createdAt: '2026-03-31T08:00:00Z',
          expiresAt: '2026-04-01T08:00:00Z',
          bootstrap: {
            version: 1,
            minHelperVersion: '0.5.0',
            serverUrl: window.location.origin,
            releaseUrl: 'https://github.com/lanternops/breeze/releases/latest',
            commandTemplate: `breeze-backup bmr-recover --token <recovery-token> --server "${window.location.origin}"`,
            prerequisites: ['Boot into a recovery environment.'],
          },
        });
      }

      if (url === '/backup/bmr/tokens/token-expired' && method === 'GET') {
        return makeJsonResponse({
          id: 'token-expired',
          deviceId: 'device-2',
          snapshotId: 'snapshot-1',
          restoreType: 'selective',
          status: 'expired',
          sessionStatus: 'expired',
          createdAt: '2026-03-30T08:00:00Z',
          expiresAt: '2026-03-30T09:00:00Z',
        });
      }

      if (url === '/backup/bmr/tokens/token-active' && method === 'DELETE') {
        return makeJsonResponse({ id: 'token-active', status: 'revoked' });
      }

      if (url === '/backup/bmr/media' && method === 'POST') {
        return makeJsonResponse({
          id: 'media-1',
          tokenId: 'token-1',
          snapshotId: 'snapshot-1',
          platform: 'linux',
          architecture: 'amd64',
          status: 'pending',
          createdAt: '2026-03-31T10:06:00Z',
          completedAt: null,
          metadata: {},
          downloadPath: null,
        }, true, 202);
      }

      return makeJsonResponse({}, false, 404);
    });
  });

  it('creates a token, shows the exact CLI command, and previews the bootstrap bundle', async () => {
    render(<RecoveryBootstrapTab />);

    await screen.findByText('Manual recovery environment');
    await screen.findByText('Nightly Snapshot');
    expect(screen.queryByText(/media builder/i)).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: /Create token/i }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        '/backup/bmr/tokens',
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({
            snapshotId: 'snapshot-1',
            restoreType: 'bare_metal',
            expiresInHours: 24,
          }),
        })
      );
    });

    const expectedCommand = `breeze-backup bmr-recover --token brz_rec_123 --server ${window.location.origin}`;
    expect(await screen.findByText(expectedCommand)).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: /Preview bootstrap bundle/i }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        '/backup/bmr/recover/authenticate',
        expect.objectContaining({
          method: 'POST',
          // The preview reports an enforcing client: it only reads the bootstrap.
          body: JSON.stringify({ token: 'brz_rec_123', integrityProtocolVersion: 2 }),
        })
      );
    });

    expect(await screen.findByText('Bootstrap bundle')).toBeTruthy();
    expect(screen.getByText('s3')).toBeTruthy();
    expect(screen.getByText('Primary S3')).toBeTruthy();
    expect(screen.getByText('breeze_proxy')).toBeTruthy();
    expect(screen.getByText('snapshots/provider-snap-1')).toBeTruthy();
    expect(screen.getByText('Bootable recovery media')).toBeTruthy();
    expect(screen.getByText(/helperBinaryDigestVerified:/)).toBeTruthy();
    // W04b: the boot-media catalog is the static release ISO list — its
    // rows carry a sha256 (rendered directly), not the old per-artifact
    // bootTemplate* trust metadata.
    expect(screen.getByText('breeze-recovery-linux-amd64.iso')).toBeTruthy();
  });

  it('asks for confirmation before creating a token for a backup without an integrity attestation, then resubmits', async () => {
    const base = fetchMock.getMockImplementation()!;
    let tokenPosts = 0;
    fetchMock.mockImplementation(async (input, init) => {
      const method = (init as RequestInit | undefined)?.method ?? 'GET';
      if (String(input) === '/backup/bmr/tokens' && method === 'POST') {
        tokenPosts += 1;
        if (tokenPosts === 1) return makeJsonResponse({
          error: 'Confirm the restore.',
          code: 'STEP_UP_REQUIRED',
          stepUp: {
            operation: 'backup_unattested_restore',
            method: 'confirm',
            reason: 'unattested_legacy',
            resource: { snapshotId: 'snapshot-1', targetDeviceId: 'device-1', commandType: 'bmr_recover' },
          },
        }, false, 403);
      }
      return base(input, init);
    });

    render(<RecoveryBootstrapTab />);
    await screen.findByText('Nightly Snapshot');
    fireEvent.click(screen.getByRole('button', { name: /Create token/i }));

    await screen.findByTestId('unattested-restore-stepup');
    fireEvent.click(screen.getByTestId('unattested-restore-stepup-confirm'));

    const expectedCommand = `breeze-backup bmr-recover --token brz_rec_123 --server ${window.location.origin}`;
    expect(await screen.findByText(expectedCommand)).toBeTruthy();
    const bodies = fetchMock.mock.calls
      .filter(([url, init]) => url === '/backup/bmr/tokens' && (init as RequestInit | undefined)?.method === 'POST')
      .map(([, init]) => JSON.parse(String((init as RequestInit).body)));
    expect(bodies[1]).toMatchObject({ snapshotId: 'snapshot-1', confirmUnattestedRestore: true });
    expect(bodies[0]).not.toHaveProperty('confirmUnattestedRestore');
  });

  it('sends a user without a second factor to set one up before creating a token, and Retry resubmits it', async () => {
    const base = fetchMock.getMockImplementation()!;
    let tokenPosts = 0;
    fetchMock.mockImplementation(async (input, init) => {
      const method = (init as RequestInit | undefined)?.method ?? 'GET';
      if (String(input) === '/backup/bmr/tokens' && method === 'POST') {
        tokenPosts += 1;
        if (tokenPosts === 1) return makeJsonResponse({
          error: 'Enroll a second factor to confirm this restore.',
          code: 'MFA_ENROLLMENT_REQUIRED',
          stepUp: {
            operation: 'backup_unattested_restore',
            method: 'enroll',
            reason: 'unattested_legacy',
            resource: { snapshotId: 'snapshot-1', targetDeviceId: 'device-1', commandType: 'bmr_recover' },
          },
        }, false, 403);
      }
      return base(input, init);
    });

    render(<RecoveryBootstrapTab />);
    await screen.findByText('Nightly Snapshot');
    fireEvent.click(screen.getByRole('button', { name: /Create token/i }));

    expect((await screen.findByTestId('unattested-restore-stepup-enroll')).getAttribute('href')).toBe('/settings/profile');
    expect(screen.queryByTestId('unattested-restore-stepup-confirm')).toBeNull();
    fireEvent.click(screen.getByTestId('unattested-restore-stepup-retry'));

    const expectedCommand = `breeze-backup bmr-recover --token brz_rec_123 --server ${window.location.origin}`;
    expect(await screen.findByText(expectedCommand)).toBeTruthy();
    const bodies = fetchMock.mock.calls
      .filter(([url, init]) => url === '/backup/bmr/tokens' && (init as RequestInit | undefined)?.method === 'POST')
      .map(([, init]) => JSON.parse(String((init as RequestInit).body)));
    expect(bodies).toHaveLength(2);
    expect(bodies[1]).toEqual(bodies[0]);
    expect(bodies[1]).not.toHaveProperty('stepUpGrant');
  });

  it('a Retry that fails keeps the set-up link and Retry visible; no token is created', async () => {
    const base = fetchMock.getMockImplementation()!;
    let tokenPosts = 0;
    fetchMock.mockImplementation(async (input, init) => {
      const method = (init as RequestInit | undefined)?.method ?? 'GET';
      if (String(input) === '/backup/bmr/tokens' && method === 'POST') {
        tokenPosts += 1;
        if (tokenPosts === 1) return makeJsonResponse({
          error: 'Enroll a second factor to confirm this restore.',
          code: 'MFA_ENROLLMENT_REQUIRED',
          stepUp: {
            operation: 'backup_unattested_restore',
            method: 'enroll',
            reason: 'unattested_legacy',
            resource: { snapshotId: 'snapshot-1', targetDeviceId: 'device-1', commandType: 'bmr_recover' },
          },
        }, false, 403);
        return makeJsonResponse({ error: 'Recovery token service unavailable' }, false, 500);
      }
      return base(input, init);
    });

    render(<RecoveryBootstrapTab />);
    await screen.findByText('Nightly Snapshot');
    fireEvent.click(screen.getByRole('button', { name: /Create token/i }));
    await screen.findByTestId('unattested-restore-stepup-enroll');
    fireEvent.click(screen.getByTestId('unattested-restore-stepup-retry'));

    await waitFor(() => expect(tokenPosts).toBe(2));
    await waitFor(() => expect(screen.getByTestId('unattested-restore-stepup-retry')).not.toBeDisabled());
    expect(screen.getByTestId('unattested-restore-stepup-enroll').getAttribute('href')).toBe('/settings/profile');
    expect(await screen.findByText('Recovery token service unavailable')).toBeTruthy();
    expect(screen.queryByText(/brz_rec_123/)).toBeNull();
    expect(screen.queryByText(/Recovery token created/)).toBeNull();
  });

  it('shows the snapshot label instead of the bare UUID in the bootstrap detail panel (#6496)', async () => {
    render(<RecoveryBootstrapTab />);

    await screen.findByText('Manual recovery environment');
    fireEvent.click(screen.getByRole('button', { name: /Create token/i }));

    const expectedCommand = `breeze-backup bmr-recover --token brz_rec_123 --server ${window.location.origin}`;
    await screen.findByText(expectedCommand);

    expect(screen.getAllByText('Nightly Snapshot').length).toBeGreaterThan(0);
    expect(screen.queryByText('snapshot-1')).toBeNull();
  });

  it('formats a linked restore job\'s restored size instead of printing raw bytes (#6496)', async () => {
    fetchMock.mockImplementation(async (input, init) => {
      const url = String(input);
      const method = (init as RequestInit | undefined)?.method ?? 'GET';

      if (url === '/backup/snapshots') {
        return makeJsonResponse({
          data: [{ id: 'snapshot-1', label: 'Nightly Snapshot', timestamp: '2026-03-28T10:00:00Z', size: 2147483648 }],
        });
      }
      if (url === '/backup/bmr/tokens?limit=100' && method === 'GET') return makeJsonResponse({ data: [] });
      if (url === '/backup/bmr/media?limit=100' && method === 'GET') return makeJsonResponse({ data: [] });
      if (url === '/backup/bmr/boot-media?limit=100' && method === 'GET') return makeJsonResponse({ data: [] });

      if (url === '/backup/bmr/tokens' && method === 'POST') {
        return makeJsonResponse({
          id: 'token-1',
          token: 'brz_rec_123',
          deviceId: 'device-1',
          snapshotId: 'snapshot-1',
          restoreType: 'bare_metal',
          status: 'active',
          sessionStatus: 'pending',
          createdAt: '2026-03-31T10:00:00Z',
          expiresAt: '2026-04-01T10:00:00Z',
          restoreJobId: 'restore-9',
          linkedRestoreJob: {
            id: 'restore-9',
            status: 'completed',
            completedAt: '2026-03-31T10:20:00Z',
            restoredFiles: 12,
            restoredSize: 402653184,
          },
          bootstrap: {
            version: 1,
            minHelperVersion: '0.5.0',
            serverUrl: window.location.origin,
            releaseUrl: 'https://github.com/lanternops/breeze/releases/latest',
            commandTemplate: `breeze-backup bmr-recover --token <recovery-token> --server "${window.location.origin}"`,
            prerequisites: ['Boot into a recovery environment.'],
          },
        }, true, 201);
      }

      return makeJsonResponse({}, false, 404);
    });

    render(<RecoveryBootstrapTab />);
    await screen.findByText('Manual recovery environment');
    fireEvent.click(screen.getByRole('button', { name: /Create token/i }));

    await screen.findByText('384 MB');
    expect(screen.queryByText('402653184')).toBeNull();
  });

  const renderWithLinkedResult = async (result: Record<string, unknown>, status = 'completed') => {
    fetchMock.mockImplementation(async (input, init) => {
      const url = String(input);
      const method = (init as RequestInit | undefined)?.method ?? 'GET';
      if (url === '/backup/snapshots') {
        return makeJsonResponse({
          data: [{ id: 'snapshot-1', label: 'Nightly Snapshot', timestamp: '2026-03-28T10:00:00Z', size: 2147483648 }],
        });
      }
      if (url === '/backup/bmr/tokens?limit=100' && method === 'GET') return makeJsonResponse({ data: [] });
      if (url === '/backup/bmr/media?limit=100' && method === 'GET') return makeJsonResponse({ data: [] });
      if (url === '/backup/bmr/boot-media?limit=100' && method === 'GET') return makeJsonResponse({ data: [] });
      if (url === '/backup/bmr/tokens' && method === 'POST') {
        return makeJsonResponse({
          id: 'token-1',
          token: 'brz_rec_123',
          deviceId: 'device-1',
          snapshotId: 'snapshot-1',
          restoreType: 'bare_metal',
          status: 'used',
          sessionStatus: 'completed',
          createdAt: '2026-03-31T10:00:00Z',
          expiresAt: '2026-04-01T10:00:00Z',
          restoreJobId: 'restore-9',
          linkedRestoreJob: {
            id: 'restore-9',
            status,
            completedAt: '2026-03-31T10:20:00Z',
            restoredFiles: 12,
            restoredSize: 1024,
            result,
          },
          bootstrap: {
            version: 1,
            minHelperVersion: '0.5.0',
            serverUrl: window.location.origin,
            releaseUrl: 'https://github.com/lanternops/breeze/releases/latest',
            commandTemplate: `breeze-backup bmr-recover --token <recovery-token> --server "${window.location.origin}"`,
            prerequisites: ['Boot into a recovery environment.'],
          },
        }, true, 201);
      }
      return makeJsonResponse({}, false, 404);
    });
    render(<RecoveryBootstrapTab />);
    await screen.findByText('Manual recovery environment');
    fireEvent.click(screen.getByRole('button', { name: /Create token/i }));
    await screen.findByText('Linked restore job / result');
  };

  it('shows files-only Windows recovery as an informational note, not a failure', async () => {
    await renderWithLinkedResult({
      status: 'completed',
      code: 'system_state_requires_rebuild',
      warnings: ['system_state_requires_rebuild: system state is applied by a bare-metal rebuild; this recovery restored files only'],
    });

    const note = await screen.findByTestId('restore-result-system-state-note');
    expect(note.textContent).toContain('System state is applied by a bare-metal rebuild');
    expect(screen.queryByTestId('recovery-restore-failure-reason')).toBeNull();
  });

  it('shows an unattested-snapshot warning as a warning, not a failure', async () => {
    await renderWithLinkedResult({
      status: 'completed',
      warnings: ['restored from an unattested snapshot: files were not checked against a snapshot attestation'],
    });

    const warning = await screen.findByTestId('restore-result-unattested-warning');
    expect(warning.textContent).toMatch(/not checked against a snapshot attestation/i);
    expect(screen.queryByTestId('recovery-restore-failure-reason')).toBeNull();
  });

  it('shows an integrity result code on a failed recovery', async () => {
    await renderWithLinkedResult(
      { status: 'failed', code: 'integrity_mismatch', error: 'snapshot manifest failed its integrity check' },
      'failed',
    );

    expect((await screen.findByTestId('recovery-restore-failure-reason')).textContent).toContain(
      'snapshot manifest failed its integrity check',
    );
    expect(screen.getByTestId('restore-result-code').textContent).toContain('integrity_mismatch');
    expect(screen.queryByTestId('restore-result-system-state-note')).toBeNull();
  });

  it('renders none of the result notes for a result without the new fields', async () => {
    await renderWithLinkedResult({ status: 'completed', filesRestored: 12 });
    expect(screen.queryByTestId('restore-result-system-state-note')).toBeNull();
    expect(screen.queryByTestId('restore-result-unattested-warning')).toBeNull();
    expect(screen.queryByTestId('restore-result-code')).toBeNull();
    expect(screen.queryByTestId('recovery-restore-failure-reason')).toBeNull();
  });

  // DBT-7: the API refuses `POST /backup/bmr/tokens` with 409
  // `{"error":"snapshot_not_bare_metal_restorable","reasons":[...]}` when the
  // snapshot wasn't assessed as bare-metal restorable. The raw machine code
  // must not leak into the UI verbatim, and the `reasons` the API bothered to
  // send must actually be shown — not silently dropped.
  it('shows plain copy and the reasons list for a snapshot_not_bare_metal_restorable refusal', async () => {
    fetchMock.mockImplementation(async (input, init) => {
      const url = String(input);
      const method = (init as RequestInit | undefined)?.method ?? 'GET';

      if (url === '/backup/snapshots') {
        return makeJsonResponse({
          data: [{ id: 'snapshot-1', label: 'Nightly Snapshot', timestamp: '2026-03-28T10:00:00Z', size: 2147483648 }],
        });
      }
      if (url === '/backup/bmr/tokens?limit=100' && method === 'GET') return makeJsonResponse({ data: [] });
      if (url === '/backup/bmr/media?limit=100' && method === 'GET') return makeJsonResponse({ data: [] });
      if (url === '/backup/bmr/boot-media?limit=100' && method === 'GET') return makeJsonResponse({ data: [] });
      if (url === '/backup/bmr/tokens' && method === 'POST') {
        return makeJsonResponse(
          {
            error: 'snapshot_not_bare_metal_restorable',
            reasons: ['missing EFI system partition', 'BitLocker volume not captured'],
          },
          false,
          409
        );
      }
      return makeJsonResponse({}, false, 404);
    });

    render(<RecoveryBootstrapTab />);
    await screen.findByText('Nightly Snapshot');

    fireEvent.click(screen.getByRole('button', { name: /Create token/i }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith('/backup/bmr/tokens', expect.objectContaining({ method: 'POST' }));
    });

    expect(await screen.findByText(/can.t be used for a bare-metal restore/i)).toBeInTheDocument();
    expect(screen.getByText('missing EFI system partition')).toBeInTheDocument();
    expect(screen.getByText('BitLocker volume not captured')).toBeInTheDocument();
    expect(screen.queryByText('snapshot_not_bare_metal_restorable')).toBeNull();
  });

  it('filters the browser-local token catalog and revokes a token', async () => {
    window.localStorage.setItem(
      'breeze-backup-recovery-bootstrap-catalog',
      JSON.stringify([
        {
          id: 'token-active',
          deviceId: 'device-1',
          snapshotId: 'snapshot-1',
          restoreType: 'full',
          status: 'active',
          createdAt: '2026-03-31T08:00:00Z',
          expiresAt: '2026-04-01T08:00:00Z',
        },
        {
          id: 'token-expired',
          deviceId: 'device-2',
          snapshotId: 'snapshot-1',
          restoreType: 'selective',
          status: 'expired',
          createdAt: '2026-03-30T08:00:00Z',
          expiresAt: '2026-03-30T09:00:00Z',
        },
      ])
    );

    render(<RecoveryBootstrapTab />);

    await screen.findAllByRole('button', { name: /^View$/i });
    expect(screen.getAllByRole('button', { name: /^View$/i })).toHaveLength(2);

    fireEvent.change(screen.getByLabelText(/Filter by status/i), { target: { value: 'active' } });
    expect(screen.getAllByRole('button', { name: /^View$/i })).toHaveLength(1);

    fireEvent.click(screen.getByRole('button', { name: /Revoke/i }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        '/backup/bmr/tokens/token-active',
        expect.objectContaining({ method: 'DELETE' })
      );
    });

    await waitFor(() => {
      const revokedLabels = screen.getAllByText('Revoked');
      expect(revokedLabels.some((el) => el.tagName === 'SPAN')).toBe(true);
    });
  });

  it('refreshes the recovery bundle catalog after bundle creation', async () => {
    render(<RecoveryBootstrapTab />);

    await screen.findByText('Manual recovery environment');
    fireEvent.click(screen.getByRole('button', { name: /Create token/i }));
    await screen.findByText(/Recovery token created/i);

    fireEvent.click(screen.getByRole('button', { name: /Create bundle/i }));

    await waitFor(() => {
      const mediaRefreshCalls = fetchMock.mock.calls.filter(
        ([url, init]) => String(url) === '/backup/bmr/media?limit=100' && ((init as RequestInit | undefined)?.method ?? 'GET') === 'GET'
      );
      expect(mediaRefreshCalls.length).toBeGreaterThan(1);
    });
  });

  // W04b: booting recovery media is no longer built per-token — it's the
  // static, release-built breeze-recovery-linux-{amd64,arm64}.iso catalog,
  // shown with a Download button and no "create" action.
  it('renders the release-built linux recovery media catalog with a download action', async () => {
    render(<RecoveryBootstrapTab />);

    await screen.findByText('Manual recovery environment');
    fireEvent.click(screen.getByRole('button', { name: /Create token/i }));
    await screen.findByText(/Recovery token created/i);

    expect(await screen.findByText('breeze-recovery-linux-amd64.iso')).toBeInTheDocument();
    expect(screen.getByText('breeze-recovery-linux-arm64.iso')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Create ISO/i })).toBeNull();

    const downloadButtons = screen.getAllByRole('button', { name: /Download ISO/i });
    expect(downloadButtons).toHaveLength(2);

    fireEvent.click(downloadButtons[0]!);

    await waitFor(() => {
      const downloadCalls = fetchMock.mock.calls.filter(
        ([url]) => String(url) === '/api/v1/agents/download/recovery-iso/linux/amd64'
      );
      expect(downloadCalls.length).toBeGreaterThan(0);
    });
  });
});
