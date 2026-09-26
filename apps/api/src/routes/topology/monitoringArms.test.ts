import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

const mocks = vi.hoisted(() => ({
  armPolicy: vi.fn(),
  disarmPolicy: vi.fn(),
  armTelemetry: vi.fn(),
  revokeTelemetry: vi.fn(),
  validate: vi.fn(),
  consume: vi.fn(),
  principal: 'user_session' as string,
  mfa: true,
}));
vi.mock('../../services/topology/monitoringArming', () => ({ armTopologyMonitoringPolicy: mocks.armPolicy, disarmTopologyMonitoringPolicy: mocks.disarmPolicy }));
vi.mock('../../services/topology/telemetryArms', () => ({ armTopologyTelemetry: mocks.armTelemetry, revokeTopologyTelemetryArm: mocks.revokeTelemetry }));
vi.mock('../../services/authEpochs', () => ({ getUserEpochs: async () => ({ authEpoch: 3, mfaEpoch: 5 }) }));
vi.mock('../../services/mfaStepUpGrant', async (original) => ({
  ...(await original<object>()),
  validateStepUpGrant: mocks.validate,
  consumeStepUpGrant: mocks.consume,
}));
vi.mock('../auth/schemas', () => ({ ENABLE_2FA: true }));
vi.mock('../../middleware/auth', async (original) => {
  const actual = await original<typeof import('../../middleware/auth')>();
  return {
    ...actual,
    requireMfa: () => async (c: any, next: any) => (mocks.mfa ? next() : c.json({ error: 'MFA required' }, 403)),
  };
});
vi.mock('./middleware', () => ({
  requireTopologySiteCapability: () => async (c: any, next: any) => {
    c.set('topologyContext', { scope: { siteId: c.req.param('siteId'), orgId: '10000000-0000-4000-8000-000000000001' } });
    await next();
  },
}));

import { topologyMonitoringArmRoutes } from './monitoringArms';
import { topologyArmResourceDigest } from '../../services/mfaStepUpGrant';

const siteId = '00000000-0000-4000-8000-000000000001';
const policyId = '00000000-0000-4000-8000-000000000002';
const nodeId = '00000000-0000-4000-8000-000000000003';

function app() {
  return new Hono()
    .use('*', async (c, next) => {
      c.set('auth', { user: { id: 'user-1' }, principal: { kind: mocks.principal }, token: { mfa: mocks.mfa, sid: 'sid-1' } } as never);
      await next();
    })
    .route('/topology', topologyMonitoringArmRoutes);
}
const post = (path: string, body: unknown) => app().request(`/topology/sites/${siteId}${path}`, {
  method: 'POST', body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' },
});

beforeEach(() => {
  vi.clearAllMocks();
  mocks.principal = 'user_session';
  mocks.mfa = true;
  mocks.validate.mockResolvedValue(true);
  mocks.consume.mockResolvedValue(true);
  mocks.armPolicy.mockImplementation(async (_ctx, _id, _req, deps) => { await deps.consumeStepUp?.(); return { policyId, enabled: true }; });
  mocks.armTelemetry.mockImplementation(async (_ctx, _req, deps) => { await deps.consumeStepUp?.(); return { id: 'arm' }; });
});

describe('topology arming routes (human-only, M3-D12)', () => {
  it.each(['api_key', 'oauth_grant', 'ai_agent'])('refuses a %s principal before any lookup', async (principal) => {
    mocks.principal = principal;
    const res = await post(`/policies/${policyId}/arm`, { expectedRevision: '1', stepUpGrantId: 'g' });
    expect(res.status).toBe(403);
    expect(mocks.validate).not.toHaveBeenCalled();
    expect(mocks.armPolicy).not.toHaveBeenCalled();
  });

  it('requires a satisfied second factor', async () => {
    mocks.mfa = false;
    expect((await post(`/policies/${policyId}/arm`, { expectedRevision: '1', stepUpGrantId: 'g' })).status).toBe(403);
    expect(mocks.armPolicy).not.toHaveBeenCalled();
  });

  it('refuses a missing or mismatched step-up grant with no write', async () => {
    const missing = await post(`/policies/${policyId}/arm`, { expectedRevision: '1' });
    expect(missing.status).toBe(403);
    expect(await missing.json()).toMatchObject({ code: 'step_up_required' });
    mocks.validate.mockResolvedValueOnce(false);
    expect((await post(`/policies/${policyId}/arm`, { expectedRevision: '1', stepUpGrantId: 'g' })).status).toBe(403);
    expect(mocks.armPolicy).not.toHaveBeenCalled();
  });

  it('binds the grant to the exact site/action/subject and consumes it inside the arm', async () => {
    const res = await post(`/policies/${policyId}/arm`, { expectedRevision: '1', stepUpGrantId: 'g' });
    expect(res.status).toBe(200);
    const binding = { userId: 'user-1', operation: 'topology_arm', authEpoch: 3, mfaEpoch: 5, sid: 'sid-1',
      resourceDigest: topologyArmResourceDigest({ siteId, action: 'arm_policy', subjectId: policyId }) };
    expect(mocks.validate).toHaveBeenCalledWith('g', binding);
    expect(mocks.consume).toHaveBeenCalledWith('g', binding);
    expect(topologyArmResourceDigest({ siteId, action: 'arm_policy', subjectId: policyId }))
      .not.toBe(topologyArmResourceDigest({ siteId, action: 'arm_telemetry', subjectId: policyId }));
  });

  it('rolls the arm back when the grant was consumed elsewhere', async () => {
    mocks.consume.mockResolvedValueOnce(false);
    const res = await post(`/policies/${policyId}/arm`, { expectedRevision: '1', stepUpGrantId: 'g' });
    expect(res.status).toBe(403);
  });

  it('arms telemetry under a grant bound to the target node', async () => {
    const res = await post('/telemetry-arms', {
      targetNodeId: nodeId, collectorDeviceId: nodeId, credentialProfileId: nodeId, interfaceIds: [nodeId], stepUpGrantId: 'g',
    });
    expect(res.status).toBe(201);
    expect(mocks.validate).toHaveBeenCalledWith('g', expect.objectContaining({
      resourceDigest: topologyArmResourceDigest({ siteId, action: 'arm_telemetry', subjectId: nodeId }),
    }));
  });

  it('disarm and revoke reduce authority without a step-up but stay human-only', async () => {
    mocks.disarmPolicy.mockResolvedValue({ enabled: false });
    expect((await post(`/policies/${policyId}/disarm`, { expectedRevision: '2' })).status).toBe(200);
    expect(mocks.validate).not.toHaveBeenCalled();
    mocks.principal = 'api_key';
    expect((await post(`/policies/${policyId}/disarm`, { expectedRevision: '2' })).status).toBe(403);
  });
});
