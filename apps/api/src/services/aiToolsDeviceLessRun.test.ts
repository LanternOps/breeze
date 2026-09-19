/**
 * RC3 — the device-LESS analysis run shape (#6096).
 *
 * `agentAuthContext.ts` produces two restricted shapes:
 *   - device-BOUND run:  allowedSiteIds = [site of device], canAccessSite, allowedDeviceIds = [deviceId]
 *   - device-LESS run:   allowedDeviceIds = [...]           and NO allowedSiteIds
 *
 * Every guard written `if (auth.allowedSiteIds && …)` silently no-ops for the
 * second shape, so the run reads ORG-WIDE. These tests pin the device axis for
 * the tools this agent owns: with `allowedDeviceIds: ['d-1']` and no site axis,
 * each tool must narrow to d-1 and never touch d-2.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../db', () => ({
  runOutsideDbContext: vi.fn((fn: any) => fn()),
  withDbAccessContext: vi.fn(async (_ctx: unknown, fn: () => Promise<unknown>) => fn()),
  withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
  db: { select: vi.fn(), insert: vi.fn(), update: vi.fn(), delete: vi.fn(), transaction: vi.fn() },
}));

// Pass-through spy on `inArray` so a test can prove WHICH column was narrowed
// to WHICH ids — an empty-set short-circuit assertion cannot catch a mis-wired
// column, and the device axis is exactly a column+id-set claim.
vi.mock('drizzle-orm', async (importOriginal) => {
  const actual = await importOriginal<typeof import('drizzle-orm')>();
  return { ...actual, inArray: vi.fn(actual.inArray) };
});

const logSearchMocks = vi.hoisted(() => ({
  detectPatternCorrelation: vi.fn(async () => null),
  getLogAggregation: vi.fn(async () => ({})),
  getLogTrends: vi.fn(async () => ({})),
  resolveSingleOrgId: vi.fn(() => 'org-1'),
  searchFleetLogs: vi.fn(async () => ({ total: 0, logs: [] })),
}));
vi.mock('./logSearch', () => logSearchMocks);
vi.mock('./commandQueue', () => ({
  executeCommand: vi.fn(),
  queueCommandForExecution: vi.fn(),
  CommandTypes: {
    MSSQL_BACKUP: 'mssql_backup', MSSQL_RESTORE: 'mssql_restore', MSSQL_VERIFY: 'mssql_verify',
    HYPERV_VM_STATE: 'a', HYPERV_BACKUP: 'b', HYPERV_RESTORE: 'c', HYPERV_CHECKPOINT: 'd',
  },
}));
vi.mock('./aiDispatch', () => ({
  aiExecuteCommand: vi.fn(),
  aiQueueCommandForExecution: vi.fn(async () => ({ command: { id: 'c1', status: 'sent' } })),
}));
vi.mock('./remoteSessionCreate', () => ({
  createRemoteSession: vi.fn(),
  RemoteSessionDeniedError: class extends Error {},
}));
vi.mock('./logRedaction', () => ({ redactAgentLogRow: (r: any) => ({ message: r.message, fields: r.fields }) }));
vi.mock('./featureConfigResolver', () => ({
  resolveBackupConfigForDevice: vi.fn(async () => ({ configId: 'cfg', featureLinkId: 'fl' })),
}));

import { db } from '../db';
import { inArray } from 'drizzle-orm';
import {
  agentLogs, backupChains, backupSlaEvents, deviceChangeLog, hypervVms, remoteSessions, sqlInstances,
} from '../db/schema';
import type { PgColumn } from 'drizzle-orm/pg-core';
import { registerAuditTools } from './aiToolsAudit';
import { registerEventLogTools } from './aiToolsEventLogs';
import { registerRemoteTools } from './aiToolsRemote';
import { registerAgentLogTools } from './aiToolsAgentLogs';
import { registerSLABackupTools } from './aiToolsSLABackup';
import { registerMssqlTools } from './aiToolsMssql';
import { registerHypervTools } from './aiToolsHyperv';
import { SITE_SCOPE_EMPTY_NOTE } from './aiToolsSiteScope';
import type { AuthContext } from '../middleware/auth';
import type { AiTool } from './aiTools';

const mockDb = db as unknown as { select: ReturnType<typeof vi.fn> };
const inArraySpy = vi.mocked(inArray);

/** The id list (if any) that a narrowing `inArray` applied to `column`. */
function narrowedIds(column: PgColumn): unknown[] | undefined {
  const call = inArraySpy.mock.calls.find(([col]) => col === column);
  return call?.[1] as unknown[] | undefined;
}

function handlerFor(
  register: (m: Map<string, AiTool>) => void,
  name: string,
): AiTool['handler'] {
  const reg = new Map<string, AiTool>();
  register(reg);
  return reg.get(name)!.handler;
}

/**
 * The device-LESS analysis run: a frozen device allowlist and NO site axis.
 * `canAccessSite` is absent exactly as `agentAuthContext` leaves it for this shape.
 */
function deviceLessAuth(allowedDeviceIds: string[] = ['d-1']): AuthContext {
  return {
    principal: { kind: 'user_session' },
    user: { id: 'u1', email: 'a@b.c', name: 'A', isPlatformAdmin: false },
    token: {} as any, partnerId: null, orgId: 'org-1', scope: 'organization',
    accessibleOrgIds: ['org-1'], orgCondition: () => undefined, canAccessOrg: () => true,
    allowedSiteIds: undefined, allowedDeviceIds,
    aiOrigin: { kind: 'ai_assistant', sessionId: 'test-session' },
  } as unknown as AuthContext;
}

function isDeviceResolverSelect(cols: unknown): boolean {
  return (
    !!cols && typeof cols === 'object' &&
    'id' in (cols as object) && 'siteId' in (cols as object) &&
    Object.keys(cols as object).length === 2
  );
}

/** Generic chainable query mock that resolves to `result`. */
function chain(result: unknown): any {
  const p: any = Promise.resolve(result);
  for (const m of ['from', 'innerJoin', 'leftJoin', 'where', 'orderBy', 'limit', 'groupBy', 'offset']) {
    p[m] = () => p;
  }
  return p;
}

/** Org has the run's device plus a sibling the run must never reach. */
const ORG_DEVICES = [
  { id: 'd-1', siteId: 'site-A' },
  { id: 'd-2', siteId: 'site-A' },
];

beforeEach(() => vi.clearAllMocks());

describe('query_audit_log — device axis (device-less run)', () => {
  it('resolves the device partition and narrows for a run with no site axis', async () => {
    let resolverRan = false;
    let scanWhere: unknown;
    mockDb.select.mockImplementation((cols?: unknown) => {
      if (isDeviceResolverSelect(cols)) {
        resolverRan = true;
        return { from: () => ({ where: () => Promise.resolve(ORG_DEVICES) }) };
      }
      const p: any = Promise.resolve([]);
      for (const m of ['from', 'innerJoin', 'leftJoin', 'orderBy', 'limit', 'groupBy', 'offset']) p[m] = () => p;
      p.where = (w: unknown) => { scanWhere = w; return p; };
      return p;
    });

    const r = await handlerFor(registerAuditTools, 'query_audit_log')({}, deviceLessAuth());
    expect(JSON.parse(r).error).toBeUndefined();
    expect(resolverRan, 'device-less run must still resolve its device partition').toBe(true);
    expect(scanWhere).toBeDefined();
  });

  it('denies an explicit audit lookup of a sibling device id', async () => {
    let scanRan = false;
    mockDb.select.mockImplementation((cols?: unknown) => {
      if (isDeviceResolverSelect(cols)) {
        return { from: () => ({ where: () => Promise.resolve(ORG_DEVICES) }) };
      }
      scanRan = true;
      return chain([{ id: 'a1', timestamp: null, actorType: 'user', actorEmail: 'x', action: 'a', resourceType: 'device', resourceName: 'sibling-leak', result: 'ok', details: null }]);
    });

    const r = await handlerFor(registerAuditTools, 'query_audit_log')(
      { resourceType: 'device', resourceId: 'd-2' },
      deviceLessAuth(),
    );
    const parsed = JSON.parse(r);
    expect(parsed.entries).toEqual([]);
    expect(parsed.scopeNote).toBe(SITE_SCOPE_EMPTY_NOTE);
    expect(scanRan).toBe(false);
    expect(r).not.toContain('sibling-leak');
  });
});

describe('query_change_log — device axis (device-less run, no deviceId arg)', () => {
  it('narrows deviceChangeLog.deviceId to the frozen device set', async () => {
    mockDb.select.mockImplementation((cols?: unknown) => {
      if (isDeviceResolverSelect(cols)) {
        return { from: () => ({ where: () => Promise.resolve(ORG_DEVICES) }) };
      }
      if (cols && typeof cols === 'object' && 'count' in (cols as object)) return chain([{ count: 0 }]);
      return chain([]);
    });

    const r = await handlerFor(registerAuditTools, 'query_change_log')({}, deviceLessAuth());
    expect(JSON.parse(r).error).toBeUndefined();
    expect(narrowedIds(deviceChangeLog.deviceId)).toEqual(['d-1']);
  });
});

describe('detect_log_correlations — device axis (device-less run)', () => {
  it('passes the frozen device set to the correlation scan', async () => {
    mockDb.select.mockImplementation(() => chain([]));
    await handlerFor(registerEventLogTools, 'detect_log_correlations')(
      { pattern: 'kernel panic' },
      deviceLessAuth(),
    );
    const call = (logSearchMocks.detectPatternCorrelation.mock.calls as unknown[][])[0]?.[0] as
      | { allowedDeviceIds?: string[] | null }
      | undefined;
    expect(call, 'correlation scan should have been invoked').toBeDefined();
    expect(call!.allowedDeviceIds).toEqual(['d-1']);
  });
});

describe('list_remote_sessions — device axis (device-less run)', () => {
  it('narrows remoteSessions.deviceId to the frozen device set', async () => {
    mockDb.select.mockImplementation((cols?: unknown) => {
      if (isDeviceResolverSelect(cols)) {
        return { from: () => ({ where: () => Promise.resolve(ORG_DEVICES) }) };
      }
      return { from: () => ({ innerJoin: () => ({ where: () => ({ orderBy: () => ({ limit: () => Promise.resolve([]) }) }) }) }) };
    });
    const r = await handlerFor(registerRemoteTools, 'list_remote_sessions')({}, deviceLessAuth());
    expect(JSON.parse(r).error).toBeUndefined();
    expect(narrowedIds(remoteSessions.deviceId)).toEqual(['d-1']);
  });
});

describe('search_agent_logs — device axis (device-less run)', () => {
  it('narrows agentLogs.deviceId to the frozen device set', async () => {
    mockDb.select.mockImplementation((cols?: unknown) => {
      if (isDeviceResolverSelect(cols)) {
        return { from: () => ({ where: () => Promise.resolve(ORG_DEVICES) }) };
      }
      return { from: () => ({ where: () => ({ orderBy: () => ({ limit: () => Promise.resolve([]) }) }) }) };
    });
    const r = await handlerFor(registerAgentLogTools, 'search_agent_logs')({}, deviceLessAuth());
    expect(JSON.parse(r).error).toBeUndefined();
    expect(narrowedIds(agentLogs.deviceId)).toEqual(['d-1']);
  });
});

describe('backup SLA tools — device axis (device-less run)', () => {
  it('get_sla_breaches narrows backupSlaEvents.deviceId to the frozen device set', async () => {
    mockDb.select.mockImplementation((cols?: unknown) => {
      if (isDeviceResolverSelect(cols)) {
        return { from: () => ({ where: () => Promise.resolve(ORG_DEVICES) }) };
      }
      return chain([]);
    });
    const r = await handlerFor(registerSLABackupTools, 'get_sla_breaches')({}, deviceLessAuth());
    expect(JSON.parse(r).error).toBeUndefined();
    expect(narrowedIds(backupSlaEvents.deviceId)).toEqual(['d-1']);
  });

  it('get_sla_compliance_report narrows backupSlaEvents.deviceId to the frozen device set', async () => {
    mockDb.select.mockImplementation((cols?: unknown) => {
      if (isDeviceResolverSelect(cols)) {
        return { from: () => ({ where: () => Promise.resolve(ORG_DEVICES) }) };
      }
      return chain([]);
    });
    const r = await handlerFor(registerSLABackupTools, 'get_sla_compliance_report')({}, deviceLessAuth());
    expect(JSON.parse(r).error).toBeUndefined();
    expect(narrowedIds(backupSlaEvents.deviceId)).toEqual(['d-1']);
  });

  it('query_backup_sla narrows breach counts to the frozen device set', async () => {
    mockDb.select.mockImplementation((cols?: unknown) => {
      if (isDeviceResolverSelect(cols)) {
        return { from: () => ({ where: () => Promise.resolve(ORG_DEVICES) }) };
      }
      return chain([{ id: 'c1', name: 'SLA', targetDevices: [], targetGroups: [] }]);
    });
    const r = await handlerFor(registerSLABackupTools, 'query_backup_sla')({}, deviceLessAuth());
    expect(JSON.parse(r).error).toBeUndefined();
    expect(narrowedIds(backupSlaEvents.deviceId)).toEqual(['d-1']);
  });
});

describe('mssql / hyperv list tools — device axis (device-less run)', () => {
  function listDbMock() {
    mockDb.select.mockImplementation((cols?: unknown) => {
      if (isDeviceResolverSelect(cols)) {
        return { from: () => ({ where: () => Promise.resolve(ORG_DEVICES) }) };
      }
      return chain([]);
    });
  }

  it('query_mssql_instances narrows sqlInstances.deviceId', async () => {
    listDbMock();
    const r = await handlerFor(registerMssqlTools, 'query_mssql_instances')({}, deviceLessAuth());
    expect(JSON.parse(r).error).toBeUndefined();
    expect(narrowedIds(sqlInstances.deviceId)).toEqual(['d-1']);
  });

  it('get_mssql_backup_status narrows backupChains.deviceId', async () => {
    listDbMock();
    const r = await handlerFor(registerMssqlTools, 'get_mssql_backup_status')({}, deviceLessAuth());
    expect(JSON.parse(r).error).toBeUndefined();
    expect(narrowedIds(backupChains.deviceId)).toEqual(['d-1']);
  });

  it('query_hyperv_vms narrows hypervVms.deviceId', async () => {
    listDbMock();
    const r = await handlerFor(registerHypervTools, 'query_hyperv_vms')({}, deviceLessAuth());
    expect(JSON.parse(r).error).toBeUndefined();
    expect(narrowedIds(hypervVms.deviceId)).toEqual(['d-1']);
  });

  it('a device-less run asking for a SIBLING device id gets nothing', async () => {
    // The data layer is wired to hand back the sibling's instance if asked — the
    // device axis must short-circuit before the scan so it never reaches the model.
    mockDb.select.mockImplementation((cols?: unknown) => {
      if (isDeviceResolverSelect(cols)) {
        return { from: () => ({ where: () => Promise.resolve(ORG_DEVICES) }) };
      }
      return chain([{ id: 'i1', deviceId: 'd-2', hostname: 'sibling-leak', databases: [] }]);
    });
    const r = await handlerFor(registerMssqlTools, 'query_mssql_instances')(
      { deviceId: 'd-2' },
      deviceLessAuth(),
    );
    const parsed = JSON.parse(r);
    expect(parsed.error).toBeUndefined();
    expect(parsed.instances).toEqual([]);
    expect(parsed.showing).toBe(0);
    expect(r).not.toContain('sibling-leak');
  });
});
