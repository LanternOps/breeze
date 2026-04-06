import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import RecoveryBootstrapTab from './RecoveryBootstrapTab';
import { fetchWithAuth } from '../../stores/auth';

vi.mock('../../stores/auth', () => ({
  fetchWithAuth: vi.fn(),
}));

const fetchMock = vi.mocked(fetchWithAuth);

const makeJsonResponse = (payload: unknown, ok = true, status = ok ? 200 : 500): Response =>
  ({
    ok,
    status,
    statusText: ok ? 'OK' : 'ERROR',
    json: vi.fn().mockResolvedValue(payload),
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
        return makeJsonResponse({
          data: [
            {
              id: 'boot-media-verified',
              tokenId: 'token-1',
              snapshotId: 'snapshot-1',
              bundleArtifactId: 'media-verified',
              platform: 'linux',
              architecture: 'amd64',
              mediaType: 'iso',
              status: 'ready_signed',
              checksumSha256: 'boot-checksum',
              signatureFormat: 'minisign',
              signingKeyId: 'current',
              signedAt: '2026-03-31T10:09:00Z',
              metadata: {
                bootTemplateId: 'linux-iso-template',
                bootTemplateVersion: '2026.03.31',
                bootTemplateSourceRef: '/opt/recovery/template',
                bootTemplateSha256: 'template-checksum',
                bootTemplateManifestVersion: '1',
              },
              downloadPath: '/backup/bmr/boot-media/boot-media-verified/download',
              signatureDownloadPath: '/backup/bmr/boot-media/boot-media-verified/signature',
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

      if (url === '/backup/bmr/boot-media' && method === 'POST') {
        return makeJsonResponse({
          id: 'boot-media-1',
          tokenId: 'token-1',
          snapshotId: 'snapshot-1',
          bundleArtifactId: 'media-1',
          platform: 'linux',
          architecture: 'amd64',
          mediaType: 'iso',
          status: 'pending',
          createdAt: '2026-03-31T10:07:00Z',
          completedAt: null,
          metadata: {},
          downloadPath: null,
          signatureDownloadPath: null,
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
          body: JSON.stringify({ token: 'brz_rec_123' }),
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
    expect(screen.getByText(/bootTemplateVersion:/)).toBeTruthy();
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

  it('refreshes recovery artifact catalogs after bundle and ISO creation', async () => {
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

    fireEvent.click(screen.getByRole('button', { name: /Create ISO/i }));

    await waitFor(() => {
      const bootMediaRefreshCalls = fetchMock.mock.calls.filter(
        ([url, init]) => String(url) === '/backup/bmr/boot-media?limit=100' && ((init as RequestInit | undefined)?.method ?? 'GET') === 'GET'
      );
      expect(bootMediaRefreshCalls.length).toBeGreaterThan(1);
    });
  });
});
