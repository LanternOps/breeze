/**
 * Multi-Tenant Isolation Tests
 *
 * These tests verify that cross-tenant data access is properly blocked at the
 * route level for devices, scripts, and alerts. Unlike most route tests that
 * mock away getDeviceWithOrgCheck/getScriptWithOrgCheck, these tests let those
 * helpers run so the actual security boundary is exercised.
 *
 * The pattern: mock the DB to return a resource belonging to ORG_B, then make
 * a request authenticated as ORG_A — the org-check helpers should deny access
 * and the route should return 403 or 404.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';

// ─── Constants ───────────────────────────────────────────────────────────────

const ORG_A_ID = '11111111-1111-1111-1111-111111111111';
const ORG_B_ID = '22222222-2222-2222-2222-222222222222';
const DEVICE_ID = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const SCRIPT_ID = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
const ALERT_ID  = 'cccccccc-cccc-cccc-cccc-cccccccccccc';

// ─── Mock DB (before any imports that touch it) ───────────────────────────────

vi.mock('../db', () => ({
  db: {
    select: vi.fn(),
    insert: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
  },
  withDbAccessContext: vi.fn(async (_ctx: any, fn: any) => fn()),
  withSystemDbAccessContext: vi.fn(async (fn: any) => fn()),
  runOutsideDbContext: vi.fn((fn: any) => fn()),
  SYSTEM_DB_ACCESS_CONTEXT: { scope: 'system', orgId: null, accessibleOrgIds: null },
}));

// ─── Mock DB schema (prevents Drizzle from trying to connect) ─────────────────

vi.mock('../db/schema', () => ({
  devices:                  { id: 'id', orgId: 'orgId', siteId: 'siteId', status: 'status', osType: 'osType', agentId: 'agentId' },
  deviceHardware:           { deviceId: 'deviceId' },
  deviceNetwork:            { deviceId: 'deviceId' },
  deviceMetrics:            { deviceId: 'deviceId', timestamp: 'timestamp' },
  deviceGroupMemberships:   { deviceId: 'deviceId', groupId: 'groupId', addedAt: 'addedAt', addedBy: 'addedBy' },
  deviceGroups:             { id: 'id', name: 'name', type: 'type' },
  deviceCommands:           { id: 'id', deviceId: 'deviceId', status: 'status', payload: 'payload' },
  enrollmentKeys:           { id: 'id', orgId: 'orgId' },
  sites:                    { id: 'id', orgId: 'orgId', name: 'name', timezone: 'timezone' },
  scripts:                  { id: 'id', orgId: 'orgId', isSystem: 'isSystem' },
  scriptExecutions:         { id: 'id', scriptId: 'scriptId', deviceId: 'deviceId', status: 'status' },
  scriptExecutionBatches:   { id: 'id', scriptId: 'scriptId', status: 'status' },
  alerts:                   { id: 'id', orgId: 'orgId', status: 'status', severity: 'severity', deviceId: 'deviceId', triggeredAt: 'triggeredAt' },
  alertRules:               { id: 'id', orgId: 'orgId', name: 'name' },
  alertTemplates:           { id: 'id' },
  notificationChannels:     { id: 'id', orgId: 'orgId' },
  alertNotifications:       { id: 'id' },
  escalationPolicies:       { id: 'id', orgId: 'orgId' },
  organizations:            { id: 'id' },
  partnerUsers:             {},
  organizationUsers:        {},
}));

// ─── Mock auth middleware ─────────────────────────────────────────────────────
// The middleware itself is a pass-through; auth context is injected per-test
// via a dedicated Hono middleware layer mounted before the routes.

vi.mock('../middleware/auth', () => ({
  authMiddleware:    vi.fn((c: any, next: any) => next()),
  requireScope:      vi.fn(() => (c: any, next: any) => next()),
  requirePermission: vi.fn(() => (c: any, next: any) => next()),
  requireMfa:        vi.fn(() => (c: any, next: any) => next()),
}));

// ─── Mock side-effect services ────────────────────────────────────────────────

vi.mock('../services/auditEvents', () => ({
  writeRouteAudit: vi.fn(),
  writeAuditEvent: vi.fn(),
}));

const { checkDeviceMaintenanceWindowMock } = vi.hoisted(() => ({
  checkDeviceMaintenanceWindowMock: vi.fn().mockResolvedValue({ active: false }),
}));

vi.mock('../services/featureConfigResolver', () => ({
  checkDeviceMaintenanceWindow: checkDeviceMaintenanceWindowMock,
}));

vi.mock('./agentWs', () => ({
  sendCommandToAgent: vi.fn().mockReturnValue(false),
}));

vi.mock('../services/enrollmentKeySecurity', () => ({
  hashEnrollmentKey:    vi.fn((k: string) => `hashed-${k}`),
  generateEnrollmentKey: vi.fn(() => 'ek_test'),
}));

vi.mock('../services/alertCooldown', () => ({
  setCooldown:                   vi.fn(),
  markConfigPolicyRuleCooldown:  vi.fn(),
}));

vi.mock('../services/eventBus', () => ({
  publishEvent: vi.fn(),
}));

vi.mock('../services/notificationSenders', () => ({
  validateEmailConfig:     vi.fn(() => ({ errors: [] })),
  validateWebhookConfig:   vi.fn(() => ({ errors: [] })),
  validateSmsConfig:       vi.fn(() => ({ errors: [] })),
  validatePagerDutyConfig: vi.fn(() => ({ errors: [] })),
}));

// ─── Route imports (must come AFTER vi.mock calls) ────────────────────────────

import { db } from '../db';
import { coreRoutes } from '../routes/devices/core';
import { scriptRoutes } from '../routes/scripts';
import { alertsRoutes } from '../routes/alerts/alerts';

// ─── Auth context factory ─────────────────────────────────────────────────────

function makeOrgAuth(orgId: string, overrides: Record<string, unknown> = {}): any {
  return {
    scope: 'organization',
    orgId,
    partnerId: null,
    user: { id: 'user-1', email: 'test@example.com', name: 'Test User' },
    token: { scope: 'organization' },
    accessibleOrgIds: [orgId],
    canAccessOrg: (id: string) => id === orgId,
    orgCondition: () => undefined,
    ...overrides,
  };
}

function makePartnerAuth(accessibleOrgIds: string[], overrides: Record<string, unknown> = {}): any {
  return {
    scope: 'partner',
    orgId: null,
    partnerId: 'partner-1',
    user: { id: 'user-1', email: 'partner@example.com', name: 'Partner User' },
    token: { scope: 'partner' },
    accessibleOrgIds,
    canAccessOrg: (id: string) => accessibleOrgIds.includes(id),
    orgCondition: () => undefined,
    ...overrides,
  };
}

// ─── DB mock helpers ──────────────────────────────────────────────────────────

/**
 * Mock db.select() chain for a single-result lookup returning one item.
 *   db.select().from(...).where(...).limit(1) => [item]
 */
function mockSelectOnce(result: unknown[]) {
  vi.mocked(db.select).mockReturnValueOnce({
    from: vi.fn().mockReturnValue({
      where: vi.fn().mockReturnValue({
        limit: vi.fn().mockResolvedValue(result),
      }),
    }),
  } as any);
}

/**
 * Mock db.select() chain with leftJoin support (e.g. for execute's inArray query).
 *   db.select().from(...).where(...) => [items]   (no limit)
 */
function mockSelectWithWhere(result: unknown[]) {
  vi.mocked(db.select).mockReturnValueOnce({
    from: vi.fn().mockReturnValue({
      where: vi.fn().mockResolvedValue(result),
      leftJoin: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue(result),
      }),
    }),
  } as any);
}

/**
 * Default select mock: returns empty arrays for any chained query shape.
 * Used to satisfy follow-up DB calls after the initial org-check lookup.
 */
function mockSelectEmpty() {
  vi.mocked(db.select).mockReturnValueOnce({
    from: vi.fn().mockReturnValue({
      where: vi.fn().mockReturnValue(
        Object.assign(Promise.resolve([]), {
          limit: vi.fn().mockResolvedValue([]),
          orderBy: vi.fn().mockReturnValue({
            limit: vi.fn().mockReturnValue({
              offset: vi.fn().mockResolvedValue([]),
            }),
          }),
          groupBy: vi.fn().mockResolvedValue([]),
        })
      ),
      leftJoin: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue(
          Object.assign(Promise.resolve([]), {
            orderBy: vi.fn().mockReturnValue({
              limit: vi.fn().mockResolvedValue([]),
            }),
            groupBy: vi.fn().mockResolvedValue([]),
          })
        ),
      }),
      groupBy: vi.fn().mockResolvedValue([]),
      orderBy: vi.fn().mockReturnValue({
        limit: vi.fn().mockReturnValue({
          offset: vi.fn().mockResolvedValue([]),
        }),
      }),
    }),
  } as any);
}

/** Minimal device record that lives in ORG_B */
function makeDeviceInOrgB(overrides: Record<string, unknown> = {}) {
  return {
    id: DEVICE_ID,
    orgId: ORG_B_ID,
    siteId: 'site-b-1',
    agentId: 'agent-b-1',
    hostname: 'host-b',
    displayName: 'Device B',
    osType: 'linux',
    osVersion: '22.04',
    osBuild: 'build-1',
    architecture: 'x86_64',
    agentVersion: '1.0.0',
    status: 'online',
    lastSeenAt: new Date(),
    enrolledAt: new Date(),
    tags: [],
    customFields: null,
    lastUser: null,
    uptimeSeconds: null,
    managementPosture: null,
    agentTokenHash: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

/** Minimal script record owned by ORG_B */
function makeScriptInOrgB(overrides: Record<string, unknown> = {}) {
  return {
    id: SCRIPT_ID,
    orgId: ORG_B_ID,
    isSystem: false,
    name: 'Org B Script',
    description: null,
    category: null,
    osTypes: ['linux'],
    language: 'bash',
    content: 'echo hello',
    parameters: null,
    timeoutSeconds: 300,
    runAs: 'system',
    version: 1,
    createdBy: 'user-b',
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

/** Minimal alert record owned by ORG_B */
function makeAlertInOrgB(overrides: Record<string, unknown> = {}) {
  return {
    id: ALERT_ID,
    orgId: ORG_B_ID,
    ruleId: 'rule-b-1',
    deviceId: DEVICE_ID,
    status: 'active',
    severity: 'high',
    title: 'High CPU',
    message: 'CPU at 95%',
    context: null,
    triggeredAt: new Date(),
    acknowledgedAt: null,
    acknowledgedBy: null,
    resolvedAt: null,
    resolvedBy: null,
    resolutionNote: null,
    suppressedUntil: null,
    createdAt: new Date(),
    ...overrides,
  };
}

// ─── Helper: build a Hono app that injects a fixed auth context ───────────────

function buildAppWithAuth(auth: any): { deviceApp: Hono; scriptApp: Hono; alertApp: Hono } {
  function injectAuth(app: Hono) {
    app.use('*', async (c, next) => {
      c.set('auth', auth);
      await next();
    });
  }

  const deviceApp = new Hono();
  injectAuth(deviceApp);
  deviceApp.route('/devices', coreRoutes);

  const scriptApp = new Hono();
  injectAuth(scriptApp);
  scriptApp.route('/scripts', scriptRoutes);

  const alertApp = new Hono();
  injectAuth(alertApp);
  alertApp.route('/alerts', alertsRoutes);

  return { deviceApp, scriptApp, alertApp };
}

// =============================================================================
// Tests
// =============================================================================

describe('Multi-tenant isolation', () => {
  beforeEach(() => {
    vi.resetAllMocks();

    // vi.resetAllMocks() clears implementations on hoisted mocks too;
    // re-establish the maintenance-window default so the execute path doesn't crash.
    checkDeviceMaintenanceWindowMock.mockResolvedValue({ active: false });

    // Restore a sensible default for all select chains so tests that don't
    // override still get a safe empty result rather than throwing.
    vi.mocked(db.select).mockImplementation(() => ({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue(
          Object.assign(Promise.resolve([]), {
            limit: vi.fn().mockResolvedValue([]),
            orderBy: vi.fn().mockReturnValue({
              limit: vi.fn().mockReturnValue({
                offset: vi.fn().mockResolvedValue([]),
              }),
            }),
            groupBy: vi.fn().mockResolvedValue([]),
          })
        ),
        leftJoin: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue(
            Object.assign(Promise.resolve([]), {
              orderBy: vi.fn().mockReturnValue({
                limit: vi.fn().mockResolvedValue([]),
              }),
            })
          ),
        }),
        groupBy: vi.fn().mockResolvedValue([]),
        orderBy: vi.fn().mockReturnValue({
          limit: vi.fn().mockReturnValue({
            offset: vi.fn().mockResolvedValue([]),
          }),
        }),
      }),
    }) as any);

    vi.mocked(db.insert).mockImplementation(() => ({
      values: vi.fn().mockReturnValue({
        returning: vi.fn().mockResolvedValue([]),
      }),
    }) as any);

    vi.mocked(db.update).mockImplementation(() => ({
      set: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          returning: vi.fn().mockResolvedValue([]),
        }),
      }),
    }) as any);

    vi.mocked(db.delete).mockImplementation(() => ({
      where: vi.fn().mockResolvedValue(undefined),
    }) as any);
  });

  // ===========================================================================
  // 1. Devices cross-tenant isolation
  // ===========================================================================

  describe('Devices — cross-tenant isolation', () => {
    it('GET /devices/:id — org user cannot read a device belonging to another org (returns 404)', async () => {
      // Security boundary: getDeviceWithOrgCheck fetches the device then calls
      // ensureOrgAccess(device.orgId, auth). Because device.orgId === ORG_B and
      // auth.orgId === ORG_A, ensureOrgAccess returns false → route returns 404.
      const { deviceApp } = buildAppWithAuth(makeOrgAuth(ORG_A_ID));

      // The helper does db.select().from(devices).where(eq(devices.id, ...)).limit(1)
      mockSelectOnce([makeDeviceInOrgB()]);

      const res = await deviceApp.request(`/devices/${DEVICE_ID}`);
      expect(res.status).toBe(404);
      const body = await res.json();
      expect(body.error).toMatch(/not found/i);
    });

    it('PATCH /devices/:id — org user cannot update a device belonging to another org (returns 404)', async () => {
      // Security boundary: PATCH also calls getDeviceWithOrgCheck before any update.
      const { deviceApp } = buildAppWithAuth(makeOrgAuth(ORG_A_ID));

      mockSelectOnce([makeDeviceInOrgB()]);

      const res = await deviceApp.request(`/devices/${DEVICE_ID}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ displayName: 'Hacked Name' }),
      });
      expect(res.status).toBe(404);
      const body = await res.json();
      expect(body.error).toMatch(/not found/i);
    });

    it('DELETE /devices/:id — org user cannot decommission a device belonging to another org (returns 404)', async () => {
      // Security boundary: DELETE also calls getDeviceWithOrgCheck before any update.
      const { deviceApp } = buildAppWithAuth(makeOrgAuth(ORG_A_ID));

      mockSelectOnce([makeDeviceInOrgB()]);

      const res = await deviceApp.request(`/devices/${DEVICE_ID}`, {
        method: 'DELETE',
      });
      expect(res.status).toBe(404);
      const body = await res.json();
      expect(body.error).toMatch(/not found/i);
    });

    it('GET /devices?orgId=ORG_B — org user cannot filter by a different org (returns 403)', async () => {
      // Security boundary: GET / calls auth.canAccessOrg(query.orgId) when orgId
      // query param is supplied. canAccessOrg returns false for ORG_B.
      const { deviceApp } = buildAppWithAuth(makeOrgAuth(ORG_A_ID));

      const res = await deviceApp.request(`/devices?orgId=${ORG_B_ID}`);
      expect(res.status).toBe(403);
      const body = await res.json();
      expect(body.error).toMatch(/denied/i);
    });

    it('GET /devices/:id — partner user with access only to ORG_A cannot read a device in ORG_B (returns 404)', async () => {
      // Security boundary: partner scope — ensureOrgAccess calls auth.canAccessOrg(device.orgId).
      // The partner's accessibleOrgIds contains only ORG_A, so canAccessOrg(ORG_B) is false.
      const { deviceApp } = buildAppWithAuth(makePartnerAuth([ORG_A_ID]));

      mockSelectOnce([makeDeviceInOrgB()]);

      const res = await deviceApp.request(`/devices/${DEVICE_ID}`);
      expect(res.status).toBe(404);
      const body = await res.json();
      expect(body.error).toMatch(/not found/i);
    });
  });

  // ===========================================================================
  // 2. Scripts cross-tenant isolation
  // ===========================================================================

  describe('Scripts — cross-tenant isolation', () => {
    it('GET /scripts/:id — org user cannot read a script belonging to another org (returns 404)', async () => {
      // Security boundary: getScriptWithOrgCheck fetches the script then calls
      // ensureOrgAccess(script.orgId, auth). auth.canAccessOrg(ORG_B) returns
      // false for an ORG_A user → helper returns null → route returns 404.
      const { scriptApp } = buildAppWithAuth(makeOrgAuth(ORG_A_ID));

      // scripts route's local ensureOrgAccess delegates entirely to auth.canAccessOrg,
      // so scope:'organization' users with orgId === ORG_A cannot reach ORG_B's scripts.
      mockSelectOnce([makeScriptInOrgB()]);

      const res = await scriptApp.request(`/scripts/${SCRIPT_ID}`);
      expect(res.status).toBe(404);
      const body = await res.json();
      expect(body.error).toMatch(/not found/i);
    });

    it('PUT /scripts/:id — org user cannot update a script belonging to another org (returns 404)', async () => {
      // Security boundary: PUT calls getScriptWithOrgCheck before any update.
      const { scriptApp } = buildAppWithAuth(makeOrgAuth(ORG_A_ID));

      mockSelectOnce([makeScriptInOrgB()]);

      const res = await scriptApp.request(`/scripts/${SCRIPT_ID}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Hijacked Script' }),
      });
      expect(res.status).toBe(404);
      const body = await res.json();
      expect(body.error).toMatch(/not found/i);
    });

    it('DELETE /scripts/:id — org user cannot delete a script belonging to another org (returns 404)', async () => {
      // Security boundary: DELETE calls getScriptWithOrgCheck before any deletion.
      const { scriptApp } = buildAppWithAuth(makeOrgAuth(ORG_A_ID));

      mockSelectOnce([makeScriptInOrgB()]);

      const res = await scriptApp.request(`/scripts/${SCRIPT_ID}`, {
        method: 'DELETE',
      });
      expect(res.status).toBe(404);
      const body = await res.json();
      expect(body.error).toMatch(/not found/i);
    });

    it('POST /scripts — partner user with canAccessOrg: () => false cannot create a script for another org (returns 403)', async () => {
      // Security boundary: POST / for partner scope calls ensureOrgAccess(orgId, auth)
      // before insertion. canAccessOrg always returns false here.
      const partnerAuth = makePartnerAuth([], {
        canAccessOrg: () => false,
      });
      const { scriptApp } = buildAppWithAuth(partnerAuth);

      const res = await scriptApp.request('/scripts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          orgId: ORG_B_ID,
          name: 'Malicious Script',
          osTypes: ['linux'],
          language: 'bash',
          content: 'echo owned',
        }),
      });
      expect(res.status).toBe(403);
      const body = await res.json();
      expect(body.error).toMatch(/denied/i);
    });
  });

  // ===========================================================================
  // 3. Cross-tenant execution isolation
  // ===========================================================================

  describe('Scripts — cross-tenant execution isolation', () => {
    it('POST /scripts/:id/execute — devices from another org are silently filtered out; request fails with 400 when no accessible devices remain', async () => {
      // Security boundary: execute iterates deviceRecords and calls ensureOrgAccess
      // per device. Devices in ORG_B are dropped; if no devices survive the filter
      // the route returns 400 ("No accessible or compatible devices found").
      //
      // Setup: auth is ORG_A, but the script and the requested device both belong
      // to ORG_B. The script check runs first; to get past it we use a system-script
      // (isSystem: true) so auth context doesn't block the script itself. This lets
      // us isolate the device-level org check in the execute handler.

      const orgAAuth = makeOrgAuth(ORG_A_ID);
      const { scriptApp } = buildAppWithAuth(orgAAuth);

      const systemScript = makeScriptInOrgB({ isSystem: true, orgId: null });

      // Call 1: getScriptWithOrgCheck — returns the system script (isSystem=true bypasses org check)
      mockSelectOnce([systemScript]);

      // Call 2: inArray lookup of deviceIds (no .limit on this query)
      // The devices returned belong to ORG_B — they should be filtered out.
      const deviceInOrgB = makeDeviceInOrgB({ osType: 'linux', status: 'online' });
      mockSelectWithWhere([deviceInOrgB]);

      const res = await scriptApp.request(`/scripts/${SCRIPT_ID}/execute`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          deviceIds: [DEVICE_ID],
        }),
      });

      // All devices were filtered → no accessible devices remain
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toMatch(/no accessible|no valid/i);
    });

    it('POST /scripts/:id/execute — only accessible devices are executed when ORG_A and ORG_B devices are mixed', async () => {
      // Security boundary: when an ORG_A partner user (with access to ORG_A only)
      // requests execution on two devices — one from ORG_A and one from ORG_B —
      // only the ORG_A device should be dispatched.

      const DEVICE_A_ID = 'aaaaaaaa-aaaa-aaaa-aaaa-000000000001';
      const DEVICE_B_ID = 'bbbbbbbb-bbbb-bbbb-bbbb-000000000002';

      const orgAAuth = makeOrgAuth(ORG_A_ID);
      const { scriptApp } = buildAppWithAuth(orgAAuth);

      // Use a system script to bypass script-level org check
      const systemScript = makeScriptInOrgB({ isSystem: true, orgId: null });
      mockSelectOnce([systemScript]);

      // Both devices returned from DB — one per org
      const deviceA = makeDeviceInOrgB({
        id: DEVICE_A_ID,
        orgId: ORG_A_ID,
        osType: 'linux',
        status: 'online',
        agentId: 'agent-a',
      });
      const deviceB = makeDeviceInOrgB({
        id: DEVICE_B_ID,
        orgId: ORG_B_ID,
        osType: 'linux',
        status: 'online',
        agentId: 'agent-b',
      });
      mockSelectWithWhere([deviceA, deviceB]);

      // The execute handler inserts two records per accessible device:
      //   1. scriptExecutions record
      //   2. deviceCommands record
      // sendCommandToAgent is mocked to return false so no subsequent updates occur.
      const execRecord = { id: 'exec-1', scriptId: SCRIPT_ID, deviceId: DEVICE_A_ID, status: 'pending', triggerType: 'manual', parameters: {}, startedAt: null, completedAt: null, exitCode: null, errorMessage: null, stdout: null, stderr: null, createdAt: new Date() };
      const cmdRecord  = { id: 'cmd-1',  deviceId: DEVICE_A_ID, type: 'script', status: 'pending', payload: {}, createdAt: new Date() };

      vi.mocked(db.insert)
        .mockReturnValueOnce({
          values: vi.fn().mockReturnValue({
            returning: vi.fn().mockResolvedValue([execRecord]),
          }),
        } as any)
        .mockReturnValueOnce({
          values: vi.fn().mockReturnValue({
            returning: vi.fn().mockResolvedValue([cmdRecord]),
          }),
        } as any);

      const res = await scriptApp.request(`/scripts/${SCRIPT_ID}/execute`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          deviceIds: [DEVICE_A_ID, DEVICE_B_ID],
        }),
      });

      // Device A (ORG_A) passes the org check; Device B (ORG_B) is filtered out.
      // With one valid device the insert chain is exercised and we get 201.
      expect(res.status).toBe(201);
      const body = await res.json();
      // Only one device should have been targeted (the ORG_A device)
      expect(body.devicesTargeted).toBe(1);
    });
  });

  // ===========================================================================
  // 4. Alerts cross-tenant isolation
  // ===========================================================================

  describe('Alerts — cross-tenant isolation', () => {
    it('POST /alerts/:id/acknowledge — org user cannot acknowledge an alert belonging to another org (returns 404)', async () => {
      // Security boundary: getAlertWithOrgCheck fetches the alert then calls
      // ensureOrgAccess(alert.orgId, auth). alert.orgId === ORG_B but auth is ORG_A
      // → helper returns null → route returns 404.
      const { alertApp } = buildAppWithAuth(makeOrgAuth(ORG_A_ID));

      mockSelectOnce([makeAlertInOrgB()]);

      const res = await alertApp.request(`/alerts/${ALERT_ID}/acknowledge`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      expect(res.status).toBe(404);
      const body = await res.json();
      expect(body.error).toMatch(/not found/i);
    });

    it('POST /alerts/:id/resolve — org user cannot resolve an alert belonging to another org (returns 404)', async () => {
      // Security boundary: same pattern as acknowledge — getAlertWithOrgCheck denies
      // access to ORG_B alerts when the caller is authenticated to ORG_A.
      const { alertApp } = buildAppWithAuth(makeOrgAuth(ORG_A_ID));

      mockSelectOnce([makeAlertInOrgB()]);

      const res = await alertApp.request(`/alerts/${ALERT_ID}/resolve`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ note: 'resolved' }),
      });
      expect(res.status).toBe(404);
      const body = await res.json();
      expect(body.error).toMatch(/not found/i);
    });

    it('GET /alerts?orgId=ORG_B — partner user without access to ORG_B is denied (returns 403)', async () => {
      // Security boundary: partner list route calls ensureOrgAccess(query.orgId, auth)
      // when an explicit orgId filter is requested. canAccessOrg returns false for ORG_B.
      const partnerAuth = makePartnerAuth([ORG_A_ID]); // ORG_B not in accessible list
      const { alertApp } = buildAppWithAuth(partnerAuth);

      const res = await alertApp.request(`/alerts?orgId=${ORG_B_ID}`);
      expect(res.status).toBe(403);
      const body = await res.json();
      expect(body.error).toMatch(/denied/i);
    });
  });
});
