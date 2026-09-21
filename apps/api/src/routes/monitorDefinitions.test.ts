import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { MONITOR_KINDS } from '@breeze/shared';

/**
 * Route tests for /monitor-definitions (#5287 W02).
 *
 * Style follows apps/api/src/routes/aiAgents.test.ts: middleware
 * (requireScope/requirePermission/requireMfa) is replaced with cheap gates
 * controlled by hoisted mocks, and the monitor service layer is mocked
 * entirely — its own correctness (ownership axis, validation, ecompilation)
 * is covered by monitorService.test.ts. These tests exercise only routing,
 * status codes, and error-shape mapping.
 */

const {
  hasPermMock,
  mfaOkMock,
  listMonitorDefinitionsMock,
  getMonitorDefinitionMock,
  createMonitorDefinitionMock,
  updateMonitorDefinitionMock,
  deleteMonitorDefinitionMock,
  writeRouteAuditMock,
  selectMock,
  isMonitorAttachableToPolicyMock,
} = vi.hoisted(() => ({
  hasPermMock: vi.fn<(resource: string, action: string) => boolean>(() => true),
  mfaOkMock: vi.fn(() => true),
  listMonitorDefinitionsMock: vi.fn(),
  getMonitorDefinitionMock: vi.fn(),
  createMonitorDefinitionMock: vi.fn(),
  updateMonitorDefinitionMock: vi.fn(),
  deleteMonitorDefinitionMock: vi.fn(),
  writeRouteAuditMock: vi.fn(),
  selectMock: vi.fn(),
  // Defaults to attachable — tests that need the pre-check to refuse override
  // it with mockResolvedValueOnce(false). Its own ownership-axis correctness
  // is covered by monitorAttachability.test.ts; these route tests only check
  // that the route respects the pre-check's answer.
  isMonitorAttachableToPolicyMock: vi.fn(async () => true),
}));

vi.mock('../middleware/auth', () => ({
  authMiddleware: async (_c: unknown, next: () => Promise<void>) => next(),
  requireScope: () => async (_c: unknown, next: () => Promise<void>) => next(),
  requireMfa: () => async (c: { json: (body: unknown, status: number) => Response }, next: () => Promise<void>) => (
    mfaOkMock() ? next() : c.json({ error: 'MFA required', code: 'MFA_REQUIRED' }, 403)
  ),
  requirePermission: (resource: string, action: string) => async (
    c: { json: (body: unknown, status: number) => Response },
    next: () => Promise<void>,
  ) => (hasPermMock(resource, action) ? next() : c.json({ error: 'Permission denied' }, 403)),
}));

// Real error classes (not vi.fn stand-ins): the route's `errorResponse()` does
// `instanceof` checks against these exact exports, so the mock must supply
// classes rather than functions for the instanceof branch to fire correctly.
const { MonitorNotFoundError, MonitorOwnershipError, MonitorValidationError, MonitorHasDependentsError } = vi.hoisted(() => ({
  MonitorNotFoundError: class MonitorNotFoundError extends Error {
    constructor(id: string) {
      super(`Monitor definition ${id} not found`);
      this.name = 'MonitorNotFoundError';
    }
  },
  MonitorOwnershipError: class MonitorOwnershipError extends Error {
    constructor(message: string) {
      super(message);
      this.name = 'MonitorOwnershipError';
    }
  },
  MonitorValidationError: class MonitorValidationError extends Error {
    constructor(message: string) {
      super(message);
      this.name = 'MonitorValidationError';
    }
  },
  MonitorHasDependentsError: class MonitorHasDependentsError extends Error {
    constructor(id: string) {
      super(`Monitor definition ${id} still has rows referencing it that cannot be cascaded`);
      this.name = 'MonitorHasDependentsError';
    }
  },
}));

vi.mock('../services/monitors/monitorService', () => ({
  MonitorNotFoundError,
  MonitorOwnershipError,
  MonitorValidationError,
  MonitorHasDependentsError,
  listMonitorDefinitions: listMonitorDefinitionsMock,
  getMonitorDefinition: getMonitorDefinitionMock,
  createMonitorDefinition: createMonitorDefinitionMock,
  updateMonitorDefinition: updateMonitorDefinitionMock,
  deleteMonitorDefinition: deleteMonitorDefinitionMock,
}));

// Not exercised by any of the covered routes below (POST /:id/test only) but
// imported at module load time — a bare stub keeps the route module
// importable without pulling in the real condition-evaluation machinery.
vi.mock('../services/monitors/monitorCompiler', () => ({
  buildCompiledCondition: vi.fn(),
}));

vi.mock('../services/monitors/monitorResolver', () => ({
  resolveMonitorsForDevice: vi.fn(),
}));

vi.mock('../services/monitors/ruleConversionService', () => ({
  convertRuleToMonitor: vi.fn(),
}));

vi.mock('../services/alertConditions', () => ({
  evaluateConditions: vi.fn(),
}));

vi.mock('../services/configurationPolicy', () => ({
  addFeatureLink: vi.fn(),
  assignPolicy: vi.fn(),
  createConfigPolicy: vi.fn(),
  getConfigPolicy: vi.fn(),
  removeFeatureLink: vi.fn(),
  updateFeatureLink: vi.fn(),
  validateAssignmentTarget: vi.fn(async () => ({ valid: true })),
  authorizeAssignmentTarget: vi.fn(async () => ({ valid: true })),
}));

// Real pre-check function replaced with a controllable mock — see
// isMonitorAttachableToPolicyMock above. Its own ownership-axis logic is unit
// tested directly in monitorAttachability.test.ts.
vi.mock('../services/monitors/monitorAttachability', () => ({
  isMonitorAttachableToPolicy: isMonitorAttachableToPolicyMock,
}));

vi.mock('../services/auditEvents', () => ({
  writeRouteAudit: writeRouteAuditMock,
}));

/**
 * Minimal chainable stand-in for `db.select(...)` (pattern lifted from
 * aiAgents.test.ts's `selectChain`) — every chain method returns the same
 * object; `then` resolves it to `rows`. Only the GET / attachment-count
 * query (`.from().where().groupBy()`) is exercised by the covered routes.
 */
function selectChain<T>(rows: T) {
  const chain = {
    from: () => chain,
    innerJoin: () => chain,
    leftJoin: () => chain,
    where: () => chain,
    groupBy: () => chain,
    orderBy: () => chain,
    limit: () => chain,
    offset: () => chain,
    then: (resolve: (v: T) => unknown, reject?: (e: unknown) => unknown) =>
      Promise.resolve(rows).then(resolve, reject),
  };
  return chain;
}

vi.mock('../db', () => ({
  db: { select: selectMock },
}));

import { monitorDefinitionRoutes } from './monitorDefinitions';
import {
  addFeatureLink as addFeatureLinkMock,
  assignPolicy as assignPolicyMock,
  createConfigPolicy as createConfigPolicyMock,
  getConfigPolicy as getConfigPolicyMock,
  removeFeatureLink as removeFeatureLinkMock,
  updateFeatureLink as updateFeatureLinkMock,
} from '../services/configurationPolicy';
import { PARTNER_WIDE_WRITE_DENIED_MESSAGE } from '../services/partnerWideAccess';
import { resolveMonitorsForDevice as resolveMonitorsForDeviceMock } from '../services/monitors/monitorResolver';
import { evaluateConditions as evaluateConditionsMock } from '../services/alertConditions';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';

const ORG_ID = '33333333-3333-4333-8333-333333333333';
const USER_ID = '77777777-7777-4777-8777-777777777777';
const MONITOR_ID = '11111111-1111-4111-8111-111111111111';
const POLICY_ID = '22222222-2222-4222-8222-222222222222';
const PARTNER_ID = '44444444-4444-4444-8444-444444444444';
const OTHER_ORG_ID = '55555555-5555-4555-8555-555555555555';

function monitorRow(overrides: Record<string, unknown> = {}) {
  return {
    id: MONITOR_ID,
    orgId: ORG_ID,
    partnerId: null,
    name: 'High CPU',
    description: null,
    kind: 'cpu',
    enabled: true,
    condition: { operator: 'gt', value: 90 },
    severity: 'high',
    cooldownMinutes: 5,
    autoResolve: false,
    autoResolveConditions: null,
    responses: [],
    deliveryMode: 'inherit',
    deliveryChannelIds: [],
    escalationPolicyId: null,
    recurrenceThreshold: null,
    recurrenceWindowHours: null,
    recurrenceActions: [],
    pauseResponsesOnEscalation: true,
    aiAgentId: null,
    createdBy: USER_ID,
    compiledAlertTemplateId: 'tmpl-1',
    compiledAlertRuleId: 'rule-1',
    compiledAutomationId: 'auto-1',
    ...overrides,
  };
}

function validCreateBody(overrides: Record<string, unknown> = {}) {
  return {
    name: 'High CPU',
    kind: 'cpu',
    condition: { operator: 'gt', value: 90 },
    severity: 'high',
    ...overrides,
  };
}

function buildApp(authOverrides: Record<string, unknown> = {}): Hono {
  const app = new Hono();
  app.use('*', async (c, next) => {
    c.set('auth', {
      scope: 'organization',
      orgId: ORG_ID,
      partnerId: null,
      user: { id: USER_ID, email: 'tech@example.com', name: 'Tech' },
      canAccessOrg: () => true,
      orgCondition: () => undefined,
      ...authOverrides,
    } as never);
    await next();
  });
  app.route('/monitor-definitions', monitorDefinitionRoutes);
  return app;
}

function jsonRequest(app: Hono, method: string, path: string, body?: unknown) {
  return app.request(`/monitor-definitions${path}`, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  hasPermMock.mockReturnValue(true);
  mfaOkMock.mockReturnValue(true);
  selectMock.mockReturnValue(selectChain([]));
});

describe('GET /monitor-definitions', () => {
  it('returns { data } with attachmentCount per row, defaulting to 0 when uncounted', async () => {
    listMonitorDefinitionsMock.mockResolvedValue([
      monitorRow({ id: MONITOR_ID, name: 'High CPU' }),
      monitorRow({ id: 'other-id', name: 'Low Disk' }),
    ]);
    selectMock.mockReturnValueOnce(selectChain([{ monitorId: MONITOR_ID, count: 3 }]));

    const res = await jsonRequest(buildApp(), 'GET', '');

    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: Array<Record<string, unknown>> };
    expect(body.data).toHaveLength(2);
    expect(body.data.find((r) => r.id === MONITOR_ID)).toMatchObject({ attachmentCount: 3 });
    expect(body.data.find((r) => r.id === 'other-id')).toMatchObject({ attachmentCount: 0 });
  });

  it('skips the count query and returns an empty list when there are no monitors', async () => {
    listMonitorDefinitionsMock.mockResolvedValue([]);

    const res = await jsonRequest(buildApp(), 'GET', '');

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: [] });
    expect(selectMock).not.toHaveBeenCalled();
  });
});

describe('GET /monitor-definitions/kinds', () => {
  it('returns one entry per monitor kind (19 after W05c1) with kind/overridableKeys/defaultSeverity/agentDelivered', async () => {
    const res = await jsonRequest(buildApp(), 'GET', '/kinds');

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: Array<{ kind: string; overridableKeys: string[]; defaultSeverity: string; agentDelivered: boolean }>;
    };
    expect(body.data).toHaveLength(19);
    expect(body.data).toHaveLength(MONITOR_KINDS.length);
    expect(new Set(body.data.map((d) => d.kind))).toEqual(new Set(MONITOR_KINDS));
    for (const entry of body.data) {
      expect(Array.isArray(entry.overridableKeys)).toBe(true);
      expect(typeof entry.defaultSeverity).toBe('string');
      expect(typeof entry.agentDelivered).toBe('boolean');
    }
  });
});

describe('POST /monitor-definitions', () => {
  it('creates and returns 201 { data }', async () => {
    const created = monitorRow();
    createMonitorDefinitionMock.mockResolvedValue(created);

    const res = await jsonRequest(buildApp(), 'POST', '', validCreateBody());

    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ data: created });
    expect(createMonitorDefinitionMock).toHaveBeenCalledTimes(1);
  });

  it('falls back to the ambient ?orgId= query when the body carries none (partner tokens have auth.orgId null, cf. #808)', async () => {
    const created = monitorRow();
    createMonitorDefinitionMock.mockResolvedValue(created);
    const orgId = '44444444-4444-4444-8444-444444444444';

    const res = await jsonRequest(buildApp(), 'POST', `?orgId=${orgId}`, validCreateBody());

    expect(res.status).toBe(201);
    expect(createMonitorDefinitionMock).toHaveBeenCalledWith(
      expect.objectContaining({ orgId }),
      expect.anything(),
    );
  });

  it('prefers an explicit body orgId over the ambient query', async () => {
    const created = monitorRow();
    createMonitorDefinitionMock.mockResolvedValue(created);
    const bodyOrg = '55555555-5555-4555-8555-555555555555';

    const res = await jsonRequest(buildApp(), 'POST', '?orgId=44444444-4444-4444-8444-444444444444', {
      ...validCreateBody(),
      orgId: bodyOrg,
    });

    expect(res.status).toBe(201);
    expect(createMonitorDefinitionMock).toHaveBeenCalledWith(
      expect.objectContaining({ orgId: bodyOrg }),
      expect.anything(),
    );
  });

  it('maps a MonitorOwnershipError to 403 with the error message', async () => {
    createMonitorDefinitionMock.mockRejectedValue(
      new MonitorOwnershipError('Partner-wide monitors require partner scope'),
    );

    const res = await jsonRequest(buildApp(), 'POST', '', validCreateBody());

    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'Partner-wide monitors require partner scope' });
  });

  it('maps a MonitorValidationError to 400 { error: INVALID_MONITOR, details }', async () => {
    createMonitorDefinitionMock.mockRejectedValue(
      new MonitorValidationError('condition does not match kind cpu'),
    );

    const res = await jsonRequest(buildApp(), 'POST', '', validCreateBody());

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: 'INVALID_MONITOR',
      details: 'condition does not match kind cpu',
    });
  });
});

describe('PATCH /monitor-definitions/:id', () => {
  it('maps a MonitorValidationError to 400 { error: INVALID_MONITOR, details }', async () => {
    updateMonitorDefinitionMock.mockRejectedValue(
      new MonitorValidationError('deliveryChannelIds required when deliveryMode is channels'),
    );

    const res = await jsonRequest(buildApp(), 'PATCH', `/${MONITOR_ID}`, { name: 'Renamed' });

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: 'INVALID_MONITOR',
      details: 'deliveryChannelIds required when deliveryMode is channels',
    });
  });
});

describe('GET /monitor-definitions/:id', () => {
  it('returns 404 { error: Monitor not found } when the service returns null', async () => {
    getMonitorDefinitionMock.mockResolvedValue(null);

    const res = await jsonRequest(buildApp(), 'GET', `/${MONITOR_ID}`);

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'Monitor not found' });
  });
});

describe('DELETE /monitor-definitions/:id', () => {
  it('deletes and returns 204 with an empty body', async () => {
    getMonitorDefinitionMock.mockResolvedValue(monitorRow());
    deleteMonitorDefinitionMock.mockResolvedValue(undefined);

    const res = await jsonRequest(buildApp(), 'DELETE', `/${MONITOR_ID}`);

    expect(res.status).toBe(204);
    expect(await res.text()).toBe('');
    expect(deleteMonitorDefinitionMock).toHaveBeenCalledWith(MONITOR_ID, expect.anything());
  });

  // Regression for #6509: a monitor that has ever produced an alert used to
  // 500 with the raw postgres FK constraint text. The service now maps that
  // to MonitorHasDependentsError; the route must turn it into a clean 409,
  // never leak the underlying error to the client.
  it('maps MonitorHasDependentsError to a clean 409 instead of a raw postgres error', async () => {
    getMonitorDefinitionMock.mockResolvedValue(monitorRow());
    deleteMonitorDefinitionMock.mockRejectedValue(new MonitorHasDependentsError(MONITOR_ID));

    const res = await jsonRequest(buildApp(), 'DELETE', `/${MONITOR_ID}`);

    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'MONITOR_HAS_DEPENDENTS' });
  });
});

describe('POST /monitor-definitions/:id/attachments', () => {
  it('returns 404 when the monitor is invisible to the caller', async () => {
    getMonitorDefinitionMock.mockResolvedValue(null);

    const res = await jsonRequest(buildApp(), 'POST', `/${MONITOR_ID}/attachments`, {
      configPolicyId: POLICY_ID,
    });

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'Monitor not found' });
  });

  it('refuses to attach to a PARTNER-WIDE policy when the caller cannot manage partner-wide policies (#5289 review fix)', async () => {
    getMonitorDefinitionMock.mockResolvedValue(monitorRow());
    vi.mocked(getConfigPolicyMock).mockResolvedValue({ id: POLICY_ID, orgId: null, partnerId: PARTNER_ID } as never);

    const res = await jsonRequest(
      buildApp({ scope: 'partner', orgId: null, partnerId: PARTNER_ID, partnerOrgAccess: 'none' }),
      'POST',
      `/${MONITOR_ID}/attachments`,
      { configPolicyId: POLICY_ID },
    );

    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: PARTNER_WIDE_WRITE_DENIED_MESSAGE });
    expect(addFeatureLinkMock).not.toHaveBeenCalled();
    expect(updateFeatureLinkMock).not.toHaveBeenCalled();
  });

  it('allows attaching to a PARTNER-WIDE policy when the caller CAN manage partner-wide policies (#5289 review fix)', async () => {
    getMonitorDefinitionMock.mockResolvedValue(monitorRow());
    vi.mocked(getConfigPolicyMock).mockResolvedValue({ id: POLICY_ID, orgId: null, partnerId: PARTNER_ID } as never);

    const res = await jsonRequest(
      buildApp({ scope: 'partner', orgId: null, partnerId: PARTNER_ID, partnerOrgAccess: 'all' }),
      'POST',
      `/${MONITOR_ID}/attachments`,
      { configPolicyId: POLICY_ID },
    );

    expect(res.status).toBe(201);
    expect(addFeatureLinkMock).toHaveBeenCalledTimes(1);
  });

  it('refuses createPolicyFor with a partner-owned monitor when the caller cannot manage partner-wide policies (#5289 review fix)', async () => {
    // Partner-owned monitor: orgId null, partnerId set. Default buildApp auth
    // is org-scoped, which can never manage partner-wide policies.
    getMonitorDefinitionMock.mockResolvedValue(monitorRow({ orgId: null, partnerId: PARTNER_ID }));

    const res = await jsonRequest(buildApp(), 'POST', `/${MONITOR_ID}/attachments`, {
      createPolicyFor: { level: 'organization', targetId: OTHER_ORG_ID },
    });

    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: PARTNER_WIDE_WRITE_DENIED_MESSAGE });
    expect(createConfigPolicyMock).not.toHaveBeenCalled();
    expect(assignPolicyMock).not.toHaveBeenCalled();
  });

  it('returns 400 MONITOR_NOT_ATTACHABLE when the pre-check refuses, and never writes the feature link (#5289 review fix)', async () => {
    getMonitorDefinitionMock.mockResolvedValue(monitorRow());
    vi.mocked(getConfigPolicyMock).mockResolvedValue({ id: POLICY_ID, orgId: ORG_ID, partnerId: null } as never);
    isMonitorAttachableToPolicyMock.mockResolvedValueOnce(false);

    const res = await jsonRequest(buildApp(), 'POST', `/${MONITOR_ID}/attachments`, {
      configPolicyId: POLICY_ID,
    });

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'MONITOR_NOT_ATTACHABLE' });
    expect(addFeatureLinkMock).not.toHaveBeenCalled();
    expect(updateFeatureLinkMock).not.toHaveBeenCalled();
  });
});

describe('DELETE /monitor-definitions/:id/attachments/:attachmentId', () => {
  const ATTACHMENT_ID = '66666666-6666-4666-8666-666666666666';

  function mockAttachmentRow(overrides: Record<string, unknown> = {}) {
    selectMock.mockReturnValueOnce(
      selectChain([{ id: ATTACHMENT_ID, featureLinkId: 'fl-1', configPolicyId: POLICY_ID, ...overrides }]),
    );
  }

  it('refuses to detach from a PARTNER-WIDE policy when the caller cannot manage partner-wide policies (#5289 review fix)', async () => {
    getMonitorDefinitionMock.mockResolvedValue(monitorRow());
    mockAttachmentRow();
    vi.mocked(getConfigPolicyMock).mockResolvedValue({ id: POLICY_ID, orgId: null, partnerId: PARTNER_ID } as never);

    const res = await jsonRequest(
      buildApp({ scope: 'partner', orgId: null, partnerId: PARTNER_ID, partnerOrgAccess: 'none' }),
      'DELETE',
      `/${MONITOR_ID}/attachments/${ATTACHMENT_ID}`,
    );

    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: PARTNER_WIDE_WRITE_DENIED_MESSAGE });
    expect(removeFeatureLinkMock).not.toHaveBeenCalled();
    expect(updateFeatureLinkMock).not.toHaveBeenCalled();
  });

  it('allows detaching from a PARTNER-WIDE policy when the caller CAN manage partner-wide policies (#5289 review fix)', async () => {
    getMonitorDefinitionMock.mockResolvedValue(monitorRow());
    mockAttachmentRow();
    vi.mocked(getConfigPolicyMock).mockResolvedValue({ id: POLICY_ID, orgId: null, partnerId: PARTNER_ID } as never);

    const res = await jsonRequest(
      buildApp({ scope: 'partner', orgId: null, partnerId: PARTNER_ID, partnerOrgAccess: 'all' }),
      'DELETE',
      `/${MONITOR_ID}/attachments/${ATTACHMENT_ID}`,
    );

    expect(res.status).toBe(204);
    expect(removeFeatureLinkMock).toHaveBeenCalledTimes(1);
  });
});

/**
 * Site-axis scoping (#5289 CI fix). Site is an app-layer concept only — RLS
 * does not defend it — so a site-restricted organization technician
 * (`auth.allowedSiteIds` set) must never see or probe a device outside their
 * sites through a monitor. `undefined` = unrestricted; `[]` = no site at all.
 */
describe('site scope on device-reading monitor routes', () => {
  const SITE_A = '88888888-8888-4888-8888-888888888888';
  const SITE_B = '99999999-9999-4999-8999-999999999999';
  const DEVICE_IN_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const DEVICE_IN_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  const dialect = new PgDialect();
  const resolvedMatch = {
    kind: 'resolved' as const,
    monitors: [
      { monitorId: MONITOR_ID, enabled: true, overrides: null, sourcePolicyId: POLICY_ID, sourceLevel: 'organization' },
    ],
  };

  /** selectChain that records every `.where()` argument it receives. */
  function recordingChain<T>(rows: T, sink: unknown[]) {
    const chain = selectChain(rows);
    chain.where = ((w: unknown) => {
      sink.push(w);
      return chain;
    }) as typeof chain.where;
    return chain;
  }

  /** Queue the three lookups that precede the device-candidate query. */
  function queueAttachmentLookups(assignment = { level: 'organization', targetId: ORG_ID }) {
    selectMock
      .mockReturnValueOnce(selectChain([{ configPolicyId: POLICY_ID }])) // attaching policies
      .mockReturnValueOnce(selectChain([])) // child policies
      .mockReturnValueOnce(selectChain([assignment])); // assignments
  }

  describe('GET /monitor-definitions/:id/devices', () => {
    it("narrows the candidate device query to the caller's allowed sites", async () => {
      getMonitorDefinitionMock.mockResolvedValue(monitorRow());
      queueAttachmentLookups();
      const wheres: unknown[] = [];
      selectMock.mockReturnValueOnce(recordingChain([{ id: DEVICE_IN_A, hostname: 'a', displayName: null }], wheres));
      vi.mocked(resolveMonitorsForDeviceMock).mockResolvedValue(resolvedMatch as never);

      const res = await jsonRequest(buildApp({ allowedSiteIds: [SITE_A] }), 'GET', `/${MONITOR_ID}/devices`);

      expect(res.status).toBe(200);
      expect(wheres).toHaveLength(1);
      const compiled = dialect.sqlToQuery(wheres[0] as SQL);
      expect(compiled.sql).toMatch(/"devices"\."site_id" in \(\$\d+\)/);
      expect(compiled.params).toContain(SITE_A);
      expect(compiled.params).not.toContain(SITE_B);
    });

    it('ANDs the site scope with the assignment targets, never ORs it (site-level assignment outside scope)', async () => {
      getMonitorDefinitionMock.mockResolvedValue(monitorRow());
      // The policy targets SITE_B; the caller may only see SITE_A. Both emit a
      // devices.site_id IN — only the nesting tells scope (AND) from target (OR).
      queueAttachmentLookups({ level: 'site', targetId: SITE_B });
      const wheres: unknown[] = [];
      selectMock.mockReturnValueOnce(recordingChain([], wheres));

      const res = await jsonRequest(buildApp({ allowedSiteIds: [SITE_A] }), 'GET', `/${MONITOR_ID}/devices`);

      expect(res.status).toBe(200);
      const compiled = dialect.sqlToQuery(wheres[0] as SQL);
      expect(compiled.params).toEqual([SITE_A, SITE_B]);
      expect(compiled.sql).toBe('("devices"."site_id" in ($1) and ("devices"."site_id" in ($2)))');
    });

    it('returns no devices and never queries devices for a caller restricted to zero sites', async () => {
      getMonitorDefinitionMock.mockResolvedValue(monitorRow());
      queueAttachmentLookups();

      const res = await jsonRequest(buildApp({ allowedSiteIds: [] }), 'GET', `/${MONITOR_ID}/devices`);

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ data: [] });
      expect(selectMock).toHaveBeenCalledTimes(3); // the device query is never issued
      expect(resolveMonitorsForDeviceMock).not.toHaveBeenCalled();
    });

    it('applies no site predicate for an unrestricted caller', async () => {
      getMonitorDefinitionMock.mockResolvedValue(monitorRow());
      queueAttachmentLookups();
      const wheres: unknown[] = [];
      selectMock.mockReturnValueOnce(
        recordingChain(
          [
            { id: DEVICE_IN_A, hostname: 'a', displayName: null },
            { id: DEVICE_IN_B, hostname: 'b', displayName: null },
          ],
          wheres,
        ),
      );
      vi.mocked(resolveMonitorsForDeviceMock).mockResolvedValue(resolvedMatch as never);

      const res = await jsonRequest(buildApp(), 'GET', `/${MONITOR_ID}/devices`);

      expect(res.status).toBe(200);
      const body = (await res.json()) as { data: Array<{ deviceId: string }> };
      expect(body.data.map((d) => d.deviceId)).toEqual([DEVICE_IN_A, DEVICE_IN_B]);
      expect(dialect.sqlToQuery(wheres[0] as SQL).sql).not.toMatch(/"site_id"/);
    });

    it('drops a device that raced a delete (resolver returns device_missing) from the listing, same as no match (#5677)', async () => {
      getMonitorDefinitionMock.mockResolvedValue(monitorRow());
      queueAttachmentLookups();
      selectMock.mockReturnValueOnce(
        selectChain([
          { id: DEVICE_IN_A, hostname: 'a', displayName: null },
          { id: DEVICE_IN_B, hostname: 'b', displayName: null },
        ]),
      );
      // DEVICE_IN_A raced a delete; DEVICE_IN_B still resolves normally.
      vi.mocked(resolveMonitorsForDeviceMock)
        .mockResolvedValueOnce({ kind: 'device_missing' } as never)
        .mockResolvedValueOnce(resolvedMatch as never);

      const res = await jsonRequest(buildApp(), 'GET', `/${MONITOR_ID}/devices`);

      expect(res.status).toBe(200);
      const body = (await res.json()) as { data: Array<{ deviceId: string }> };
      expect(body.data.map((d) => d.deviceId)).toEqual([DEVICE_IN_B]);
    });
  });

  describe('POST /monitor-definitions/:id/test', () => {
    it("404s without evaluating for a device outside the caller's allowed sites", async () => {
      getMonitorDefinitionMock.mockResolvedValue(monitorRow());
      selectMock.mockReturnValueOnce(selectChain([{ id: DEVICE_IN_B, siteId: SITE_B }]));

      const res = await jsonRequest(buildApp({ allowedSiteIds: [SITE_A] }), 'POST', `/${MONITOR_ID}/test`, {
        deviceId: DEVICE_IN_B,
      });

      expect(res.status).toBe(404);
      expect(evaluateConditionsMock).not.toHaveBeenCalled();
    });

    it('404s without evaluating for a caller restricted to zero sites', async () => {
      getMonitorDefinitionMock.mockResolvedValue(monitorRow());
      selectMock.mockReturnValueOnce(selectChain([{ id: DEVICE_IN_A, siteId: SITE_A }]));

      const res = await jsonRequest(buildApp({ allowedSiteIds: [] }), 'POST', `/${MONITOR_ID}/test`, {
        deviceId: DEVICE_IN_A,
      });

      expect(res.status).toBe(404);
      expect(evaluateConditionsMock).not.toHaveBeenCalled();
    });

    it("evaluates a device inside the caller's allowed sites", async () => {
      getMonitorDefinitionMock.mockResolvedValue(monitorRow());
      selectMock.mockReturnValueOnce(selectChain([{ id: DEVICE_IN_A, siteId: SITE_A }]));
      vi.mocked(evaluateConditionsMock).mockResolvedValue({ matched: false } as never);

      const res = await jsonRequest(buildApp({ allowedSiteIds: [SITE_A] }), 'POST', `/${MONITOR_ID}/test`, {
        deviceId: DEVICE_IN_A,
      });

      expect(res.status).toBe(200);
      expect(evaluateConditionsMock).toHaveBeenCalledTimes(1);
      expect(vi.mocked(evaluateConditionsMock).mock.calls[0]?.[1]).toBe(DEVICE_IN_A);
    });

    it('evaluates any org device for an unrestricted caller', async () => {
      getMonitorDefinitionMock.mockResolvedValue(monitorRow());
      selectMock.mockReturnValueOnce(selectChain([{ id: DEVICE_IN_B, siteId: SITE_B }]));
      vi.mocked(evaluateConditionsMock).mockResolvedValue({ matched: false } as never);

      const res = await jsonRequest(buildApp(), 'POST', `/${MONITOR_ID}/test`, { deviceId: DEVICE_IN_B });

      expect(res.status).toBe(200);
      expect(evaluateConditionsMock).toHaveBeenCalledTimes(1);
    });
  });
});

vi.mock('./monitorDefinitions.conversion', async () => {
  const { Hono } = await import('hono');
  return { monitorConversionRoutes: new Hono().get('/pending', (c) => c.json({ data: { policies: 0, rows: 0 } })) };
});
it('mounts the literal conversion resource before monitor ids', async () => {
  const response = await jsonRequest(buildApp(), 'GET', '/conversion/pending');
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ data: { policies: 0, rows: 0 } });
  expect(getMonitorDefinitionMock).not.toHaveBeenCalled();
});
