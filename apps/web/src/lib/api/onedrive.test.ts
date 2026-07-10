// apps/web/src/lib/api/onedrive.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

const fetchWithAuth = vi.fn();
vi.mock('../../stores/auth', () => ({ fetchWithAuth: (...a: unknown[]) => fetchWithAuth(...a) }));

import {
  fetchM365ConnectionStatus,
  fetchOneDriveLibraries,
  fetchDeviceOneDriveState,
  fetchOneDriveFleetState,
} from './onedrive';

beforeEach(() => {
  fetchWithAuth.mockReset();
});

describe('onedrive api client', () => {
  describe('fetchM365ConnectionStatus', () => {
    it('hits /m365/connection with no query when orgId omitted', async () => {
      fetchWithAuth.mockResolvedValue(new Response(JSON.stringify({ connected: true })));
      await fetchM365ConnectionStatus();
      expect(fetchWithAuth).toHaveBeenCalledWith('/m365/connection');
    });

    it('appends orgId when provided', async () => {
      fetchWithAuth.mockResolvedValue(new Response(JSON.stringify({ connected: true })));
      await fetchM365ConnectionStatus('org-1');
      expect(fetchWithAuth).toHaveBeenCalledWith('/m365/connection?orgId=org-1');
    });

    it('returns true only when connected is strictly true', async () => {
      fetchWithAuth.mockResolvedValue(new Response(JSON.stringify({ connected: true })));
      expect(await fetchM365ConnectionStatus()).toBe(true);
    });

    it('returns false when connected is false', async () => {
      fetchWithAuth.mockResolvedValue(new Response(JSON.stringify({ connected: false })));
      expect(await fetchM365ConnectionStatus()).toBe(false);
    });

    it('returns false when connected field is missing', async () => {
      fetchWithAuth.mockResolvedValue(new Response(JSON.stringify({})));
      expect(await fetchM365ConnectionStatus()).toBe(false);
    });

    it('returns false when connected is truthy but not boolean true', async () => {
      fetchWithAuth.mockResolvedValue(new Response(JSON.stringify({ connected: 'true' })));
      expect(await fetchM365ConnectionStatus()).toBe(false);
    });
  });

  describe('fetchOneDriveLibraries', () => {
    it('hits /onedrive/libraries with no query when orgId omitted', async () => {
      fetchWithAuth.mockResolvedValue(new Response(JSON.stringify({ libraries: [], skippedSites: [] })));
      await fetchOneDriveLibraries();
      expect(fetchWithAuth).toHaveBeenCalledWith('/onedrive/libraries');
    });

    it('appends orgId when provided', async () => {
      fetchWithAuth.mockResolvedValue(new Response(JSON.stringify({ libraries: [], skippedSites: [] })));
      await fetchOneDriveLibraries('org-1');
      expect(fetchWithAuth).toHaveBeenCalledWith('/onedrive/libraries?orgId=org-1');
    });

    it('returns libraries and skippedSites on success', async () => {
      const libraries = [
        {
          siteId: 's1', siteName: 'Site 1', siteUrl: 'https://x', driveId: 'd1', listId: 'l1',
          libraryName: 'Docs', tenantId: 't1', webId: 'w1', spSiteId: 'sp1', autoMountValue: 'auto',
        },
      ];
      const skippedSites = [{ siteId: 's2', code: 'accessDenied' }];
      fetchWithAuth.mockResolvedValue(new Response(JSON.stringify({ libraries, skippedSites })));
      const result = await fetchOneDriveLibraries('org-1');
      expect(result).toEqual({ libraries, skippedSites });
    });

    it('throws with the server error message on a 409 no-connection response', async () => {
      fetchWithAuth.mockResolvedValue(
        new Response(JSON.stringify({ error: 'This organization has no Microsoft 365 connection. Connect M365 first.' }), {
          status: 409,
        }),
      );
      await expect(fetchOneDriveLibraries('org-1')).rejects.toThrow(
        'This organization has no Microsoft 365 connection. Connect M365 first.',
      );
    });
  });

  describe('fetchDeviceOneDriveState', () => {
    it('hits /onedrive/devices/:id/state', async () => {
      fetchWithAuth.mockResolvedValue(new Response(JSON.stringify({ state: null })));
      await fetchDeviceOneDriveState('dev-1');
      expect(fetchWithAuth).toHaveBeenCalledWith('/onedrive/devices/dev-1/state');
    });

    it('passes through null state', async () => {
      fetchWithAuth.mockResolvedValue(new Response(JSON.stringify({ state: null })));
      expect(await fetchDeviceOneDriveState('dev-1')).toBeNull();
    });

    it('returns the state row when present', async () => {
      const state = {
        deviceId: 'dev-1', signedIn: true, oneDriveVersion: '1.0', filesOnDemandOn: true,
        kfmFolderStates: {}, mountedLibraries: [], entitledLibraries: [], driftEntries: [],
        lastReportedAt: '2026-07-01T00:00:00Z',
      };
      fetchWithAuth.mockResolvedValue(new Response(JSON.stringify({ state })));
      expect(await fetchDeviceOneDriveState('dev-1')).toEqual(state);
    });

    it('throws on a non-ok response', async () => {
      fetchWithAuth.mockResolvedValue(new Response(JSON.stringify({ error: 'Device not found' }), { status: 404 }));
      await expect(fetchDeviceOneDriveState('dev-1')).rejects.toThrow('Device not found');
    });
  });

  describe('fetchOneDriveFleetState', () => {
    it('hits /onedrive/state with no query when orgId omitted', async () => {
      fetchWithAuth.mockResolvedValue(
        new Response(JSON.stringify({ devices: [], stats: { total: 0, signedIn: 0, kfmProtected: 0, withDrift: 0 } })),
      );
      await fetchOneDriveFleetState();
      expect(fetchWithAuth).toHaveBeenCalledWith('/onedrive/state');
    });

    it('appends orgId when provided', async () => {
      fetchWithAuth.mockResolvedValue(
        new Response(JSON.stringify({ devices: [], stats: { total: 0, signedIn: 0, kfmProtected: 0, withDrift: 0 } })),
      );
      await fetchOneDriveFleetState('org-1');
      expect(fetchWithAuth).toHaveBeenCalledWith('/onedrive/state?orgId=org-1');
    });

    it('returns devices and stats on success', async () => {
      const devices = [
        {
          deviceId: 'dev-1', hostname: 'host-1', signedIn: true, oneDriveVersion: '1.0', filesOnDemandOn: true,
          kfmFolderStates: {}, mountedLibraries: [], entitledLibraries: [], driftEntries: [],
          lastReportedAt: '2026-07-01T00:00:00Z',
        },
      ];
      const stats = { total: 1, signedIn: 1, kfmProtected: 0, withDrift: 0 };
      fetchWithAuth.mockResolvedValue(new Response(JSON.stringify({ devices, stats })));
      const result = await fetchOneDriveFleetState('org-1');
      expect(result).toEqual({ devices, stats });
    });

    it('throws on a non-ok response', async () => {
      fetchWithAuth.mockResolvedValue(new Response(JSON.stringify({ error: 'orgId is required for this scope' }), { status: 400 }));
      await expect(fetchOneDriveFleetState()).rejects.toThrow('orgId is required for this scope');
    });
  });
});
