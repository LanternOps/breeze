import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import { clientGate } from './clientGate';
import type { WorkspaceAuthContext, WorkspaceRouteEnv } from './adminGate';

const ORG_ID = '11111111-1111-4111-8111-111111111111';
const OTHER_ORG = '99999999-9999-4999-8999-999999999999';
const PARTNER_ID = '22222222-2222-4222-8222-222222222222';
const USER_ID = '33333333-3333-4333-8333-333333333333';

/** Exactly what the core /client/* proxy synthesizes for an add-in session. */
function orgAuth(overrides: Partial<WorkspaceAuthContext> = {}): WorkspaceAuthContext {
  return {
    user: { id: USER_ID, email: 'jenny@fairoaksca.gov', name: 'Jenny Tran' },
    scope: 'organization',
    orgId: ORG_ID,
    partnerId: undefined,
    accessibleOrgIds: [ORG_ID],
    ...overrides,
  } as WorkspaceAuthContext;
}

function gatedApp(auth: WorkspaceAuthContext | null) {
  const app = new Hono<WorkspaceRouteEnv>();
  app.use('*', async (c, next) => {
    if (auth) c.set('auth', auth);
    await next();
  });
  app.use('*', clientGate);
  app.get('/probe', (c) => c.json({ orgId: c.get('workspaceOrgId') }));
  return app;
}

describe('clientGate', () => {
  it('admits an organization-scoped session and pins the org from the auth context', async () => {
    const res = await gatedApp(orgAuth()).request('/probe');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ orgId: ORG_ID });
  });

  // The inverse of adminGate on purpose: /client is the end-user surface. A
  // partner- or system-scoped principal belongs on the admin surface, and
  // must not be able to drive an end-user filing action here.
  it.each([
    ['partner', { scope: 'partner' as const, partnerId: PARTNER_ID }],
    ['system', { scope: 'system' as const, accessibleOrgIds: null }],
  ])('rejects %s scope with 403', async (_label, overrides) => {
    const res = await gatedApp(orgAuth(overrides)).request('/probe');
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'organization access required' });
  });

  it.each([
    ['missing orgId', { orgId: undefined }],
    ['null orgId', { orgId: null }],
    ['blank orgId', { orgId: '   ' }],
  ])('rejects organization scope with %s', async (_label, overrides) => {
    const res = await gatedApp(orgAuth(overrides)).request('/probe');
    expect(res.status).toBe(403);
  });

  // Identity presence is a host invariant, but the handlers dereference the
  // org unconditionally: a missing auth var must name the condition here
  // rather than surface as a TypeError 500.
  it('rejects a request with no auth context at all', async () => {
    const res = await gatedApp(null).request('/probe');
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'organization access required' });
  });

  // The whole security story of this surface is "the actor is the end user":
  // every mutating handler dereferences `auth.user.id` and writes it into the
  // audit row. A context with no usable identity must be denied HERE, not
  // produce a TypeError 500 (match/assign) or — far worse — a successful
  // filing carrying `actorId: undefined` in the audit trail.
  it.each([
    ['no user at all', { user: undefined }],
    ['user with no id', { user: { email: 'jenny@fairoaksca.gov' } }],
    ['user with a blank id', { user: { id: '   ', email: 'jenny@fairoaksca.gov' } }],
    ['user with a non-string id', { user: { id: 7 } }],
  ])('rejects organization scope with %s', async (_label, overrides) => {
    const res = await gatedApp(orgAuth(overrides as Partial<WorkspaceAuthContext>)).request('/probe');
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'organization access required' });
  });

  // The proxy pins one org; an org outside the caller's own accessible set is
  // an upstream defect and must fail closed rather than be honored.
  it('rejects when the pinned org is absent from accessibleOrgIds', async () => {
    const res = await gatedApp(orgAuth({ accessibleOrgIds: [OTHER_ORG] })).request('/probe');
    expect(res.status).toBe(403);
  });

  it('rejects organization scope carrying no accessible org list', async () => {
    const res = await gatedApp(orgAuth({ accessibleOrgIds: null })).request('/probe');
    expect(res.status).toBe(403);
  });

  // adminGate reads ?orgId from the query; clientGate must NEVER let a query
  // parameter influence which org is served.
  it('ignores an orgId query parameter', async () => {
    const res = await gatedApp(orgAuth()).request(`/probe?orgId=${OTHER_ORG}`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ orgId: ORG_ID });
  });
});
