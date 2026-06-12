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
});
