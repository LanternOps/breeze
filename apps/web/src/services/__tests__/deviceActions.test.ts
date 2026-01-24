import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fetchWithAuth } from '@/stores/auth';
import { sendBulkCommand, sendDeviceCommand, toggleMaintenanceMode } from '../deviceActions';

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
});
