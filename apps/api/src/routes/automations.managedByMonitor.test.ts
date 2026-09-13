import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';
import { automationRoutes, automationWebhookRoutes } from './automations';

// #5289 — a row compiled from a monitor definition (managed_by_monitor_id set)
// must refuse every non-compiler write: update, delete, and manual run. Side
// editing a compiled row would silently drift from its monitor definition
// until the next compile overwrote it.

vi.mock('../services/automationReadProjection', () => ({
  projectAutomationRunsToSites: vi.fn(async (runs: unknown[]) => runs),
  scanProjectedAutomationRuns: vi.fn(async () => ({
    rows: [], total: 0, statusCounts: { completed: 0, failed: 0, partial: 0 },
  })),
}));

vi.mock('../jobs/automationWorker', () => ({
  enqueueAutomationRun: vi.fn(async () => ({ enqueued: true, jobId: 'job-1' })),
}));

vi.mock('../services/redis', () => ({
  getRedis: vi.fn(() => null),
}));

vi.mock('../services/automationRuntime', () => ({
  AutomationValidationError: class AutomationValidationError extends Error {},
  createAutomationRunRecord: vi.fn(async () => ({
    run: {
      id: 'run-1',
      automationId: '11111111-1111-4111-8111-111111111111',
      triggeredBy: 'manual:user-123',
      status: 'running',
      devicesTargeted: 0,
      startedAt: new Date(),
      completedAt: null,
      createdAt: new Date(),
    },
    targetDeviceIds: [],
  })),
  normalizeAutomationActions: vi.fn((actions) => actions),
  normalizeAutomationTrigger: vi.fn((trigger) => trigger),
  normalizeNotificationTargets: vi.fn((targets) => targets ?? {}),
  resolveAutomationReferencesForOwner: vi.fn(),
  replaceAutomationResourceBindings: vi.fn(),
  withWebhookDefaults: vi.fn((trigger) => trigger),
  checkAutomationTargetsWithinSiteScope: vi.fn(async () => ({
    ok: true,
    outOfScopeDeviceIds: [],
    unbounded: false,
  })),
}));

vi.mock('../services/automationReferenceAuthorization', () => ({
  AutomationReferenceAuthorizationError: class AutomationReferenceAuthorizationError extends Error {
    readonly code = 'unknown_or_unauthorized_reference';
    constructor() {
      super('Unknown or unauthorized automation reference');
    }
  },
  resolveOwnedAutomationReferences: vi.fn(async () => ({
    scriptsById: new Map(),
    softwareCatalogsById: new Map(),
    softwareVersionsByCatalogId: new Map(),
    notificationChannelsById: new Map(),
  })),
}));

const automationRef: { current: Record<string, unknown> | undefined } = { current: undefined };

vi.mock('../db', () => ({
  db: {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => ({
          limit: vi.fn(() => Promise.resolve(automationRef.current ? [automationRef.current] : [])),
        })),
      })),
    })),
    insert: vi.fn(() => ({
      values: vi.fn(() => ({
        returning: vi.fn(() => Promise.resolve([])),
      })),
    })),
    update: vi.fn(() => ({
      set: vi.fn(() => ({
        where: vi.fn(() => ({
          returning: vi.fn(() => Promise.resolve([])),
        })),
      })),
    })),
    delete: vi.fn(() => ({
      where: vi.fn(() => Promise.resolve()),
    })),
    transaction: vi.fn(),
  },
  runOutsideDbContext: vi.fn((fn: () => any) => fn()),
  withSystemDbAccessContext: vi.fn(async (fn: () => any) => fn()),
}));

vi.mock('../db/schema', () => ({
  aiAgents: {},
  automations: {},
  automationRuns: {},
  automationRunDeviceResults: {},
  configurationPolicies: {},
  policies: {},
  policyCompliance: {},
  organizations: {},
  devices: {},
  scripts: {},
  scriptExecutions: {},
}));

vi.mock('../services/automationRunCancellation', () => ({
  cancelAutomationRun: vi.fn(),
}));
vi.mock('../services/scriptCancellation', () => ({
  MAX_GRACE_SECONDS: 30,
}));

vi.mock('../services/auditEvents', () => ({
  ANONYMOUS_ACTOR_ID: '00000000-0000-0000-0000-000000000000',
  writeRouteAudit: vi.fn(),
  writeAuditEvent: vi.fn(),
}));

vi.mock('../middleware/auth', () => ({
  authMiddleware: vi.fn((c: any, next: any) => {
    c.set('auth', {
      user: { id: 'user-123', email: 'test@example.com', name: 'Test User' },
      scope: 'organization',
      partnerId: null,
      orgId: 'org-123',
      token: { sub: 'user-123' },
      accessibleOrgIds: ['org-123'],
      canAccessOrg: (orgId: string) => orgId === 'org-123',
    });
    c.set('permissions', undefined);
    return next();
  }),
  requireMfa: vi.fn(() => async (_c: any, next: any) => next()),
  requirePermission: vi.fn(() => async (_c: any, next: any) => next()),
  requireScope: vi.fn(() => async (_c: any, next: any) => next()),
}));

const AUTOMATION_ID = '11111111-1111-4111-8111-111111111111';
const MONITOR_ID = '22222222-2222-4222-8222-222222222222';

function managedAutomation(overrides: Record<string, unknown> = {}) {
  return {
    id: AUTOMATION_ID,
    orgId: 'org-123',
    partnerId: null,
    name: 'Compiled automation',
    enabled: true,
    trigger: { type: 'manual' },
    conditions: null,
    actions: [],
    managedByAgentId: null,
    managedByMonitorId: MONITOR_ID,
    ...overrides,
  };
}

describe('automations routes — managed-by-monitor guard (#5289)', () => {
  let app: Hono;

  beforeEach(() => {
    vi.clearAllMocks();
    automationRef.current = undefined;
    app = new Hono();
    app.route('/automations/webhooks', automationWebhookRoutes);
    app.route('/automations', automationRoutes);
  });

  it('PUT /automations/:id on a monitor-managed automation is 409 automation_managed_by_monitor', async () => {
    automationRef.current = managedAutomation();
    const res = await app.request(`/automations/${AUTOMATION_ID}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer valid-token' },
      body: JSON.stringify({ name: 'x' }),
    });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'automation_managed_by_monitor', monitorId: MONITOR_ID });
  });

  it('DELETE /automations/:id on a monitor-managed automation is 409 automation_managed_by_monitor', async () => {
    automationRef.current = managedAutomation();
    const res = await app.request(`/automations/${AUTOMATION_ID}`, {
      method: 'DELETE',
      headers: { Authorization: 'Bearer valid-token' },
    });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'automation_managed_by_monitor', monitorId: MONITOR_ID });
  });

  it('POST /automations/:id/run on a monitor-managed automation is 409 automation_managed_by_monitor', async () => {
    automationRef.current = managedAutomation();
    const res = await app.request(`/automations/${AUTOMATION_ID}/run`, {
      method: 'POST',
      headers: { Authorization: 'Bearer valid-token' },
    });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'automation_managed_by_monitor', monitorId: MONITOR_ID });
  });

  it('POST /automations/:id/trigger on a monitor-managed automation is 409 automation_managed_by_monitor', async () => {
    automationRef.current = managedAutomation();
    const res = await app.request(`/automations/${AUTOMATION_ID}/trigger`, {
      method: 'POST',
      headers: { Authorization: 'Bearer valid-token' },
    });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'automation_managed_by_monitor', monitorId: MONITOR_ID });
  });
});
