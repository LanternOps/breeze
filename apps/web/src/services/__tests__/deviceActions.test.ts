import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fetchWithAuth } from '@/stores/auth';
import {
  bulkDecommissionDevices,
  decommissionDevice,
  executeScript,
  sendBulkCommand,
  sendDeviceCommand,
  toggleMaintenanceMode
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
  }) as Response;

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

    it('falls back to default message when error body is unreadable', async () => {
      fetchWithAuthMock.mockResolvedValue({
        ok: false,
        status: 500,
        json: vi.fn().mockRejectedValue(new Error('invalid json'))
      } as Response);

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
});
