import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';
import { scriptRoutes } from './scripts';

// #8598 — POST /scripts/:id/execute with a device-group `target`. Mock setup
// mirrors scripts.test.ts; the resolver itself is covered by
// services/scriptRunTargets.test.ts.

// Valid UUID constants for tests
const SCRIPT_ID_1 = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const SCRIPT_ID_2 = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const ORG_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const ORG_ID_2 = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
const PARTNER_ID = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
const OTHER_PARTNER_ID = 'abababab-abab-4bab-8bab-abababababab';
const EXECUTION_ID = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';

// Mock all services
vi.mock('../services', () => ({}));

const { executeScriptOnDevicesMock, withAuthDbAccessContextMock } = vi.hoisted(() => ({
  executeScriptOnDevicesMock: vi.fn(),
  withAuthDbAccessContextMock: vi.fn((_auth: unknown, fn: () => Promise<unknown>) => fn()),
}));

const { applyAutomationActionTerminalMock } = vi.hoisted(() => ({
  applyAutomationActionTerminalMock: vi.fn().mockResolvedValue(true),
}));

vi.mock('../services/scriptExecution', () => ({
  executeScriptOnDevices: executeScriptOnDevicesMock,
}));

const { resolveScriptRunTargetsMock } = vi.hoisted(() => ({
  resolveScriptRunTargetsMock: vi.fn(),
}));

vi.mock('../services/scriptRunTargets', () => ({
  resolveScriptRunTargets: resolveScriptRunTargetsMock,
}));

vi.mock('../services/automationActionResults', () => ({
  applyAutomationActionTerminal: (...args: unknown[]) =>
    applyAutomationActionTerminalMock(...(args as [])),
}));

// #3525 W02b — the cancel route is a thin delegation to this service, so the
// route tests assert what it is HANDED and what is done with the outcome; the
// state machine itself is covered by scriptCancellation.request.test.ts.
const { cancelScriptExecutionMock, deliverCancelCommandMock } = vi.hoisted(() => ({
  cancelScriptExecutionMock: vi.fn(),
  deliverCancelCommandMock: vi.fn(),
}));

vi.mock('../services/scriptCancellation', async (importOriginal) => {
  // The clamp and the bound are pure and are the contract the OpenAPI body
  // schema is derived from — keep the real ones so a drift there is caught
  // here rather than only in the service's own suite.
  const actual = await importOriginal<typeof import('../services/scriptCancellation')>();
  return {
    MAX_GRACE_SECONDS: actual.MAX_GRACE_SECONDS,
    clampGraceSeconds: actual.clampGraceSeconds,
    cancelScriptExecution: (...args: unknown[]) => cancelScriptExecutionMock(...(args as [])),
    deliverCancelCommand: (...args: unknown[]) => deliverCancelCommandMock(...(args as [])),
  };
});

// services/scriptVersions.ts is the sole writer of script_versions; the routes
// only have to hand it the right scriptId and provenance, which is what these
// recorded calls assert. The helper's own behaviour (FOR UPDATE, digest,
// version arithmetic) is covered by services/scriptVersions.test.ts.
const scriptVersionsH = vi.hoisted(() => ({
  cuts: [] as Array<{ scriptId: string; provenance: Record<string, unknown> }>,
  nextVersion: 2,
}));

vi.mock('../services/scriptVersions', () => ({
  cutScriptVersion: vi.fn((_tx: unknown, args: { scriptId: string; provenance: Record<string, unknown> }) => {
    scriptVersionsH.cuts.push(args);
    return Promise.resolve({ id: 'version-row', scriptId: args.scriptId, version: scriptVersionsH.nextVersion });
  }),
}));

vi.mock('../services/auditEvents', () => ({
  requestLikeFromSnapshot: vi.fn(() => ({ req: { header: () => undefined } })),
  writeRouteAudit: vi.fn()
}));

vi.mock('../db', () => {
  const db: any = {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => ({
          limit: vi.fn(() => Promise.resolve([]))
        }))
      }))
    })),
    insert: vi.fn(() => ({
      values: vi.fn(() => ({
        returning: vi.fn(() => Promise.resolve([]))
      }))
    })),
    update: vi.fn(() => ({
      set: vi.fn(() => ({
        where: vi.fn(() => ({
          returning: vi.fn(() => Promise.resolve([]))
        }))
      }))
    })),
    delete: vi.fn(() => ({
      where: vi.fn(() => Promise.resolve())
    })),
    // POST /scripts/:id/clone (#4887) runs its insert + tag copy inside
    // db.transaction — the mock `tx` handed to the callback is just `db`
    // itself, so every existing db.select/db.insert mockReturnValueOnce
    // queue works unchanged whether a given call goes through `db` or `tx`.
    transaction: vi.fn((fn: (tx: any) => unknown) => fn(db))
  };
  return {
    db,
    runOutsideDbContext: vi.fn((fn: () => any) => fn()),
    withSystemDbAccessContext: vi.fn(async (fn: () => any) => fn())
  };
});

vi.mock('../db/schema', () => ({
  scripts: { id: 'scripts.id', updatedAt: 'scripts.updatedAt', orgId: 'scripts.orgId', partnerId: 'scripts.partnerId', name: 'scripts.name', deletedAt: 'scripts.deletedAt' },
  // POST /scripts/:id/clone (#4887) reads/writes tags via scriptBundle's
  // ensureTagIds/linkTags helpers, which key off these two column refs.
  scriptTags: { id: 'stg.id', name: 'stg.name', orgId: 'stg.orgId', partnerId: 'stg.partnerId' },
  scriptToTags: { scriptId: 'stt.scriptId', tagId: 'stt.tagId' },
  // Column sentinels the #5040 projection assertions key off; the rest of this
  // file only needs the object to exist.
  scriptExecutions: { cancelState: 'se.cancelState' },
  scriptExecutionBatches: {},
  devices: {},
  deviceCommands: {},
  organizations: { id: 'o.id', partnerId: 'o.partnerId' },
  patchPolicies: {},
  configPolicyComplianceRules: {},
  configPolicyFeatureLinks: {},
  configurationPolicies: {},
  alertRules: {},
  backupConfigs: {},
  securityPolicies: {},
  automationPolicies: {},
  maintenanceWindows: {},
  softwarePolicies: {},
  sensitiveDataPolicies: {},
  peripheralPolicies: {},
  // tenantVariableResolution.ts's scope query (#3409 PR2, via
  // findSecretVariableReferences) joins these two.
  tenantVariables: {
    id: 'tv.id',
    key: 'tv.key',
    value: 'tv.value',
    isSecret: 'tv.isSecret',
    version: 'tv.version',
    orgId: 'tv.orgId',
    partnerId: 'tv.partnerId'
  },
  discoveredAssetTypeEnum: { enumValues: ['workstation', 'server', 'printer', 'unknown'] }
}));

// Spy on `desc` while keeping the real implementation, so the pagination
// tiebreaker test can assert exactly which columns were passed to it without
// changing behavior for the rest of the file's tests.
vi.mock('drizzle-orm', async (importOriginal) => {
  const actual = await importOriginal<typeof import('drizzle-orm')>();
  return { ...actual, desc: vi.fn(actual.desc) };
});

vi.mock('../middleware/auth', () => ({
  authMiddleware: vi.fn((c: any, next: any) => {
    c.set('auth', {
      user: { id: 'user-123', email: 'test@example.com', name: 'Test User' },
      scope: 'organization',
      partnerId: null,
      orgId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
      token: {
        sub: 'user-123',
        email: 'test@example.com',
        roleId: 'role-123',
        orgId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
        partnerId: null,
        scope: 'organization',
        type: 'access',
        mfa: true,
      },
      accessibleOrgIds: ['cccccccc-cccc-4ccc-8ccc-cccccccccccc'],
      canAccessOrg: (orgId: string) => orgId === 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
    });
    return next();
  }),
  requireScope: vi.fn(() => async (_c: any, next: any) => next()),
  requirePermission: vi.fn((resource: string, action: string) => async (c: any, next: any) => {
    if (c.req.header('x-site-restricted') === 'true') {
      c.set('permissions', {
        permissions: [{ resource, action }],
        partnerId: null,
        orgId: ORG_ID,
        roleId: 'role-123',
        scope: 'organization',
        allowedSiteIds: ['site-allowed']
      });
    }
    return next();
  }),
  requireMfa: vi.fn(() => async (_c: any, next: any) => next()),
  withAuthDbAccessContext: withAuthDbAccessContextMock,
}));

import { writeRouteAudit } from '../services/auditEvents';

const G1 = '99999999-9999-4999-8999-999999999991';
const G2 = '99999999-9999-4999-8999-999999999992';
const D1 = '11111111-1111-4111-8111-111111111111';
const D2 = '22222222-2222-4222-8222-222222222222';
const REQUEST_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

const post = (body: unknown, headers: Record<string, string> = {}) => ({
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Authorization: 'Bearer valid-token', ...headers },
  body: JSON.stringify(body),
});

const admitted = (deviceIds: string[]) => ({
  ok: true,
  admission: {
    requestId: REQUEST_ID,
    status: 'accepted',
    targets: deviceIds.map((id) => ({ requestedDeviceId: id, admission: 'admitted', executionId: `exec-${id}`, batchId: 'batch-1' })),
  },
  script: { id: SCRIPT_ID_1, name: 'Script One' },
  triggerType: 'manual',
  runAs: 'system',
  ignoredParameters: [],
  auditOrgId: ORG_ID,
});

const resolvedOk = (deviceIds: string[], warnings: string[] = []) => ({
  ok: true,
  deviceIds,
  warnings,
  resolvedGroups: [{ id: G1, orgId: ORG_ID, memberCount: deviceIds.length, refused: false }],
});

const auditCalls = (action: string) => vi.mocked(writeRouteAudit).mock.calls
  .map(([, event]) => event)
  .filter((event) => event.action === action);

describe('POST /scripts/:id/execute — group target (#8598)', () => {
  let app: Hono;

  beforeEach(() => {
    vi.clearAllMocks();
    app = new Hono();
    app.route('/scripts', scriptRoutes);
  });

  it('dispatches exactly the resolved ids and audits target + resolvedGroups', async () => {
    resolveScriptRunTargetsMock.mockResolvedValueOnce(resolvedOk([D1, D2]));
    executeScriptOnDevicesMock.mockResolvedValueOnce(admitted([D1, D2]));

    const res = await app.request(`/scripts/${SCRIPT_ID_1}/execute`, post({ target: { type: 'groups', groupIds: [G1] } }));

    expect(res.status).toBe(201);
    expect(executeScriptOnDevicesMock).toHaveBeenCalledWith(expect.objectContaining({ deviceIds: [D1, D2] }));
    const [execute] = auditCalls('script.execute');
    expect(execute?.details).toMatchObject({
      target: { type: 'groups', groupIds: [G1] },
      resolvedGroups: [{ id: G1, orgId: ORG_ID, memberCount: 2, refused: false }],
    });
    const [groupTarget] = auditCalls('script.execute_group_target');
    expect(groupTarget).toMatchObject({
      resourceType: 'script',
      resourceId: SCRIPT_ID_1,
      details: expect.objectContaining({
        target: { type: 'groups', groupIds: [G1] },
        count: 2,
        outcome: 'admitted',
      }),
    });
  });

  it("resolves inside the caller's own short DB context, before dispatch", async () => {
    const order: string[] = [];
    withAuthDbAccessContextMock.mockImplementationOnce(async (_auth: unknown, fn: () => Promise<unknown>) => {
      order.push('context-open');
      const out = await fn();
      order.push('context-closed');
      return out;
    });
    resolveScriptRunTargetsMock.mockImplementationOnce(async () => {
      order.push('resolve');
      return resolvedOk([D1]);
    });
    executeScriptOnDevicesMock.mockImplementationOnce(async () => {
      order.push('execute');
      return admitted([D1]);
    });

    await app.request(`/scripts/${SCRIPT_ID_1}/execute`, post({ target: { type: 'groups', groupIds: [G1] } }));

    expect(order).toEqual(['context-open', 'resolve', 'context-closed', 'execute']);
    expect(resolveScriptRunTargetsMock).toHaveBeenCalledWith(expect.objectContaining({
      target: { type: 'groups', groupIds: [G1] },
      auth: expect.objectContaining({ orgId: ORG_ID }),
    }));
  });

  it('still writes script.execute_group_target when no device is admitted', async () => {
    resolveScriptRunTargetsMock.mockResolvedValueOnce(resolvedOk([D1]));
    executeScriptOnDevicesMock.mockResolvedValueOnce({
      ...admitted([]),
      admission: {
        requestId: REQUEST_ID,
        status: 'rejected',
        targets: [{ requestedDeviceId: D1, admission: 'excluded', reasonCode: 'os_mismatch' }],
      },
    });

    const res = await app.request(`/scripts/${SCRIPT_ID_1}/execute`, post({ target: { type: 'groups', groupIds: [G1] } }));

    expect(res.status).toBe(201);
    expect(auditCalls('script.execute')).toHaveLength(0);
    expect(auditCalls('script.execute_group_target')).toEqual([
      expect.objectContaining({ details: expect.objectContaining({ outcome: 'none_admitted', count: 1 }) }),
    ]);
  });

  it('audits a script-not-found 404 on a group target as rejected', async () => {
    resolveScriptRunTargetsMock.mockResolvedValueOnce(resolvedOk([D1]));
    executeScriptOnDevicesMock.mockResolvedValueOnce({ ok: false, status: 404, error: 'Script not found' });

    const res = await app.request(`/scripts/${SCRIPT_ID_1}/execute`, post({ target: { type: 'groups', groupIds: [G1] } }));

    expect(res.status).toBe(404);
    expect(auditCalls('script.execute_group_target')).toEqual([
      expect.objectContaining({
        result: 'failure',
        details: expect.objectContaining({ outcome: 'rejected', code: 'SCRIPT_NOT_FOUND' }),
      }),
    ]);
  });

  it('returns 400 with the count and per-group counts, never dispatching, when over the cap', async () => {
    resolveScriptRunTargetsMock.mockResolvedValueOnce({
      ok: false,
      status: 400,
      code: 'TOO_MANY_TARGETS',
      error: 'The selected device group(s) resolve to 501 devices',
      count: 501,
      perGroupCounts: [{ id: G1, memberCount: 501 }],
    });

    const res = await app.request(`/scripts/${SCRIPT_ID_1}/execute`, post({ target: { type: 'groups', groupIds: [G1] } }));

    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({
      code: 'TOO_MANY_TARGETS',
      count: 501,
      perGroupCounts: [{ id: G1, memberCount: 501 }],
    });
    expect(executeScriptOnDevicesMock).not.toHaveBeenCalled();
    expect(auditCalls('script.execute_group_target')).toEqual([
      expect.objectContaining({
        result: 'failure',
        details: expect.objectContaining({ outcome: 'rejected', code: 'TOO_MANY_TARGETS', count: 501 }),
      }),
    ]);
  });

  it('returns 404 naming the unusable group ids', async () => {
    resolveScriptRunTargetsMock.mockResolvedValueOnce({
      ok: false,
      status: 404,
      code: 'GROUP_NOT_FOUND',
      error: 'Device group(s) not found or not accessible',
      groupIds: [G2],
    });

    const res = await app.request(`/scripts/${SCRIPT_ID_1}/execute`, post({ target: { type: 'groups', groupIds: [G1, G2] } }));

    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ code: 'GROUP_NOT_FOUND', groupIds: [G2] });
    expect(executeScriptOnDevicesMock).not.toHaveBeenCalled();
    expect(auditCalls('script.execute_group_target')).toEqual([
      expect.objectContaining({ details: expect.objectContaining({ outcome: 'rejected', code: 'GROUP_NOT_FOUND' }) }),
    ]);
  });

  it('returns 400 NO_TARGETS with its warnings', async () => {
    resolveScriptRunTargetsMock.mockResolvedValueOnce({
      ok: false,
      status: 400,
      code: 'NO_TARGETS',
      error: 'Every requested device group was refused',
      count: 0,
      warnings: ['refused G1'],
    });

    const res = await app.request(`/scripts/${SCRIPT_ID_1}/execute`, post({ target: { type: 'groups', groupIds: [G1] } }));

    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ code: 'NO_TARGETS', count: 0, warnings: ['refused G1'] });
    expect(executeScriptOnDevicesMock).not.toHaveBeenCalled();
  });

  it('carries refusal warnings in the 201 body', async () => {
    resolveScriptRunTargetsMock.mockResolvedValueOnce(resolvedOk([D1], ['Device group G2 was excluded']));
    executeScriptOnDevicesMock.mockResolvedValueOnce(admitted([D1]));

    const res = await app.request(`/scripts/${SCRIPT_ID_1}/execute`, post({ target: { type: 'groups', groupIds: [G1, G2] } }));

    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.warnings).toEqual(['Device group G2 was excluded']);
    expect(body.requestId).toBe(REQUEST_ID);
  });

  it("passes the site-restricted caller's permissions to the resolver", async () => {
    resolveScriptRunTargetsMock.mockResolvedValueOnce(resolvedOk([D1]));
    executeScriptOnDevicesMock.mockResolvedValueOnce(admitted([D1]));

    await app.request(
      `/scripts/${SCRIPT_ID_1}/execute`,
      post({ target: { type: 'groups', groupIds: [G1] } }, { 'x-site-restricted': 'true' }),
    );

    expect(resolveScriptRunTargetsMock).toHaveBeenCalledWith(expect.objectContaining({
      permissions: expect.objectContaining({ allowedSiteIds: ['site-allowed'] }),
    }));
  });

  it('audits the set actually resolved for this run, not a later membership', async () => {
    // A membership change after resolution must not leak into this run's
    // record: the dispatched and audited set is the one resolved here, once.
    resolveScriptRunTargetsMock
      .mockResolvedValueOnce(resolvedOk([D1]))
      .mockResolvedValueOnce(resolvedOk([D1, D2]));
    executeScriptOnDevicesMock.mockResolvedValueOnce(admitted([D1]));

    await app.request(`/scripts/${SCRIPT_ID_1}/execute`, post({ target: { type: 'groups', groupIds: [G1] } }));

    expect(resolveScriptRunTargetsMock).toHaveBeenCalledTimes(1);
    expect(executeScriptOnDevicesMock).toHaveBeenCalledWith(expect.objectContaining({ deviceIds: [D1] }));
    expect(auditCalls('script.execute')[0]?.details).toMatchObject({
      targets: [expect.objectContaining({ requestedDeviceId: D1 })],
    });
    expect(auditCalls('script.execute_group_target')[0]?.details).toMatchObject({ deviceIds: [D1] });
  });

  it('leaves a deviceIds request unchanged (no resolver, no warnings, no group fields)', async () => {
    executeScriptOnDevicesMock.mockResolvedValueOnce(admitted([D1]));

    const res = await app.request(`/scripts/${SCRIPT_ID_1}/execute`, post({ deviceIds: [D1] }));

    expect(res.status).toBe(201);
    expect(resolveScriptRunTargetsMock).not.toHaveBeenCalled();
    expect(executeScriptOnDevicesMock).toHaveBeenCalledWith(expect.objectContaining({ deviceIds: [D1] }));
    const body = await res.json();
    expect(body).toEqual(admitted([D1]).admission);
    const [execute] = auditCalls('script.execute');
    expect(execute?.details).not.toHaveProperty('target');
    expect(execute?.details).not.toHaveProperty('resolvedGroups');
    expect(auditCalls('script.execute_group_target')).toHaveLength(0);
  });

  it('rejects a group target with targetSessionId before resolving anything', async () => {
    const res = await app.request(
      `/scripts/${SCRIPT_ID_1}/execute`,
      post({ target: { type: 'groups', groupIds: [G1] }, runAs: 'user', targetSessionId: 2 }),
    );

    expect(res.status).toBe(400);
    expect(resolveScriptRunTargetsMock).not.toHaveBeenCalled();
    expect(executeScriptOnDevicesMock).not.toHaveBeenCalled();
  });
});
