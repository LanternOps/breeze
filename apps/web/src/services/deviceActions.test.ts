import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock fetchWithAuth so we can control API responses
vi.mock('@/stores/auth', () => ({
  fetchWithAuth: vi.fn(),
}));

import { fetchWithAuth } from '@/stores/auth';
import { sendDeviceCommand } from './deviceActions';

const fetchMock = vi.mocked(fetchWithAuth);

function makeJsonResponse(payload: unknown, ok = true, status = ok ? 200 : 500): Response {
  return {
    ok,
    status,
    statusText: ok ? 'OK' : 'ERROR',
    json: vi.fn().mockResolvedValue(payload),
  } as unknown as Response;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('sendDeviceCommand error extraction', () => {
  it('produces a readable message (not [object Object]) when the API returns a zod-style error body', async () => {
    // API returns a 400 with a zod-style error: { error: { issues: [...] } }
    fetchMock.mockResolvedValue(
      makeJsonResponse(
        { error: { issues: [{ message: 'bad', path: ['x'] }] } },
        false,
        400
      )
    );

    let thrownMessage: string | undefined;
    try {
      await sendDeviceCommand('dev-1', 'restart');
    } catch (err) {
      thrownMessage = err instanceof Error ? err.message : String(err);
    }

    // Must NOT be the bare fallback, must NOT be "[object Object]"
    expect(thrownMessage).not.toBe('[object Object]');
    expect(thrownMessage).not.toBe('Failed to send device command');
    // Must contain the human-readable issue message
    expect(thrownMessage).toContain('bad');
  });

  it('returns the plain error string from the API when error is a string', async () => {
    fetchMock.mockResolvedValue(
      makeJsonResponse({ error: 'Device not found' }, false, 404)
    );

    let thrownMessage: string | undefined;
    try {
      await sendDeviceCommand('dev-1', 'restart');
    } catch (err) {
      thrownMessage = err instanceof Error ? err.message : String(err);
    }

    expect(thrownMessage).toBe('Device not found');
  });

  it('falls back to the fallback message when no readable error is available', async () => {
    fetchMock.mockResolvedValue(
      makeJsonResponse({}, false, 500)
    );

    let thrownMessage: string | undefined;
    try {
      await sendDeviceCommand('dev-1', 'restart');
    } catch (err) {
      thrownMessage = err instanceof Error ? err.message : String(err);
    }

    expect(thrownMessage).toBe('Failed to send device command');
  });
});

describe('linkDevicesVmHost wire shape (#2308)', () => {
  it('POSTs kind, hostDeviceId, and deviceIds to /devices/link-groups', async () => {
    const { linkDevicesVmHost } = await import('./deviceActions');
    fetchMock.mockResolvedValue(makeJsonResponse({ id: 'grp-vm' }));

    const result = await linkDevicesVmHost('dev-host', ['dev-host', 'dev-vm1', 'dev-vm2']);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('/devices/link-groups');
    expect(init?.method).toBe('POST');
    // The exact body contract the API's createLinkGroupSchema validates —
    // a drifted key here means every vm_host link 400s.
    expect(JSON.parse(init?.body as string)).toEqual({
      kind: 'vm_host',
      hostDeviceId: 'dev-host',
      deviceIds: ['dev-host', 'dev-vm1', 'dev-vm2'],
    });
    expect(result).toEqual({ id: 'grp-vm' });
  });

  it('throws the API error message on failure', async () => {
    const { linkDevicesVmHost } = await import('./deviceActions');
    fetchMock.mockResolvedValue(
      makeJsonResponse({ error: 'A vm_host group requires hostDeviceId' }, false, 400),
    );

    await expect(linkDevicesVmHost('dev-host', ['dev-host', 'dev-vm1'])).rejects.toThrow(
      'A vm_host group requires hostDeviceId',
    );
  });
});

describe('decommissionDevice — agent choice is sent to the API', () => {
  it('sends { uninstallAgent: true } as the JSON body', async () => {
    const { decommissionDevice } = await import('./deviceActions');
    fetchMock.mockResolvedValue(makeJsonResponse({ success: true, uninstallQueued: true }));
    await decommissionDevice('dev-1', { uninstallAgent: true });
    const [path, init] = fetchMock.mock.calls[0]!;
    expect(path).toBe('/devices/dev-1');
    expect(init?.method).toBe('DELETE');
    expect(JSON.parse(String(init?.body))).toEqual({ uninstallAgent: true });
    expect((init?.headers as Record<string, string>)['Content-Type']).toBe('application/json');
  });

  it('sends { uninstallAgent: false } when the user chose to leave the agent', async () => {
    const { decommissionDevice } = await import('./deviceActions');
    fetchMock.mockResolvedValue(makeJsonResponse({ success: true, uninstallQueued: false }));
    await decommissionDevice('dev-1', { uninstallAgent: false });
    expect(JSON.parse(String(fetchMock.mock.calls[0]![1]?.body))).toEqual({ uninstallAgent: false });
  });
});

describe('bulkDecommissionDevices — one body per device, same choice', () => {
  it('forwards the same uninstallAgent to every DELETE', async () => {
    const { bulkDecommissionDevices } = await import('./deviceActions');
    fetchMock.mockResolvedValue(makeJsonResponse({ success: true }));
    const result = await bulkDecommissionDevices(
      [{ id: 'a', hostname: 'A' }, { id: 'b', hostname: 'B' }],
      { uninstallAgent: true },
    );
    expect(result).toEqual({ succeeded: 2, failed: [] });
    for (const call of fetchMock.mock.calls) {
      expect(JSON.parse(String(call[1]?.body))).toEqual({ uninstallAgent: true });
    }
  });
});

describe('fetchRemovalConfig', () => {
  it('returns the drain window from GET /devices/removal-config', async () => {
    const { fetchRemovalConfig } = await import('./deviceActions');
    fetchMock.mockResolvedValue(makeJsonResponse({ uninstallDrainWindowHours: 48 }));
    expect(await fetchRemovalConfig()).toEqual({ uninstallDrainWindowHours: 48 });
    expect(fetchMock.mock.calls[0]![0]).toBe('/devices/removal-config');
  });
});

// ---------------------------------------------------------------------------
// #2787 — bulk restore / bulk permanent delete
// ---------------------------------------------------------------------------

describe('bulkRestoreDevices', () => {
  it('POSTs the ids to /devices/bulk/restore and returns the per-device outcome', async () => {
    const { bulkRestoreDevices } = await import('./deviceActions');
    fetchMock.mockResolvedValue(
      makeJsonResponse({
        succeeded: [{ deviceId: 'd1', uninstallAlreadyDispatched: true }],
        failed: [{ deviceId: 'd2', code: 'NOT_REMOVED', message: 'nope' }],
      }),
    );

    const result = await bulkRestoreDevices(['d1', 'd2']);

    expect(fetchMock).toHaveBeenCalledWith('/devices/bulk/restore', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ deviceIds: ['d1', 'd2'] }),
    });
    expect(result.succeeded).toEqual([{ deviceId: 'd1', uninstallAlreadyDispatched: true }]);
    expect(result.failed).toEqual([{ deviceId: 'd2', code: 'NOT_REMOVED', message: 'nope' }]);
  });

  it("throws with the API's error message on a non-OK response", async () => {
    const { bulkRestoreDevices } = await import('./deviceActions');
    fetchMock.mockResolvedValue(makeJsonResponse({ error: 'MFA required' }, false, 403));

    await expect(bulkRestoreDevices(['d1'])).rejects.toThrow('MFA required');
  });
});

describe('startBulkPurge', () => {
  it('POSTs to /devices/bulk/permanent-delete and returns the jobId', async () => {
    const { startBulkPurge } = await import('./deviceActions');
    fetchMock.mockResolvedValue(
      makeJsonResponse({ jobId: 'job-1', accepted: 3, rejected: [] }, true, 202),
    );

    const result = await startBulkPurge(['d1', 'd2', 'd3']);

    expect(fetchMock).toHaveBeenCalledWith('/devices/bulk/permanent-delete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ deviceIds: ['d1', 'd2', 'd3'] }),
    });
    expect(result).toEqual({ jobId: 'job-1', accepted: 3, rejected: [] });
  });

  /**
   * The 409 "nothing is eligible" body carries per-device reasons the caller
   * needs to show. A plain `throw new Error(message)` would discard them, and
   * the operator would be told "no device can be deleted" with no idea which
   * device failed which check.
   */
  it('attaches the per-device rejections to the thrown error on 409', async () => {
    const { startBulkPurge, BulkPurgeRejectedError } = await import('./deviceActions');
    fetchMock.mockResolvedValue(
      makeJsonResponse(
        {
          error: 'No selected device can be permanently deleted',
          rejected: [{ deviceId: 'd1', code: 'NOT_REMOVED', message: 'not removed' }],
        },
        false,
        409,
      ),
    );

    await expect(startBulkPurge(['d1'])).rejects.toBeInstanceOf(BulkPurgeRejectedError);
    await expect(startBulkPurge(['d1'])).rejects.toMatchObject({
      message: 'No selected device can be permanently deleted',
      rejected: [{ deviceId: 'd1', code: 'NOT_REMOVED', message: 'not removed' }],
    });
  });

  it('throws a plain Error (not BulkPurgeRejectedError) on a non-409 failure', async () => {
    const { startBulkPurge, BulkPurgeRejectedError } = await import('./deviceActions');
    fetchMock.mockResolvedValue(makeJsonResponse({ error: 'MFA required' }, false, 403));

    await expect(startBulkPurge(['d1'])).rejects.toThrow('MFA required');
    await expect(startBulkPurge(['d1'])).rejects.not.toBeInstanceOf(BulkPurgeRejectedError);
  });
});

describe('fetchPurgeRun', () => {
  it('GETs the run status by job id', async () => {
    const { fetchPurgeRun } = await import('./deviceActions');
    fetchMock.mockResolvedValue(
      makeJsonResponse({
        state: 'completed',
        progress: { done: 3, total: 3 },
        result: { purged: ['d1', 'd2', 'd3'], skipped: [] },
        failedReason: null,
      }),
    );

    const run = await fetchPurgeRun('job-1');

    expect(fetchMock).toHaveBeenCalledWith('/devices/bulk/purge-runs/job-1');
    expect(run.state).toBe('completed');
    expect(run.result).toEqual({ purged: ['d1', 'd2', 'd3'], skipped: [] });
  });

  it('url-encodes the job id', async () => {
    const { fetchPurgeRun } = await import('./deviceActions');
    fetchMock.mockResolvedValue(
      makeJsonResponse({ state: 'active', progress: { done: 0, total: 1 }, result: null, failedReason: null }),
    );

    await fetchPurgeRun('a/b');

    expect(fetchMock).toHaveBeenCalledWith('/devices/bulk/purge-runs/a%2Fb');
  });

  it("throws with the API's error message on a non-OK response", async () => {
    const { fetchPurgeRun } = await import('./deviceActions');
    fetchMock.mockResolvedValue(makeJsonResponse({ error: 'Purge run not found' }, false, 404));

    await expect(fetchPurgeRun('job-1')).rejects.toThrow('Purge run not found');
  });
});
