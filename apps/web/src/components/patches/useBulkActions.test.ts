import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { useBulkActions } from './useBulkActions';
import { fetchWithAuth } from '../../stores/auth';

vi.mock('../../stores/auth', () => ({
  fetchWithAuth: vi.fn(),
}));

vi.mock('@/lib/navigation', () => ({
  navigateTo: vi.fn(),
}));

const fetchMock = vi.mocked(fetchWithAuth);

const makeJsonResponse = (payload: unknown, ok = true, status = ok ? 200 : 500): Response =>
  ({
    ok,
    status,
    statusText: ok ? 'OK' : 'ERROR',
    json: vi.fn().mockResolvedValue(payload),
  }) as unknown as Response;

const deviceId = '11111111-1111-1111-1111-111111111111';

describe('useBulkActions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('surfaces a distinct approval message when install returns 409', async () => {
    fetchMock.mockResolvedValue(
      makeJsonResponse(
        { error: 'Only approved patches can be installed', unapprovedPatchIds: ['p-1'] },
        false,
        409
      )
    );

    const { result } = renderHook(() =>
      useBulkActions(new Set([deviceId]), vi.fn(), vi.fn(), {
        resolveInstallPatchIds: async () => ({ patchIds: ['p-1'] }),
      })
    );

    await act(async () => {
      await result.current.handleBulkInstall([deviceId]);
    });

    await waitFor(() => {
      expect(result.current.bulkError).toMatch(/pending approval, refresh and retry/i);
    });
    // Should NOT be reported as a generic failure.
    expect(result.current.bulkError).not.toMatch(/^Install failed/);
  });

  it('reports patches skipped pending approval in the success message', async () => {
    fetchMock.mockResolvedValue(
      makeJsonResponse({ success: true, commandId: 'cmd-1' })
    );

    const { result } = renderHook(() =>
      useBulkActions(new Set([deviceId]), vi.fn(), vi.fn(), {
        resolveInstallPatchIds: async () => ({ patchIds: ['p-1'], skippedPendingApproval: 2 }),
      })
    );

    await act(async () => {
      await result.current.handleBulkInstall([deviceId]);
    });

    await waitFor(() => {
      expect(result.current.bulkSuccess).toMatch(/queued on 1 device/i);
    });
    expect(result.current.bulkSuccess).toMatch(/2 patches across 1 device skipped pending approval/i);
  });

  it('falls back to a generic failure message for non-409 errors', async () => {
    fetchMock.mockResolvedValue(makeJsonResponse({ error: 'boom' }, false, 500));

    const { result } = renderHook(() =>
      useBulkActions(new Set([deviceId]), vi.fn(), vi.fn(), {
        resolveInstallPatchIds: async () => ({ patchIds: ['p-1'] }),
      })
    );

    await act(async () => {
      await result.current.handleBulkInstall([deviceId]);
    });

    await waitFor(() => {
      expect(result.current.bulkError).toMatch(/Install failed on 1 of 1 devices/i);
    });
  });

  describe('scope-naming confirm gate', () => {
    it('requestBulkInstall sets pendingConfirm without firing a POST', () => {
      const { result } = renderHook(() =>
        useBulkActions(new Set([deviceId]), vi.fn(), vi.fn(), {
          resolveInstallPatchIds: async () => ({ patchIds: ['p-1'] }),
        })
      );

      act(() => {
        result.current.requestBulkInstall(['Acme Corp'], [deviceId]);
      });

      // pendingConfirm is populated
      expect(result.current.pendingConfirm).not.toBeNull();
      expect(result.current.pendingConfirm?.action).toBe('Install patches');
      expect(result.current.pendingConfirm?.deviceCount).toBe(1);
      expect(result.current.pendingConfirm?.orgNames).toEqual(['Acme Corp']);

      // No HTTP call yet — the POST must NOT fire until confirm
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('requestBulkScan sets pendingConfirm without firing a POST', () => {
      const { result } = renderHook(() =>
        useBulkActions(new Set([deviceId]), vi.fn(), vi.fn())
      );

      act(() => {
        result.current.requestBulkScan(['Beta Org'], [deviceId]);
      });

      expect(result.current.pendingConfirm).not.toBeNull();
      expect(result.current.pendingConfirm?.action).toBe('Scan for patches');
      expect(result.current.pendingConfirm?.deviceCount).toBe(1);
      expect(result.current.pendingConfirm?.orgNames).toEqual(['Beta Org']);
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('cancelPendingAction clears pendingConfirm without firing a POST', () => {
      const { result } = renderHook(() =>
        useBulkActions(new Set([deviceId]), vi.fn(), vi.fn())
      );

      act(() => {
        result.current.requestBulkScan(['Acme Corp'], [deviceId]);
      });
      expect(result.current.pendingConfirm).not.toBeNull();

      act(() => {
        result.current.cancelPendingAction();
      });
      expect(result.current.pendingConfirm).toBeNull();
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('confirmPendingAction fires the install POST and confirm message contains org name + device count', async () => {
      fetchMock.mockResolvedValue(makeJsonResponse({ success: true, commandId: 'cmd-1' }));

      const { result } = renderHook(() =>
        useBulkActions(new Set([deviceId]), vi.fn(), vi.fn(), {
          resolveInstallPatchIds: async () => ({ patchIds: ['p-1'] }),
        })
      );

      act(() => {
        result.current.requestBulkInstall(['Acme Corp'], [deviceId]);
      });

      // Verify the confirm message contains org name and device count
      const { pendingConfirm } = result.current;
      expect(pendingConfirm?.orgNames).toContain('Acme Corp');
      expect(pendingConfirm?.deviceCount).toBe(1);

      // Confirm — this should now fire the POST
      await act(async () => {
        await result.current.confirmPendingAction();
      });

      await waitFor(() => {
        expect(fetchMock).toHaveBeenCalledWith(
          expect.stringContaining(`/devices/${deviceId}/patches/install`),
          expect.objectContaining({ method: 'POST' })
        );
      });

      // pendingConfirm cleared after confirm
      expect(result.current.pendingConfirm).toBeNull();
    });
  });
});
