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
}));

vi.mock('../middleware/auth', () => ({
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
const { MonitorNotFoundError, MonitorOwnershipError, MonitorValidationError } = vi.hoisted(() => ({
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
}));

vi.mock('../services/monitors/monitorService', () => ({
  MonitorNotFoundError,
  MonitorOwnershipError,
  MonitorValidationError,
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

const ORG_ID = '33333333-3333-4333-8333-333333333333';
const USER_ID = '77777777-7777-4777-8777-777777777777';
const MONITOR_ID = '11111111-1111-4111-8111-111111111111';
const POLICY_ID = '22222222-2222-4222-8222-222222222222';

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
  it('returns one entry per monitor kind (13) with kind/overridableKeys/defaultSeverity/agentDelivered', async () => {
    const res = await jsonRequest(buildApp(), 'GET', '/kinds');

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: Array<{ kind: string; overridableKeys: string[]; defaultSeverity: string; agentDelivered: boolean }>;
    };
    expect(body.data).toHaveLength(13);
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
});
