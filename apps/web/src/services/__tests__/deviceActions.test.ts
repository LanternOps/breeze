import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fetchWithAuth } from '@/stores/auth';
import {
  bulkDecommissionDevices,
  decommissionDevice,
  executeScript,
  sendBulkCommand,
  sendBulkWakeCommand,
  sendDeviceCommand,
  sendWakeCommand,
  summarizeBulkWakeFailures,
  toggleMaintenanceMode,
  watchWakeOutcome,
  WakeCommandError,
  wakeFriendlyErrorMessage,
  type BulkWakeFailed
} from '../deviceActions';

vi.mock('@/stores/auth', () => ({
  fetchWithAuth: vi.fn()
}));

const fetchWithAuthMock = vi.mocked(fetchWithAuth);

const makeResponse = (payload: unknown, ok = true, status = ok ? 200 : 500): Response =>
  ({
    ok,
    status,
    json: vi.fn().mockResolvedValue(payload)
  }) as unknown as Response;

describe('deviceActions service', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('sendDeviceCommand', () => {
    it('returns command data on success', async () => {
      const command = {
        id: 'cmd-1',
        deviceId: 'dev-1',
        type: 'reboot',
        status: 'queued',
        createdAt: '2024-01-01T00:00:00.000Z'
      };

      fetchWithAuthMock.mockResolvedValue(makeResponse({ command }));

      const result = await sendDeviceCommand('dev-1', 'reboot', { force: true });

      expect(fetchWithAuthMock).toHaveBeenCalledWith('/devices/dev-1/commands', {
        method: 'POST',
        body: JSON.stringify({ type: 'reboot', payload: { force: true } })
      });
      expect(result).toEqual(command);
    });

    it('throws a helpful error when the request fails', async () => {
      fetchWithAuthMock.mockResolvedValue(makeResponse({ error: 'Command rejected' }, false, 400));

      await expect(sendDeviceCommand('dev-1', 'reboot')).rejects.toThrow('Command rejected');
      expect(fetchWithAuthMock).toHaveBeenCalledWith('/devices/dev-1/commands', {
        method: 'POST',
        body: JSON.stringify({ type: 'reboot' })
      });
    });
  });

  describe('sendBulkCommand', () => {
    it('returns command results even with partial failures', async () => {
      const responsePayload = {
        data: {
          commands: [
            {
              id: 'cmd-1',
              deviceId: 'dev-1',
              type: 'reboot',
              status: 'queued',
              createdAt: '2024-01-01T00:00:00.000Z'
            }
          ],
          failed: ['dev-2']
        }
      };

      fetchWithAuthMock.mockResolvedValue(makeResponse(responsePayload));

      const result = await sendBulkCommand(['dev-1', 'dev-2'], 'reboot');

      expect(fetchWithAuthMock).toHaveBeenCalledWith('/devices/bulk/commands', {
        method: 'POST',
        body: JSON.stringify({ deviceIds: ['dev-1', 'dev-2'], type: 'reboot' })
      });
      expect(result).toEqual(responsePayload.data);
    });

    it('throws a helpful error when the request fails', async () => {
      fetchWithAuthMock.mockResolvedValue(makeResponse({ message: 'Bulk failed' }, false, 500));

      await expect(
        sendBulkCommand(['dev-1', 'dev-2'], 'reboot', { force: true })
      ).rejects.toThrow('Bulk failed');
      expect(fetchWithAuthMock).toHaveBeenCalledWith('/devices/bulk/commands', {
        method: 'POST',
        body: JSON.stringify({
          deviceIds: ['dev-1', 'dev-2'],
          type: 'reboot',
          payload: { force: true }
        })
      });
    });
  });

  describe('toggleMaintenanceMode', () => {
    it('enables maintenance mode with a duration', async () => {
      const payload = {
        data: {
          success: true,
          device: { id: 'dev-1' }
        }
      };

      fetchWithAuthMock.mockResolvedValue(makeResponse(payload));

      const result = await toggleMaintenanceMode('dev-1', true, 4);

      expect(fetchWithAuthMock).toHaveBeenCalledWith('/devices/dev-1/maintenance', {
        method: 'POST',
        body: JSON.stringify({ enable: true, durationHours: 4 })
      });
      expect(result).toEqual(payload.data);
    });

    it('disables maintenance mode without a duration', async () => {
      const payload = {
        data: {
          success: true,
          device: { id: 'dev-1' }
        }
      };

      fetchWithAuthMock.mockResolvedValue(makeResponse(payload));

      const result = await toggleMaintenanceMode('dev-1', false);

      expect(fetchWithAuthMock).toHaveBeenCalledWith('/devices/dev-1/maintenance', {
        method: 'POST',
        body: JSON.stringify({ enable: false })
      });
      expect(result).toEqual(payload.data);
    });

    it('throws a helpful error when the request fails', async () => {
      fetchWithAuthMock.mockResolvedValue(makeResponse({ error: 'Maintenance failed' }, false, 400));

      await expect(toggleMaintenanceMode('dev-1', true)).rejects.toThrow('Maintenance failed');
    });
  });

  describe('executeScript', () => {
    it('executes script with parameters', async () => {
      const execution = {
        batchId: 'batch-1',
        scriptId: 'script-1',
        devicesTargeted: 2,
        executions: [],
        status: 'queued'
      };

      fetchWithAuthMock.mockResolvedValue(makeResponse(execution));

      const result = await executeScript('script-1', ['dev-1', 'dev-2'], { timeout: 120 });

      expect(fetchWithAuthMock).toHaveBeenCalledWith('/scripts/script-1/execute', {
        method: 'POST',
        body: JSON.stringify({ deviceIds: ['dev-1', 'dev-2'], parameters: { timeout: 120 } })
      });
      expect(result).toEqual(execution);
    });

    it('executes script with runAs override', async () => {
      const execution = {
        batchId: 'batch-2',
        scriptId: 'script-2',
        devicesTargeted: 1,
        executions: [],
        status: 'queued'
      };

      fetchWithAuthMock.mockResolvedValue(makeResponse(execution));

      const result = await executeScript('script-2', ['dev-9'], undefined, 'user');

      expect(fetchWithAuthMock).toHaveBeenCalledWith('/scripts/script-2/execute', {
        method: 'POST',
        body: JSON.stringify({ deviceIds: ['dev-9'], runAs: 'user' })
      });
      expect(result).toEqual(execution);
    });

    it('falls back to default message when error body is unreadable', async () => {
      fetchWithAuthMock.mockResolvedValue({
        ok: false,
        status: 500,
        json: vi.fn().mockRejectedValue(new Error('invalid json'))
      } as unknown as Response);

      await expect(executeScript('script-1', ['dev-1'])).rejects.toThrow('Failed to execute script');
    });
  });

  describe('decommissionDevice', () => {
    it('returns success payload on delete', async () => {
      fetchWithAuthMock.mockResolvedValue(makeResponse({ data: { success: true } }));

      const result = await decommissionDevice('dev-1');

      expect(fetchWithAuthMock).toHaveBeenCalledWith('/devices/dev-1', { method: 'DELETE' });
      expect(result).toEqual({ success: true });
    });

    it('throws helpful error on failure', async () => {
      fetchWithAuthMock.mockResolvedValue(makeResponse({ message: 'Delete rejected' }, false, 403));

      await expect(decommissionDevice('dev-1')).rejects.toThrow('Delete rejected');
    });
  });

  describe('sendWakeCommand', () => {
    it('returns the wake response body on a successful dispatch', async () => {
      const wakeResponse = {
        deviceId: 'dev-1',
        type: 'wake_on_lan',
        status: 'dispatched',
        wakeAttemptId: 'wake-1',
        relay: { deviceId: 'relay-1', hostname: 'PEER-01' },
        network: '10.0.1.0/24',
        broadcast: '10.0.1.255',
        macs: ['aa:bb:cc:dd:ee:ff']
      };
      fetchWithAuthMock.mockResolvedValue(makeResponse(wakeResponse));

      const result = await sendWakeCommand('dev-1');

      expect(fetchWithAuthMock).toHaveBeenCalledWith('/devices/dev-1/commands', {
        method: 'POST',
        body: JSON.stringify({ type: 'wake' })
      });
      expect(result).toEqual(wakeResponse);
    });

    it('throws WakeCommandError carrying server-side code and message on 412', async () => {
      // 412 NO_MACS is the most common pre-flight rejection: agent hasn't checked
      // in yet, so we have no MAC to wake. UI relies on .code + .message both
      // being preserved through the throw.
      fetchWithAuthMock.mockResolvedValue(
        makeResponse(
          {
            error:
              'Target has no recorded MAC address. The agent must check in at least once before Wake-on-LAN is available.',
            code: 'NO_MACS'
          },
          false,
          412
        )
      );

      const err = await sendWakeCommand('dev-1').catch((e: unknown) => e);
      expect(err).toBeInstanceOf(WakeCommandError);
      const wakeErr = err as WakeCommandError;
      expect(wakeErr.code).toBe('NO_MACS');
      expect(wakeErr.message).toBe(
        'Target has no recorded MAC address. The agent must check in at least once before Wake-on-LAN is available.'
      );
    });

    it('falls back to a default message when the error body has no error/message fields', async () => {
      fetchWithAuthMock.mockResolvedValue(makeResponse({ code: 'NO_RELAY' }, false, 503));

      const err = await sendWakeCommand('dev-1').catch((e: unknown) => e);
      expect(err).toBeInstanceOf(WakeCommandError);
      expect((err as WakeCommandError).code).toBe('NO_RELAY');
      expect((err as Error).message).toBe('Failed to send wake command');
    });

    it('still throws WakeCommandError when the error body is unparseable JSON', async () => {
      fetchWithAuthMock.mockResolvedValue({
        ok: false,
        status: 500,
        json: vi.fn().mockRejectedValue(new Error('invalid json'))
      } as unknown as Response);

      const err = await sendWakeCommand('dev-1').catch((e: unknown) => e);
      expect(err).toBeInstanceOf(WakeCommandError);
      expect((err as WakeCommandError).code).toBeUndefined();
    });
  });

  describe('watchWakeOutcome', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    it('resolves "online" when the device transitions to online', async () => {
      fetchWithAuthMock
        .mockResolvedValueOnce(makeResponse({ device: { status: 'offline' } }))
        .mockResolvedValueOnce(makeResponse({ device: { status: 'offline' } }))
        .mockResolvedValueOnce(makeResponse({ device: { status: 'online' } }));

      const promise = watchWakeOutcome('dev-1', { pollIntervalMs: 100, timeoutMs: 60_000 });
      await vi.advanceTimersByTimeAsync(350);
      await expect(promise).resolves.toBe('online');
      expect(fetchWithAuthMock).toHaveBeenCalledTimes(3);
      expect(fetchWithAuthMock).toHaveBeenCalledWith('/devices/dev-1');
    });

    it('resolves "timeout" if the device never transitions before timeoutMs', async () => {
      fetchWithAuthMock.mockResolvedValue(makeResponse({ device: { status: 'offline' } }));

      const promise = watchWakeOutcome('dev-1', { pollIntervalMs: 100, timeoutMs: 300 });
      await vi.advanceTimersByTimeAsync(400);
      await expect(promise).resolves.toBe('timeout');
    });

    it('resolves "aborted" when the signal is aborted mid-poll', async () => {
      fetchWithAuthMock.mockResolvedValue(makeResponse({ device: { status: 'offline' } }));
      const ctrl = new AbortController();

      const promise = watchWakeOutcome('dev-1', {
        pollIntervalMs: 1000,
        timeoutMs: 60_000,
        signal: ctrl.signal,
      });
      ctrl.abort();
      await vi.advanceTimersByTimeAsync(50);
      await expect(promise).resolves.toBe('aborted');
    });

    it('keeps polling through transient HTTP errors', async () => {
      fetchWithAuthMock
        .mockRejectedValueOnce(new Error('network down'))
        .mockResolvedValueOnce(makeResponse({ device: { status: 'offline' } }, false, 503))
        .mockResolvedValueOnce(makeResponse({ device: { status: 'online' } }));

      const promise = watchWakeOutcome('dev-1', { pollIntervalMs: 50, timeoutMs: 60_000 });
      await vi.advanceTimersByTimeAsync(200);
      await expect(promise).resolves.toBe('online');
    });

    it('accepts `data` or `device` payload shapes from /devices/:id', async () => {
      fetchWithAuthMock.mockResolvedValueOnce(makeResponse({ data: { status: 'online' } }));

      const promise = watchWakeOutcome('dev-1', { pollIntervalMs: 10, timeoutMs: 60_000 });
      await vi.advanceTimersByTimeAsync(50);
      await expect(promise).resolves.toBe('online');
    });
  });

  describe('wakeFriendlyErrorMessage', () => {
    it('maps every documented failure code to a user-readable string', () => {
      expect(wakeFriendlyErrorMessage('NO_MACS')).toContain('No MAC address');
      expect(wakeFriendlyErrorMessage('NO_SUBNET')).toContain('subnet mask');
      expect(wakeFriendlyErrorMessage('IPV6_ONLY')).toContain('IPv4');
      expect(wakeFriendlyErrorMessage('NO_RELAY')).toContain('online peer agent');
      expect(wakeFriendlyErrorMessage('RELAY_OVERRIDE_INVALID')).toContain('relay');
      expect(wakeFriendlyErrorMessage('WS_SEND_FAILED')).toContain('Try again');
      expect(wakeFriendlyErrorMessage('TARGET_NOT_FOUND')).toContain('Device not found');
    });

    it('returns null for unknown / undefined codes so callers fall back to the raw server message', () => {
      expect(wakeFriendlyErrorMessage(undefined)).toBeNull();
      expect(wakeFriendlyErrorMessage('UNKNOWN_CODE_FROM_FUTURE')).toBeNull();
    });
  });

  describe('bulkDecommissionDevices', () => {
    it('counts succeeded and failed deletions', async () => {
      fetchWithAuthMock
        .mockResolvedValueOnce(makeResponse({ data: { success: true } }))
        .mockResolvedValueOnce(makeResponse({ error: 'not found' }, false, 404))
        .mockResolvedValueOnce(makeResponse({ data: { success: true } }));

      const result = await bulkDecommissionDevices(['dev-1', 'dev-2', 'dev-3']);

      expect(result).toEqual({ succeeded: 2, failed: 1 });
      expect(fetchWithAuthMock).toHaveBeenCalledTimes(3);
    });
  });

  describe('sendBulkWakeCommand', () => {
    it('posts a single bulk request with deviceIds + type=wake', async () => {
      fetchWithAuthMock.mockResolvedValueOnce(
        makeResponse({
          bulkId: 'bulk-abc',
          succeeded: [
            { deviceId: 'd1', commandId: 'c1', wakeAttemptId: 'w1', relayDeviceId: 'r1', relayHostname: 'r1h', broadcast: '10.0.0.255' },
          ],
          failed: [],
        }, true, 202),
      );

      const result = await sendBulkWakeCommand(['d1']);

      expect(fetchWithAuthMock).toHaveBeenCalledTimes(1);
      const [url, init] = fetchWithAuthMock.mock.calls[0]!;
      expect(url).toBe('/devices/bulk/commands');
      expect((init as RequestInit).method).toBe('POST');
      expect(JSON.parse((init as RequestInit).body as string)).toEqual({
        deviceIds: ['d1'],
        type: 'wake',
      });
      expect(result.bulkId).toBe('bulk-abc');
      expect(result.succeeded).toHaveLength(1);
      expect(result.failed).toHaveLength(0);
    });

    it('returns parsed succeeded + failed lists with original failure codes preserved', async () => {
      fetchWithAuthMock.mockResolvedValueOnce(
        makeResponse({
          bulkId: 'bulk-xyz',
          succeeded: [
            { deviceId: 'a', commandId: 'c-a', wakeAttemptId: 'w-a', relayDeviceId: 'r1', relayHostname: 'r1h', broadcast: '10.0.0.255' },
          ],
          failed: [
            { deviceId: 'b', code: 'NO_RELAY', message: 'No online peer.' },
            { deviceId: 'c', code: 'NO_MACS', message: 'No MAC on file.' },
            { deviceId: 'd', code: 'DECOMMISSIONED', message: 'Cannot wake a decommissioned device.' },
          ],
        }, true, 202),
      );

      const result = await sendBulkWakeCommand(['a', 'b', 'c', 'd']);

      expect(result.succeeded.map(s => s.deviceId)).toEqual(['a']);
      expect(result.failed.map(f => f.code)).toEqual(['NO_RELAY', 'NO_MACS', 'DECOMMISSIONED']);
    });

    it('throws on non-OK response so the caller surfaces one error toast', async () => {
      fetchWithAuthMock.mockResolvedValueOnce(
        makeResponse({ error: 'deviceIds exceeds max of 500' }, false, 400),
      );
      await expect(sendBulkWakeCommand(Array.from({ length: 501 }, (_, i) => `d${i}`))).rejects.toThrow(
        /deviceIds exceeds max of 500/,
      );
    });
  });

  describe('summarizeBulkWakeFailures', () => {
    it('returns empty string when nothing failed', () => {
      expect(summarizeBulkWakeFailures([])).toBe('');
    });

    it('groups failures by code with human-readable phrasing', () => {
      const failed: BulkWakeFailed[] = [
        { deviceId: '1', code: 'NO_RELAY', message: '' },
        { deviceId: '2', code: 'NO_RELAY', message: '' },
        { deviceId: '3', code: 'NO_RELAY', message: '' },
        { deviceId: '4', code: 'NO_MACS', message: '' },
        { deviceId: '5', code: 'DECOMMISSIONED', message: '' },
      ];
      const out = summarizeBulkWakeFailures(failed);
      expect(out).toMatch(/3 with no online peer at their site/);
      expect(out).toMatch(/1 with no MAC on file/);
      expect(out).toMatch(/1 decommissioned/);
    });

    it('collapses IPv6_ONLY and NO_SUBNET into one bucket', () => {
      const failed: BulkWakeFailed[] = [
        { deviceId: '1', code: 'NO_SUBNET', message: '' },
        { deviceId: '2', code: 'IPV6_ONLY', message: '' },
      ];
      const out = summarizeBulkWakeFailures(failed);
      // Both map to the same label "with no usable IPv4 history" → one bucket of 2
      expect(out).toBe('2 with no usable IPv4 history');
    });
  });
});
