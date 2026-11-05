import { describe, it, expect, vi, beforeEach } from 'vitest';
import { eq, inArray, type SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';

// Mock dependencies before imports
vi.mock('../db', () => ({
  runOutsideDbContext: vi.fn((fn) => fn()),
  withDbAccessContext: vi.fn(async (_ctx: unknown, fn: () => Promise<unknown>) => fn()),
  withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
  db: {
    select: vi.fn(),
  },
}));

vi.mock('./aiDispatch', () => ({
  aiQueueCommandForExecution: vi.fn(),
  aiExecuteCommand: vi.fn(),
}));

import { registerAgentLogTools } from './aiToolsAgentLogs';
import { db } from '../db';
import { aiQueueCommandForExecution, aiExecuteCommand } from './aiDispatch';
import { narrowAuthToCeiling, unreachableWispAuth } from './wisp/chatCeiling';
import type { AiTool } from './aiTools';
import type { AuthContext } from '../middleware/auth';

/** The org-axis closures of a real AuthContext (`buildOrgAccessClosures`). */
function orgClosures(accessibleOrgIds: string[] | null) {
  return {
    orgCondition: (col: any) => {
      if (accessibleOrgIds === null) return undefined;
      return accessibleOrgIds.length === 1 ? eq(col, accessibleOrgIds[0]!) : inArray(col, accessibleOrgIds);
    },
    canAccessOrg: (id: string) => accessibleOrgIds === null || accessibleOrgIds.includes(id),
  };
}

function makeAuth(orgId: string): AuthContext {
  return {
    user: { id: 'user-1' },
    scope: 'organization',
    orgId,
    accessibleOrgIds: [orgId],
    ...orgClosures([orgId]),
    aiOrigin: { kind: 'ai_assistant', sessionId: 'test-session' },
  } as any;
}

/**
 * #10396: a partner login has no `auth.orgId`. `accessibleOrgIds[0]` is just
 * whichever customer org sorts first — here `org-first`, while the device the
 * operator asks about lives in `org-device`.
 */
function makePartnerAuth(accessibleOrgIds: string[] | null = ['org-first', 'org-device']): AuthContext {
  return {
    user: { id: 'user-1' },
    scope: accessibleOrgIds === null ? 'system' : 'partner',
    partnerId: 'partner-1',
    orgId: null,
    accessibleOrgIds,
    ...orgClosures(accessibleOrgIds),
    aiOrigin: { kind: 'ai_assistant', sessionId: 'test-session' },
  } as any;
}

const dialect = new PgDialect();
function rendered(cond: unknown): { sql: string; params: unknown[] } {
  return dialect.sqlToQuery(cond as SQL);
}

/** Capture the WHERE of a log search and return the given rows. */
function mockLogSearch(rows: unknown[] = []) {
  const where = vi.fn().mockReturnValue({
    orderBy: vi.fn().mockReturnValue({ limit: vi.fn().mockResolvedValue(rows) }),
  });
  vi.mocked(db.select).mockReturnValue({ from: vi.fn().mockReturnValue({ where }) } as any);
  return where;
}

/** Capture the WHERE of a device lookup and return the given device. */
function mockDeviceLookup(device: Record<string, unknown> | null = { id: 'dev-1', siteId: null, orgId: 'org-device' }) {
  const where = vi.fn().mockReturnValue({ limit: vi.fn().mockResolvedValue(device ? [device] : []) });
  vi.mocked(db.select).mockReturnValue({ from: vi.fn().mockReturnValue({ where }) } as any);
  return where;
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
          createdAt: new Date('2026-02-15T10:00:05Z'),
          level: 'error',
          component: 'heartbeat',
          message: 'connection failed',
          fields: { retries: 3 },
          agentVersion: '1.0.0',
        },
      ];
      const orderBy = vi.fn().mockReturnValue({
        limit: vi.fn().mockResolvedValue(mockRows),
      });

      vi.mocked(db.select).mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            orderBy,
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
      expect(parsed.logs[0].receivedAt).toBe('2026-02-15T10:00:05.000Z');
      // Receipt time dominates; the random uuid id is the tiebreak so the
      // sort key is total (A-W05 5b: matches the keyset predicate's
      // `(created_at, id)` comparison exactly — `timestamp` dropped from the
      // ORDER BY).
      const dialect = new PgDialect();
      const orderingSql = (orderBy.mock.calls[0] as SQL[])
        .map((clause) => dialect.sqlToQuery(clause).sql)
        .join(', ');
      expect(orderingSql).toContain('"created_at"');
      expect(orderingSql.indexOf('"id"')).toBeGreaterThan(orderingSql.indexOf('"created_at"'));
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
                createdAt: new Date('2026-02-15T10:00:05Z'),
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
      // A-W05 5b: `fields` is opt-in (`includeFields`) — request it here so
      // the redaction-on-fields assertion below still means something.
      const result = await tool.handler({ includeFields: true }, makeAuth('org-1'));

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

      // The limit is clamped to 500, then the query over-fetches by one
      // (A-W05 5b keyset mode) to detect hasMore without a COUNT.
      const limitFn = vi.mocked(db.select).mock.results[0]!.value.from().where().orderBy().limit;
      expect(limitFn).toHaveBeenCalledWith(501);
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

    // #7416: the tool used to return "queued" whether or not the agent ever
    // ran the command. It now waits for the result and reports what the
    // agent actually applied.
    it('reports the level the agent applied, from the command result', async () => {
      mockDeviceSelect('dev-1');
      vi.mocked(aiExecuteCommand).mockResolvedValue({
        status: 'completed',
        commandId: 'cmd-123',
        stdout: JSON.stringify({
          newLevel: 'debug',
          appliedLevel: 'debug',
          baseLevel: 'warn',
          durationMinutes: 30,
          expiresAt: '2026-09-30T13:00:00Z',
          persisted: true,
        }),
      } as any);

      const tool = tools.get('set_agent_log_level')!;
      const result = await tool.handler(
        { deviceId: 'dev-1', level: 'debug', durationMinutes: 30 },
        makeAuth('org-1'),
      );

      const parsed = JSON.parse(result);
      expect(parsed.error).toBeUndefined();
      expect(parsed.status).toBe('applied');
      expect(parsed.commandId).toBe('cmd-123');
      expect(parsed.appliedLevel).toBe('debug');
      expect(parsed.baseLevel).toBe('warn');
      expect(parsed.expiresAt).toBe('2026-09-30T13:00:00Z');
      expect(parsed.durationMinutes).toBe(30);
      expect(parsed.persisted).toBe(true);
      expect(parsed.warning).toBeUndefined();
      // persisted only means the file was written; say how helpers get it.
      expect(parsed.note).toMatch(/helper/i);
      expect(parsed.note).toMatch(/30 seconds/);

      expect(aiExecuteCommand).toHaveBeenCalledWith(
        expect.anything(),
        'set_agent_log_level',
        'dev-1',
        'set_log_level',
        { level: 'debug', durationMinutes: 30 },
        { userId: 'user-1', timeoutMs: 30000 },
      );
      expect(aiQueueCommandForExecution).not.toHaveBeenCalled();
    });

    it('warns when the agent applied the level but could not persist it', async () => {
      mockDeviceSelect('dev-1');
      vi.mocked(aiExecuteCommand).mockResolvedValue({
        status: 'completed',
        commandId: 'cmd-9',
        stdout: JSON.stringify({
          newLevel: 'info', appliedLevel: 'info', baseLevel: 'warn', durationMinutes: 60,
          expiresAt: '2026-09-30T13:00:00Z', persisted: false, persistError: 'permission denied',
        }),
      } as any);

      const result = await tools.get('set_agent_log_level')!.handler(
        { deviceId: 'dev-1', level: 'info' },
        makeAuth('org-1'),
      );

      const parsed = JSON.parse(result);
      expect(parsed.appliedLevel).toBe('info');
      expect(parsed.persisted).toBe(false);
      expect(parsed.warning).toMatch(/restart/);
      expect(parsed.warning).toMatch(/helper/);
      expect(parsed.warning).toContain('permission denied');
    });

    it('flags an older agent that reports no persistence field', async () => {
      mockDeviceSelect('dev-1');
      vi.mocked(aiExecuteCommand).mockResolvedValue({
        status: 'completed',
        commandId: 'cmd-old',
        stdout: JSON.stringify({ newLevel: 'debug', durationMinutes: 60 }),
      } as any);

      const result = await tools.get('set_agent_log_level')!.handler(
        { deviceId: 'dev-1', level: 'debug' },
        makeAuth('org-1'),
      );

      const parsed = JSON.parse(result);
      expect(parsed.status).toBe('applied');
      expect(parsed.appliedLevel).toBe('debug');
      expect(parsed.persisted).toBe(false);
      expect(parsed.warning).toMatch(/restart/);
    });

    it('gives a reason when the agent reports a non-boolean persisted value', async () => {
      mockDeviceSelect('dev-1');
      vi.mocked(aiExecuteCommand).mockResolvedValue({
        status: 'completed',
        commandId: 'cmd-odd',
        stdout: JSON.stringify({ appliedLevel: 'debug', durationMinutes: 60, persisted: 'yes' }),
      } as any);

      const parsed = JSON.parse(await tools.get('set_agent_log_level')!.handler(
        { deviceId: 'dev-1', level: 'debug' },
        makeAuth('org-1'),
      ));
      expect(parsed.persisted).toBe(false);
      expect(parsed.warning).toMatch(/did not report whether/);
    });

    it('returns an error, not success, when the agent reports failure', async () => {
      mockDeviceSelect('dev-1');
      vi.mocked(aiExecuteCommand).mockResolvedValue({
        status: 'failed',
        commandId: 'cmd-f',
        error: 'log shipper not initialized',
      } as any);

      const result = await tools.get('set_agent_log_level')!.handler(
        { deviceId: 'dev-1', level: 'debug' },
        makeAuth('org-1'),
      );

      const parsed = JSON.parse(result);
      expect(parsed.error).toContain('log shipper not initialized');
      expect(parsed.commandId).toBe('cmd-f');
      expect(parsed.status).toBeUndefined();
    });

    it('returns an unconfirmed error when the agent does not answer in time', async () => {
      mockDeviceSelect('dev-1');
      vi.mocked(aiExecuteCommand).mockResolvedValue({
        status: 'timeout',
        commandId: 'cmd-t',
        error: 'Command timed out',
      } as any);

      const result = await tools.get('set_agent_log_level')!.handler(
        { deviceId: 'dev-1', level: 'debug' },
        makeAuth('org-1'),
      );

      const parsed = JSON.parse(result);
      expect(parsed.error).toMatch(/not confirm/i);
      expect(parsed.commandId).toBe('cmd-t');
      expect(parsed.status).toBeUndefined();
    });

    it('returns an error when a completed result carries no applied level', async () => {
      mockDeviceSelect('dev-1');
      vi.mocked(aiExecuteCommand).mockResolvedValue({
        status: 'completed',
        commandId: 'cmd-x',
        stdout: '',
      } as any);

      const result = await tools.get('set_agent_log_level')!.handler(
        { deviceId: 'dev-1', level: 'debug' },
        makeAuth('org-1'),
      );

      const parsed = JSON.parse(result);
      expect(parsed.error).toBeDefined();
      expect(parsed.commandId).toBe('cmd-x');
    });

    it('should default durationMinutes to 60', async () => {
      mockDeviceSelect('dev-1');
      vi.mocked(aiExecuteCommand).mockResolvedValue({
        status: 'completed',
        commandId: 'cmd-456',
        stdout: JSON.stringify({ appliedLevel: 'info', newLevel: 'info', durationMinutes: 60, persisted: true }),
      } as any);

      const tool = tools.get('set_agent_log_level')!;
      await tool.handler(
        { deviceId: 'dev-1', level: 'info' },
        makeAuth('org-1'),
      );

      expect(aiExecuteCommand).toHaveBeenCalledWith(
        expect.anything(),
        'set_agent_log_level',
        'dev-1',
        'set_log_level',
        { level: 'info', durationMinutes: 60 },
        { userId: 'user-1', timeoutMs: 30000 },
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
      expect(aiExecuteCommand).not.toHaveBeenCalled();
    });

    it('should reject an unknown profile without dispatching a command', async () => {
      const tool = tools.get('capture_agent_pprof')!;
      const result = await tool.handler(
        { deviceId: 'dev-1', profile: 'cpu' },
        makeAuth('org-1'),
      );
      const parsed = JSON.parse(result);
      expect(parsed.error).toContain('Invalid profile "cpu"');
      expect(aiExecuteCommand).not.toHaveBeenCalled();
    });

    it('should execute the capture_pprof command type and default profile to all', async () => {
      mockDeviceSelect('dev-1');
      vi.mocked(aiExecuteCommand).mockResolvedValue({
        status: 'completed',
        stdout: capturedStdout,
        commandId: 'cmd-pprof-1',
      } as any);

      const tool = tools.get('capture_agent_pprof')!;
      const result = await tool.handler({ deviceId: 'dev-1' }, makeAuth('org-1'));

      expect(aiExecuteCommand).toHaveBeenCalledWith(
        expect.anything(),
        'capture_agent_pprof',
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
      vi.mocked(aiExecuteCommand).mockResolvedValue({
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

      expect(aiExecuteCommand).toHaveBeenCalledWith(
        expect.anything(),
        'capture_agent_pprof',
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
      vi.mocked(aiExecuteCommand).mockResolvedValue({
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
      expect(aiExecuteCommand).not.toHaveBeenCalled();
    });

    it('should surface command failure', async () => {
      mockDeviceSelect('dev-1');
      vi.mocked(aiExecuteCommand).mockResolvedValue({
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
      vi.mocked(aiExecuteCommand).mockResolvedValue({
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
      vi.mocked(aiExecuteCommand).mockResolvedValue({
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

// #10396: a partner-wide session (no `auth.orgId`) used to be pinned to
// `accessibleOrgIds[0]`, so logs of every device outside that one org were
// silently filtered out ("no agent logs at all, even unfiltered").
describe('aiToolsAgentLogs — org scope for a partner caller (#10396)', () => {
  let tools: Map<string, AiTool>;

  beforeEach(() => {
    vi.clearAllMocks();
    tools = new Map();
    registerAgentLogTools(tools);
  });

  it('search_agent_logs without orgId reads every org the caller reaches, not accessibleOrgIds[0]', async () => {
    const where = mockLogSearch();
    const result = JSON.parse(await tools.get('search_agent_logs')!.handler({ deviceIds: ['dev-1'] }, makePartnerAuth()));
    expect(result.error).toBeUndefined();
    const { sql: text, params } = rendered(where.mock.calls[0]![0]);
    expect(text).toMatch(/"agent_logs"\."org_id" in \(\$\d+, \$\d+\)/);
    expect(params).toEqual(expect.arrayContaining(['org-first', 'org-device', 'dev-1']));
    expect(result.scope).toEqual({ allAccessibleOrgs: true, orgCount: 2 });
  });

  it('search_agent_logs with an accessible orgId reads only that org', async () => {
    const where = mockLogSearch();
    const result = JSON.parse(await tools.get('search_agent_logs')!.handler({ orgId: 'org-device' }, makePartnerAuth()));
    const { sql: text, params } = rendered(where.mock.calls[0]![0]);
    expect(text).toMatch(/"agent_logs"\."org_id" = \$\d+/);
    expect(params).toContain('org-device');
    expect(params).not.toContain('org-first');
    expect(result.scope).toEqual({ orgId: 'org-device' });
  });

  it('search_agent_logs refuses an orgId outside the caller reach without querying', async () => {
    const result = JSON.parse(await tools.get('search_agent_logs')!.handler({ orgId: 'org-elsewhere' }, makePartnerAuth()));
    expect(result.error).toBe('Access denied to this organization');
    expect(db.select).not.toHaveBeenCalled();
  });

  it('search_agent_logs fails closed for an unrestricted caller that names no org', async () => {
    const result = JSON.parse(await tools.get('search_agent_logs')!.handler({}, makePartnerAuth(null)));
    expect(result.error).toMatch(/orgId is required/);
    expect(db.select).not.toHaveBeenCalled();
  });

  it('search_agent_logs keeps the exact-device axis across orgs for a device-LESS run', async () => {
    const where = mockLogSearch();
    const auth = { ...makePartnerAuth(), allowedDeviceIds: ['dev-a'] } as AuthContext;
    await tools.get('search_agent_logs')!.handler({}, auth);
    const { sql: text, params } = rendered(where.mock.calls[0]![0]);
    expect(text).toMatch(/"agent_logs"\."org_id" in \(\$\d+, \$\d+\)/);
    expect(text).toMatch(/"agent_logs"\."device_id" in \(\$\d+\)/);
    expect(params).toContain('dev-a');
  });

  it('device commands stay refused for an unrestricted (system) caller, as before', async () => {
    const pprof = JSON.parse(await tools.get('capture_agent_pprof')!.handler({ deviceId: 'dev-1' }, makePartnerAuth(null)));
    const level = JSON.parse(await tools.get('set_agent_log_level')!.handler({ deviceId: 'dev-1', level: 'debug' }, makePartnerAuth(null)));
    expect(pprof.error).toBe('No organization context available');
    expect(level.error).toBe('No organization context available');
    expect(db.select).not.toHaveBeenCalled();
    expect(aiExecuteCommand).not.toHaveBeenCalled();
  });

  it('buildAgentLogConditions keeps a single org as `=` (export_dataset passes one org)', async () => {
    const { buildAgentLogConditions } = await import('./aiToolsAgentLogs');
    for (const orgArg of ['org-1', ['org-1']] as const) {
      const conds = await buildAgentLogConditions(orgArg, makeAuth('org-1'), {});
      const { sql: text, params } = rendered(conds![0]);
      expect(text).toBe('"agent_logs"."org_id" = $1');
      expect(params).toEqual(['org-1']);
    }
  });

  it('the input schemas keep orgId instead of stripping it', async () => {
    const { toolInputSchemas } = await import('./aiToolSchemas');
    const org = '11111111-1111-4111-8111-111111111111';
    expect(toolInputSchemas.search_agent_logs!.parse({ orgId: org })).toMatchObject({ orgId: org });
    expect(() => toolInputSchemas.search_agent_logs!.parse({ orgId: 'not-a-uuid' })).toThrow();
    expect(toolInputSchemas.manage_patches!.parse({ action: 'compliance', orgId: org })).toMatchObject({ orgId: org });
  });

  // Security review on the PR: Wisp's ceiling narrowing keeps `auth.orgId`
  // while cutting the reach. The real `unreachableWispAuth` /
  // `narrowAuthToCeiling` shapes must not let a read land in that org.
  it('search_agent_logs reads nothing under unreachableWispAuth, even with auth.orgId set', async () => {
    const closed = unreachableWispAuth({ ...makeAuth('org-1'), partnerOrgAccess: null } as AuthContext);
    expect(closed.orgId).toBe('org-1');
    const result = JSON.parse(await tools.get('search_agent_logs')!.handler({}, closed));
    expect(result.error).toBe('Access denied to this organization');
    expect(db.select).not.toHaveBeenCalled();
  });

  it('search_agent_logs refuses a carried auth.orgId the grant ceiling excludes', async () => {
    const ceiling = {
      grantId: 'g1', revisionId: 'r1', partnerId: 'partner-1', grantorUserId: 'user-1',
      scopeOrgId: null, partnerWide: false, status: 'active',
      orgIds: new Set(['org-first']), siteIds: null,
      permissionKeys: new Set<string>(), toolAllowlist: null, deniedTools: new Set<string>(),
      orgTerms: new Map(),
    } as any;
    const login = { ...makePartnerAuth(['org-first', 'org-device']), orgId: 'org-device' } as AuthContext;
    const narrowed = narrowAuthToCeiling(login, ceiling, 's1', []);
    expect(narrowed.accessibleOrgIds).toEqual(['org-first']);
    expect(narrowed.orgId).toBe('org-device');
    expect(narrowed.canAccessOrg('org-device')).toBe(false);
    const result = JSON.parse(await tools.get('search_agent_logs')!.handler({}, narrowed));
    expect(result.error).toBe('Access denied to this organization');
    expect(db.select).not.toHaveBeenCalled();
  });

  it('set_agent_log_level finds a device in any reachable org, bounded by the caller reach', async () => {
    const where = mockDeviceLookup({ id: 'dev-1', siteId: null, orgId: 'org-device' });
    vi.mocked(aiExecuteCommand).mockResolvedValue({
      status: 'completed', commandId: 'cmd-1', stdout: JSON.stringify({ appliedLevel: 'debug', persisted: true }),
    } as any);
    const result = JSON.parse(await tools.get('set_agent_log_level')!.handler({ deviceId: 'dev-1', level: 'debug' }, makePartnerAuth()));
    expect(result.status).toBe('applied');
    const { sql: text, params } = rendered(where.mock.calls[0]![0]);
    expect(text).toMatch(/"devices"\."org_id" in \(\$\d+, \$\d+\)/);
    expect(params).toEqual(expect.arrayContaining(['dev-1', 'org-first', 'org-device']));
  });

  it('capture_agent_pprof finds a device in any reachable org, bounded by the caller reach', async () => {
    const where = mockDeviceLookup({ id: 'dev-1', siteId: null, orgId: 'org-device' });
    vi.mocked(aiExecuteCommand).mockResolvedValue({
      status: 'completed', commandId: 'cmd-2', stdout: JSON.stringify({ heapProfileBytes: 10 }),
    } as any);
    const result = JSON.parse(await tools.get('capture_agent_pprof')!.handler({ deviceId: 'dev-1' }, makePartnerAuth()));
    expect(result.status).toBe('completed');
    const { sql: text, params } = rendered(where.mock.calls[0]![0]);
    expect(text).toMatch(/"devices"\."org_id" in \(\$\d+, \$\d+\)/);
    expect(params).toEqual(expect.arrayContaining(['dev-1', 'org-first', 'org-device']));
  });
});

describe('exported builders for export_dataset reuse', () => {
  it('exports the shared agent-log predicate builder', async () => {
    const mod = await import('./aiToolsAgentLogs');
    expect(typeof mod.buildAgentLogConditions).toBe('function');
  });
});
