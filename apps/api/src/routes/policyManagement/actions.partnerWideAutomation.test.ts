import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

// #4952 — cross-tenant automation execution through policy remediation.
//
// Automations are dual-owned (org_id XOR partner_id, #2133). Both policy
// action routes resolved the remediation automation with a dual-axis
// condition — `org_id = <policy org> OR (org_id IS NULL AND partner_id =
// <that org's partner>)` — that was NOT gated on the CALLER's scope. Org
// tokens carry a partnerId (`middleware/auth.ts` feeds it into
// DbAccessContext.currentPartnerId), so the arm matched for a plain org user.
//
// RLS used to compensate by making partner-wide automation rows invisible to
// an org context. This PR's partner-wide SELECT branch deliberately makes them
// readable (it is load-bearing for agent config delivery), which turns the
// latent app-layer hole into a live one — so these gates are now the only
// control on the partner axis for these routes.
//
// Blast radius on /remediate: the run is enqueued with NO target argument, so
// `automationRuntime` expands a partner-wide automation across EVERY org under
// the partner. An org admin holding `devices:write` on their own org-owned
// policy could therefore run a script on other tenants' devices.

const ORG_ID = '11111111-1111-1111-1111-111111111111';
const PARTNER_ID = '33333333-3333-3333-3333-333333333333';
const OTHER_PARTNER_ID = '44444444-4444-4444-4444-444444444444';
const POLICY_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const AUTOMATION_ID = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const RUN_ID = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';

const enqueueAutomationRunMock = vi.fn().mockResolvedValue({ enqueued: true });
vi.mock('../../jobs/automationWorker', () => ({
  enqueueAutomationRun: (...args: unknown[]) => enqueueAutomationRunMock(...args),
}));

vi.mock('../../services', () => ({}));
vi.mock('../../services/auditEvents', () => ({ writeRouteAudit: vi.fn() }));

const evaluatePolicyMock = vi.fn().mockResolvedValue({
  policyId: POLICY_ID,
  devicesEvaluated: 1,
  summary: { compliant: 1, non_compliant: 0 },
  evaluatedAt: new Date('2026-10-11').toISOString(),
});
const resolveRemediationIdMock = vi.fn().mockResolvedValue(AUTOMATION_ID);
vi.mock('../../services/policyEvaluationService', () => ({
  evaluatePolicy: (...args: unknown[]) => evaluatePolicyMock(...args),
  resolvePolicyRemediationAutomationId: (...args: unknown[]) => resolveRemediationIdMock(...args),
}));

const selectMock = vi.fn();
const insertMock = vi.fn();
const updateMock = vi.fn();
vi.mock('../../db', () => ({
  db: {
    select: (...args: unknown[]) => selectMock(...args),
    insert: (...args: unknown[]) => insertMock(...args),
    update: (...args: unknown[]) => updateMock(...args),
    delete: vi.fn(),
  },
  runOutsideDbContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
  withDbAccessContext: vi.fn(async (_ctx: unknown, fn: () => Promise<unknown>) => fn()),
  withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
}));

vi.mock('../../db/schema', () => ({
  automationPolicies: { id: 'id', orgId: 'orgId', partnerId: 'partnerId' },
  automationRuns: { id: 'id', status: 'status', startedAt: 'startedAt' },
  automations: {
    id: 'id',
    orgId: 'orgId',
    partnerId: 'partnerId',
    enabled: 'enabled',
    runCount: 'runCount',
    lastRunAt: 'lastRunAt',
    updatedAt: 'updatedAt',
  },
  organizations: { id: 'id', partnerId: 'partnerId', type: 'type' },
}));

let currentAuth: Record<string, unknown>;
vi.mock('../../middleware/auth', () => ({
  authMiddleware: vi.fn((c: any, next: any) => {
    c.set('auth', currentAuth);
    return next();
  }),
  requireScope: vi.fn(() => async (_c: any, next: any) => next()),
  requirePermission: vi.fn(() => async (_c: any, next: any) => next()),
}));

import { actionRoutes } from './actions';
import { authMiddleware } from '../../middleware/auth';

/** Queue results for the successive `.select()` chains the route performs. */
function queueSelects(...results: unknown[][]) {
  const queue = [...results];
  selectMock.mockImplementation(() => {
    const chain: Record<string, unknown> = {};
    const step = () => chain;
    chain.from = step;
    chain.where = step;
    chain.limit = () => Promise.resolve(queue.shift() ?? []);
    chain.then = (resolve: (v: unknown) => unknown) => resolve(queue.shift() ?? []);
    return chain;
  });
}

const ORG_OWNED_POLICY = {
  id: POLICY_ID,
  orgId: ORG_ID,
  partnerId: null,
  name: 'Org policy',
  enabled: true,
  enforcement: 'enforce',
  rules: [{ type: 'required_software', softwareName: 'Chrome' }],
  remediationScriptId: null,
};

/** A partner-wide automation (org_id NULL) owned by the org's own partner. */
const PARTNER_WIDE_AUTOMATION = {
  id: AUTOMATION_ID,
  orgId: null,
  partnerId: PARTNER_ID,
  enabled: true,
  managedByAgentId: null,
  name: 'Partner-wide remediation',
};

function orgScopedAuth() {
  return {
    user: { id: 'user-org', email: 'org@example.com', name: 'Org User' },
    scope: 'organization',
    orgId: ORG_ID,
    // Org tokens DO carry the partner id — that is exactly why matching on it
    // alone is not an authorization decision.
    partnerId: PARTNER_ID,
    partnerOrgAccess: null,
    accessibleOrgIds: [ORG_ID],
    canAccessOrg: (orgId: string) => orgId === ORG_ID,
  };
}

function partnerScopedAuth(partnerId = PARTNER_ID) {
  return {
    user: { id: 'user-partner', email: 'partner@example.com', name: 'Partner User' },
    scope: 'partner',
    orgId: null,
    partnerId,
    partnerOrgAccess: 'all',
    accessibleOrgIds: [ORG_ID],
    canAccessOrg: (orgId: string) => orgId === ORG_ID,
  };
}

function makeApp() {
  const app = new Hono();
  app.use('*', authMiddleware as never);
  app.route('/policies', actionRoutes);
  return app;
}

beforeEach(() => {
  vi.clearAllMocks();
  selectMock.mockReset();
  insertMock.mockReset();
  updateMock.mockReset();
  enqueueAutomationRunMock.mockClear();
  resolveRemediationIdMock.mockResolvedValue(AUTOMATION_ID);
  evaluatePolicyMock.mockResolvedValue({
    policyId: POLICY_ID,
    devicesEvaluated: 1,
    summary: { compliant: 1, non_compliant: 0 },
    evaluatedAt: new Date('2026-10-11').toISOString(),
  });
  insertMock.mockReturnValue({
    values: () => ({
      returning: () => Promise.resolve([{ id: RUN_ID, status: 'running', startedAt: new Date() }]),
    }),
  });
  updateMock.mockReturnValue({ set: () => ({ where: () => Promise.resolve(undefined) }) });
  currentAuth = orgScopedAuth();
});

describe('POST /policies/:id/remediate — partner-wide automation visibility (#4952)', () => {
  it('404s for an ORG-scoped caller whose policy points at a partner-wide automation', async () => {
    currentAuth = orgScopedAuth();
    queueSelects(
      [ORG_OWNED_POLICY],            // getPolicyWithOrgCheck
      [{ partnerId: PARTNER_ID }],   // the policy org's partner
      [PARTNER_WIDE_AUTOMATION],     // the automation the (ungated) query returned
    );

    const res = await makeApp().request(`/policies/${POLICY_ID}/remediate`, {
      method: 'POST',
      headers: { Authorization: 'Bearer token' },
    });

    expect(res.status).toBe(404);
    // Never enqueued: no run may exist for an automation the caller cannot see.
    expect(insertMock).not.toHaveBeenCalled();
    expect(enqueueAutomationRunMock).not.toHaveBeenCalled();
  });

  it('404s for a PARTNER-scoped caller from a different partner', async () => {
    currentAuth = partnerScopedAuth(OTHER_PARTNER_ID);
    queueSelects(
      [ORG_OWNED_POLICY],
      [{ partnerId: PARTNER_ID }],
      [PARTNER_WIDE_AUTOMATION],
    );

    const res = await makeApp().request(`/policies/${POLICY_ID}/remediate`, {
      method: 'POST',
      headers: { Authorization: 'Bearer token' },
    });

    expect(res.status).toBe(404);
    expect(enqueueAutomationRunMock).not.toHaveBeenCalled();
  });

  it('runs for a PARTNER-scoped caller of the owning partner', async () => {
    currentAuth = partnerScopedAuth(PARTNER_ID);
    queueSelects(
      [ORG_OWNED_POLICY],
      [{ partnerId: PARTNER_ID }],
      [PARTNER_WIDE_AUTOMATION],
    );

    const res = await makeApp().request(`/policies/${POLICY_ID}/remediate`, {
      method: 'POST',
      headers: { Authorization: 'Bearer token' },
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ automationId: AUTOMATION_ID });
    expect(enqueueAutomationRunMock).toHaveBeenCalledWith(RUN_ID);
  });

  it('still runs for an ORG-scoped caller against an ORG-OWNED automation', async () => {
    currentAuth = orgScopedAuth();
    queueSelects(
      [ORG_OWNED_POLICY],
      [{ partnerId: PARTNER_ID }],
      [{ ...PARTNER_WIDE_AUTOMATION, orgId: ORG_ID, partnerId: null }],
    );

    const res = await makeApp().request(`/policies/${POLICY_ID}/remediate`, {
      method: 'POST',
      headers: { Authorization: 'Bearer token' },
    });

    expect(res.status).toBe(200);
    expect(enqueueAutomationRunMock).toHaveBeenCalledWith(RUN_ID);
  });
});

describe('POST /policies/:id/evaluate — caller identity reaches the remediation lookup (#4952)', () => {
  it('threads the ORG caller auth into evaluatePolicy so the partner-wide arm is gated', async () => {
    currentAuth = orgScopedAuth();
    queueSelects([ORG_OWNED_POLICY]);

    const res = await makeApp().request(`/policies/${POLICY_ID}/evaluate`, {
      method: 'POST',
      headers: { Authorization: 'Bearer token' },
    });

    expect(res.status).toBe(200);
    expect(evaluatePolicyMock).toHaveBeenCalledTimes(1);
    const [, options] = evaluatePolicyMock.mock.calls[0] as [unknown, { auth?: { scope?: string } }];
    // Without this the service defaults to the worker's system visibility and
    // resolves partner-wide automations for an org caller.
    expect(options.auth).toBeTruthy();
    expect(options.auth?.scope).toBe('organization');
  });

  it('threads the PARTNER caller auth through as partner scope', async () => {
    currentAuth = partnerScopedAuth(PARTNER_ID);
    queueSelects([ORG_OWNED_POLICY]);

    const res = await makeApp().request(`/policies/${POLICY_ID}/evaluate`, {
      method: 'POST',
      headers: { Authorization: 'Bearer token' },
    });

    expect(res.status).toBe(200);
    const [, options] = evaluatePolicyMock.mock.calls[0] as [
      unknown,
      { auth?: { scope?: string; partnerId?: string | null } },
    ];
    expect(options.auth?.scope).toBe('partner');
    expect(options.auth?.partnerId).toBe(PARTNER_ID);
  });

  it('passes the caller auth to resolvePolicyRemediationAutomationId on remediate', async () => {
    currentAuth = orgScopedAuth();
    queueSelects([ORG_OWNED_POLICY], [{ partnerId: PARTNER_ID }], []);

    await makeApp().request(`/policies/${POLICY_ID}/remediate`, {
      method: 'POST',
      headers: { Authorization: 'Bearer token' },
    });

    expect(resolveRemediationIdMock).toHaveBeenCalledTimes(1);
    const [, passedAuth] = resolveRemediationIdMock.mock.calls[0] as [unknown, { scope?: string }];
    expect(passedAuth?.scope).toBe('organization');
  });
});
