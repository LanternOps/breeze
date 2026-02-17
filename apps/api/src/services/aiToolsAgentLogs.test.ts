import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock dependencies before imports
vi.mock('../db', () => ({
  db: {
    select: vi.fn(),
  },
}));

vi.mock('./commandQueue', () => ({
  queueCommandForExecution: vi.fn(),
}));

import { registerAgentLogTools } from './aiToolsAgentLogs';
import { db } from '../db';
import { queueCommandForExecution } from './commandQueue';
import type { AiTool } from './aiTools';
import type { AuthContext } from '../middleware/auth';

function makeAuth(orgId: string): AuthContext {
  return {
    user: { id: 'user-1' },
    orgId,
    accessibleOrgIds: [orgId],
  } as any;
}

/** Mock db.select chain to return a device for org-scoped lookups */
function mockDeviceSelect(deviceId = 'dev-1') {
  vi.mocked(db.select).mockReturnValue({
    from: vi.fn().mockReturnValue({
      where: vi.fn().mockReturnValue({
        limit: vi.fn().mockResolvedValue([{ id: deviceId }]),
      }),
    }),
  } as any);
}

describe('aiToolsAgentLogs', () => {
  let tools: Map<string, AiTool>;

  beforeEach(() => {
    vi.clearAllMocks();
    tools = new Map();
    registerAgentLogTools(tools);
  });

  it('should register search_agent_logs and set_agent_log_level', () => {
    expect(tools.has('search_agent_logs')).toBe(true);
    expect(tools.has('set_agent_log_level')).toBe(true);
  });

  it('search_agent_logs should be tier 1', () => {
    const tool = tools.get('search_agent_logs')!;
    expect(tool.tier).toBe(1);
  });

  it('set_agent_log_level should be tier 2', () => {
    const tool = tools.get('set_agent_log_level')!;
    expect(tool.tier).toBe(2);
  });

  describe('search_agent_logs', () => {
    it('should return error without org context', async () => {
      const tool = tools.get('search_agent_logs')!;
      const result = await tool.handler({}, { user: { id: 'u1' } } as any);
      const parsed = JSON.parse(result);
      expect(parsed.error).toContain('No organization context');
    });

    it('should query logs with filters', async () => {
      const mockRows = [
        {
          id: 'log-1',
          deviceId: 'dev-1',
          timestamp: new Date('2026-02-15T10:00:00Z'),
          level: 'error',
          component: 'heartbeat',
          message: 'connection failed',
          fields: { retries: 3 },
          agentVersion: '1.0.0',
        },
      ];

      vi.mocked(db.select).mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            orderBy: vi.fn().mockReturnValue({
              limit: vi.fn().mockResolvedValue(mockRows),
            }),
          }),
        }),
      } as any);

      const tool = tools.get('search_agent_logs')!;
      const result = await tool.handler(
        { level: 'error', component: 'heartbeat', limit: 50 },
        makeAuth('org-1'),
      );

      const parsed = JSON.parse(result);
      expect(parsed.count).toBe(1);
      expect(parsed.logs[0].message).toBe('connection failed');
      expect(parsed.logs[0].level).toBe('error');
      expect(parsed.logs[0].timestamp).toBe('2026-02-15T10:00:00.000Z');
    });

    it('should cap limit at 500', async () => {
      vi.mocked(db.select).mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            orderBy: vi.fn().mockReturnValue({
              limit: vi.fn().mockResolvedValue([]),
            }),
          }),
        }),
      } as any);

      const tool = tools.get('search_agent_logs')!;
      await tool.handler({ limit: 9999 }, makeAuth('org-1'));

      // The limit call should have been called with 500
      const limitFn = vi.mocked(db.select).mock.results[0]!.value.from().where().orderBy().limit;
      expect(limitFn).toHaveBeenCalledWith(500);
    });

    it('should handle DB errors gracefully', async () => {
      vi.mocked(db.select).mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockImplementation(() => {
            throw new Error('DB connection failed');
          }),
        }),
      } as any);

      const tool = tools.get('search_agent_logs')!;
      const result = await tool.handler({}, makeAuth('org-1'));
      const parsed = JSON.parse(result);
      expect(parsed.error).toContain('Search failed');
    });
  });

  describe('set_agent_log_level', () => {
    it('should return error without org context', async () => {
      const tool = tools.get('set_agent_log_level')!;
      const result = await tool.handler(
        { deviceId: 'dev-1', level: 'debug' },
        { user: { id: 'u1' } } as any,
      );
      const parsed = JSON.parse(result);
      expect(parsed.error).toContain('No organization context');
    });

    it('should return error without deviceId', async () => {
      const tool = tools.get('set_agent_log_level')!;
      const result = await tool.handler(
        { level: 'debug' },
        makeAuth('org-1'),
      );
      const parsed = JSON.parse(result);
      expect(parsed.error).toContain('deviceId and level are required');
    });

    it('should queue command on success', async () => {
      mockDeviceSelect('dev-1');
      vi.mocked(queueCommandForExecution).mockResolvedValue({
        command: { id: 'cmd-123' },
        error: null,
      } as any);

      const tool = tools.get('set_agent_log_level')!;
      const result = await tool.handler(
        { deviceId: 'dev-1', level: 'debug', durationMinutes: 30 },
        makeAuth('org-1'),
      );

      const parsed = JSON.parse(result);
      expect(parsed.status).toBe('queued');
      expect(parsed.commandId).toBe('cmd-123');
      expect(parsed.message).toContain('debug');
      expect(parsed.message).toContain('30 minutes');

      expect(queueCommandForExecution).toHaveBeenCalledWith(
        'dev-1',
        'set_log_level',
        { level: 'debug', durationMinutes: 30 },
        { userId: 'user-1' },
      );
    });

    it('should return error from command queue', async () => {
      mockDeviceSelect('dev-1');
      vi.mocked(queueCommandForExecution).mockResolvedValue({
        command: null,
        error: 'Device offline',
      } as any);

      const tool = tools.get('set_agent_log_level')!;
      const result = await tool.handler(
        { deviceId: 'dev-1', level: 'debug' },
        makeAuth('org-1'),
      );

      const parsed = JSON.parse(result);
      expect(parsed.error).toBe('Device offline');
    });

    it('should default durationMinutes to 60', async () => {
      mockDeviceSelect('dev-1');
      vi.mocked(queueCommandForExecution).mockResolvedValue({
        command: { id: 'cmd-456' },
        error: null,
      } as any);

      const tool = tools.get('set_agent_log_level')!;
      await tool.handler(
        { deviceId: 'dev-1', level: 'info' },
        makeAuth('org-1'),
      );

      expect(queueCommandForExecution).toHaveBeenCalledWith(
        'dev-1',
        'set_log_level',
        { level: 'info', durationMinutes: 60 },
        { userId: 'user-1' },
      );
    });
  });
});
