import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock dependencies before imports
vi.mock('../db', () => ({
  runOutsideDbContext: vi.fn((fn) => fn()),
  withDbAccessContext: vi.fn(async (_ctx: unknown, fn: () => Promise<unknown>) => fn()),
  withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
  db: {
    select: vi.fn(),
  },
}));

vi.mock('./commandQueue', () => ({
  queueCommandForExecution: vi.fn(),
  executeCommand: vi.fn(),
}));

import { registerAgentLogTools } from './aiToolsAgentLogs';
import { db } from '../db';
import { queueCommandForExecution, executeCommand } from './commandQueue';
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

  it('should register search_agent_logs, set_agent_log_level and capture_agent_pprof', () => {
    expect(tools.has('search_agent_logs')).toBe(true);
    expect(tools.has('set_agent_log_level')).toBe(true);
    expect(tools.has('capture_agent_pprof')).toBe(true);
  });

  it('search_agent_logs should be tier 1', () => {
    const tool = tools.get('search_agent_logs')!;
    expect(tool.tier).toBe(1);
  });

  it('set_agent_log_level should be tier 2', () => {
    const tool = tools.get('set_agent_log_level')!;
    expect(tool.tier).toBe(2);
  });

  it('capture_agent_pprof should be tier 2 with deviceId device arg', () => {
    const tool = tools.get('capture_agent_pprof')!;
    expect(tool.tier).toBe(2);
    expect(tool.deviceArgs).toEqual(['deviceId']);
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

    it('redacts legacy raw secrets before returning log search results', async () => {
      vi.mocked(db.select).mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            orderBy: vi.fn().mockReturnValue({
              limit: vi.fn().mockResolvedValue([{
                id: 'log-1',
                deviceId: 'dev-1',
                timestamp: new Date('2026-02-15T10:00:00Z'),
                level: 'error',
                component: 'heartbeat',
                message: 'failed token=raw-token',
                fields: { apiKey: 'raw-key' },
                agentVersion: '1.0.0',
              }]),
            }),
          }),
        }),
      } as any);

      const tool = tools.get('search_agent_logs')!;
      const result = await tool.handler({}, makeAuth('org-1'));

      const parsed = JSON.parse(result);
      expect(parsed.logs[0]).toMatchObject({
        message: 'failed token=[REDACTED]',
        fields: { apiKey: '[REDACTED]' },
      });
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

  describe('capture_agent_pprof', () => {
    const capturedStdout = JSON.stringify({
      capturedAt: '2026-07-12T10:00:00Z',
      runtime: { heapAllocBytes: 1024, goroutines: 42 },
      heapProfileBase64: 'aGVhcC1wcm9maWxlLWJ5dGVz',
      heapProfileBytes: 2048,
      goroutineProfileBase64: 'Z29yb3V0aW5lLXByb2ZpbGUtYnl0ZXM=',
      goroutineProfileBytes: 512,
    });

    it('should return error without org context', async () => {
      const tool = tools.get('capture_agent_pprof')!;
      const result = await tool.handler({ deviceId: 'dev-1' }, { user: { id: 'u1' } } as any);
      const parsed = JSON.parse(result);
      expect(parsed.error).toContain('No organization context');
    });

    it('should return error without deviceId', async () => {
      const tool = tools.get('capture_agent_pprof')!;
      const result = await tool.handler({}, makeAuth('org-1'));
      const parsed = JSON.parse(result);
      expect(parsed.error).toContain('deviceId is required');
      expect(executeCommand).not.toHaveBeenCalled();
    });

    it('should reject an unknown profile without dispatching a command', async () => {
      const tool = tools.get('capture_agent_pprof')!;
      const result = await tool.handler(
        { deviceId: 'dev-1', profile: 'cpu' },
        makeAuth('org-1'),
      );
      const parsed = JSON.parse(result);
      expect(parsed.error).toContain('Invalid profile "cpu"');
      expect(executeCommand).not.toHaveBeenCalled();
    });

    it('should execute the capture_pprof command type and default profile to all', async () => {
      mockDeviceSelect('dev-1');
      vi.mocked(executeCommand).mockResolvedValue({
        status: 'completed',
        stdout: capturedStdout,
        commandId: 'cmd-pprof-1',
      } as any);

      const tool = tools.get('capture_agent_pprof')!;
      const result = await tool.handler({ deviceId: 'dev-1' }, makeAuth('org-1'));

      expect(executeCommand).toHaveBeenCalledWith(
        'dev-1',
        'capture_pprof',
        { profile: 'all' },
        { userId: 'user-1', timeoutMs: 30000 },
      );

      const parsed = JSON.parse(result);
      expect(parsed.status).toBe('completed');
      expect(parsed.commandId).toBe('cmd-pprof-1');
      expect(parsed.capturedAt).toBe('2026-07-12T10:00:00Z');
      expect(parsed.runtime).toEqual({ heapAllocBytes: 1024, goroutines: 42 });
      expect(parsed.profiles).toEqual({
        heap: { sizeBytes: 2048 },
        goroutine: { sizeBytes: 512 },
      });
    });

    it('should pass an explicit profile through to the agent command', async () => {
      mockDeviceSelect('dev-1');
      vi.mocked(executeCommand).mockResolvedValue({
        status: 'completed',
        stdout: JSON.stringify({
          capturedAt: '2026-07-12T10:00:00Z',
          runtime: { goroutines: 7 },
          goroutineProfileBase64: 'Zm9v',
          goroutineProfileBytes: 3,
        }),
        commandId: 'cmd-pprof-2',
      } as any);

      const tool = tools.get('capture_agent_pprof')!;
      const result = await tool.handler(
        { deviceId: 'dev-1', profile: 'goroutine' },
        makeAuth('org-1'),
      );

      expect(executeCommand).toHaveBeenCalledWith(
        'dev-1',
        'capture_pprof',
        { profile: 'goroutine' },
        { userId: 'user-1', timeoutMs: 30000 },
      );
      const parsed = JSON.parse(result);
      expect(parsed.profiles).toEqual({ goroutine: { sizeBytes: 3 } });
    });

    it('must NOT inline base64 profile data into the tool output', async () => {
      mockDeviceSelect('dev-1');
      vi.mocked(executeCommand).mockResolvedValue({
        status: 'completed',
        stdout: capturedStdout,
        commandId: 'cmd-pprof-3',
      } as any);

      const tool = tools.get('capture_agent_pprof')!;
      const result = await tool.handler({ deviceId: 'dev-1' }, makeAuth('org-1'));

      expect(result).not.toContain('aGVhcC1wcm9maWxlLWJ5dGVz');
      expect(result).not.toContain('Z29yb3V0aW5lLXByb2ZpbGUtYnl0ZXM=');
      // But it must tell the caller where to get the artifact.
      const parsed = JSON.parse(result);
      expect(parsed.retrieval).toContain('/devices/dev-1/commands/cmd-pprof-3');
    });

    it('should return error when device is not in the org', async () => {
      vi.mocked(db.select).mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([]),
          }),
        }),
      } as any);

      const tool = tools.get('capture_agent_pprof')!;
      const result = await tool.handler({ deviceId: 'dev-other' }, makeAuth('org-1'));
      const parsed = JSON.parse(result);
      expect(parsed.error).toContain('Device not found or access denied');
      expect(executeCommand).not.toHaveBeenCalled();
    });

    it('should surface command failure', async () => {
      mockDeviceSelect('dev-1');
      vi.mocked(executeCommand).mockResolvedValue({
        status: 'failed',
        error: 'Device is offline, cannot execute command',
      } as any);

      const tool = tools.get('capture_agent_pprof')!;
      const result = await tool.handler({ deviceId: 'dev-1' }, makeAuth('org-1'));
      const parsed = JSON.parse(result);
      expect(parsed.error).toBe('Device is offline, cannot execute command');
    });

    it('should handle unparseable agent output and still return the commandId', async () => {
      mockDeviceSelect('dev-1');
      vi.mocked(executeCommand).mockResolvedValue({
        status: 'completed',
        stdout: 'not-json',
        commandId: 'cmd-pprof-4',
      } as any);

      const tool = tools.get('capture_agent_pprof')!;
      const result = await tool.handler({ deviceId: 'dev-1' }, makeAuth('org-1'));
      const parsed = JSON.parse(result);
      expect(parsed.error).toContain('Failed to parse profile capture response');
      expect(parsed.commandId).toBe('cmd-pprof-4');
    });

    it('should NOT report success when a completed result carries no profile data', async () => {
      mockDeviceSelect('dev-1');
      vi.mocked(executeCommand).mockResolvedValue({
        status: 'completed',
        // Valid JSON but no heapProfileBytes/goroutineProfileBytes fields
        // (agent/API contract drift or stdout lost in transit).
        stdout: JSON.stringify({ capturedAt: '2026-07-12T10:00:00Z' }),
        commandId: 'cmd-pprof-5',
      } as any);

      const tool = tools.get('capture_agent_pprof')!;
      const result = await tool.handler({ deviceId: 'dev-1' }, makeAuth('org-1'));
      const parsed = JSON.parse(result);
      expect(parsed.status).toBeUndefined();
      expect(parsed.error).toContain('no profile data');
      expect(parsed.commandId).toBe('cmd-pprof-5');
    });
  });
});
