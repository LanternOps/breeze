import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuthContext } from '../middleware/auth';

vi.mock('../middleware/auth', () => ({
  authMiddleware: vi.fn((c: any, next: any) => next()),
  requireScope: vi.fn(() => async (_c: any, next: any) => next()),
  isInteractiveUserSession: (a: { principal?: { kind?: string } }) => a.principal?.kind === 'user_session',
  // Stamps the checked permission so a deleted/mis-pointed gate fails the route's own assertion.
  requirePermission: vi.fn((resource: string, action: string) => async (c: any, next: any) => {
    c.header('X-Test-Permission-Checked', `${resource}:${action}`);
    const a = c.get('auth') as { denyAll?: boolean; deny?: string[] } | undefined;
    if (a?.denyAll || a?.deny?.includes(`${resource}:${action}`)) return c.json({ error: 'Forbidden' }, 403);
    return next();
  }),
}));
vi.mock('../services/flows/service', () => ({ listFlows: vi.fn(), getFlow: vi.fn() }));
vi.mock('../services/flows/versions', () => ({ enableFlow: vi.fn(), disableFlow: vi.fn() }));
vi.mock('../services/flows/runService', () => ({
  startManualRun: vi.fn(),
  cancelFlowRun: vi.fn(),
  listFlowRuns: vi.fn(),
  getFlowRun: vi.fn(),
  getFlowRunStep: vi.fn(),
}));

import { authMiddleware } from '../middleware/auth';
import { getFlow, listFlows } from '../services/flows/service';
import { enableFlow, disableFlow } from '../services/flows/versions';
import { startManualRun, cancelFlowRun, listFlowRuns, getFlowRun, getFlowRunStep } from '../services/flows/runService';
import { flowsRoutes } from './flows';

const FLOW_ID = '11111111-1111-4111-8111-111111111111';
const ORG_ID = '33333333-3333-4333-8333-333333333333';

function setAuth(auth: Partial<AuthContext> & { denyAll?: boolean; deny?: string[] }) {
  vi.mocked(authMiddleware).mockImplementation((c: any, next: any) => {
    c.set('auth', auth);
    return next();
  });
}

describe('flows routes', () => {
  beforeEach(() => {
    vi.stubEnv('FLOWS_ENABLED', 'true');
    setAuth({ scope: 'organization', orgId: ORG_ID } as Partial<AuthContext>);
    vi.mocked(listFlows).mockReset().mockResolvedValue({ flows: [], total: 0 });
    vi.mocked(getFlow).mockReset();
  });
  afterEach(() => vi.unstubAllEnvs());

  it('404s with the flag off, without reaching the service', async () => {
    vi.stubEnv('FLOWS_ENABLED', 'false');
    const res = await flowsRoutes.request('/');
    expect(res.status).toBe(404);
    expect((await flowsRoutes.request(`/${FLOW_ID}`)).status).toBe(404);
    expect(listFlows).not.toHaveBeenCalled();
    expect(getFlow).not.toHaveBeenCalled();
  });

  it('403 without automations.read', async () => {
    setAuth({ scope: 'organization', denyAll: true } as never);
    const res = await flowsRoutes.request('/');
    expect(res.status).toBe(403);
    expect(res.headers.get('X-Test-Permission-Checked')).toBe('automations:read');
    expect(listFlows).not.toHaveBeenCalled();
  });

  it('list passes orgId, status, limit and offset', async () => {
    const res = await flowsRoutes.request(`/?orgId=${ORG_ID}&status=draft&limit=10&offset=20`);
    expect(res.status).toBe(200);
    expect(res.headers.get('X-Test-Permission-Checked')).toBe('automations:read');
    expect(await res.json()).toEqual({ flows: [], total: 0 });
    expect(listFlows).toHaveBeenCalledWith(expect.anything(), { orgId: ORG_ID, status: 'draft', limit: 10, offset: 20 });
  });

  it('list rejects a bad status / non-uuid orgId', async () => {
    expect((await flowsRoutes.request('/?status=running')).status).toBe(400);
    expect((await flowsRoutes.request('/?orgId=nope')).status).toBe(400);
  });

  it('detail 404s when the service returns null', async () => {
    vi.mocked(getFlow).mockResolvedValue(null);
    const res = await flowsRoutes.request(`/${FLOW_ID}`);
    expect(res.status).toBe(404);
    expect(res.headers.get('X-Test-Permission-Checked')).toBe('automations:read');
  });

  it('detail returns the flow and its live validation', async () => {
    const payload = { flow: { id: FLOW_ID }, validation: { valid: false, issues: [{ code: 'tool_not_found' }] } };
    vi.mocked(getFlow).mockResolvedValue(payload as never);
    const res = await flowsRoutes.request(`/${FLOW_ID}`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(payload);
  });

  it('detail rejects a non-uuid id', async () => {
    expect((await flowsRoutes.request('/not-a-uuid')).status).toBe(400);
    expect(getFlow).not.toHaveBeenCalled();
  });

  describe('W04 run routes', () => {
    const RUN_ID = '44444444-4444-4444-8444-444444444444';
    const STEP_ID = '55555555-5555-4555-8555-555555555555';
    const allServices = () => [enableFlow, disableFlow, startManualRun, cancelFlowRun, listFlowRuns, getFlowRun, getFlowRunStep];
    const post = (path: string, body?: unknown) =>
      flowsRoutes.request(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body ?? {}) });

    beforeEach(() => {
      for (const f of allServices()) vi.mocked(f as any).mockReset();
    });

    const routes: Array<[string, string, () => Response | Promise<Response>]> = [
      ['POST /:id/enable', 'automations:write', () => post(`/${FLOW_ID}/enable`, { expectedVersion: 1 })],
      ['POST /:id/disable', 'automations:write', () => post(`/${FLOW_ID}/disable`)],
      ['POST /:id/runs', 'automations:write', () => post(`/${FLOW_ID}/runs`, {})],
      ['GET /:id/runs', 'automations:read', () => flowsRoutes.request(`/${FLOW_ID}/runs`)],
      ['GET /runs/:runId', 'automations:read', () => flowsRoutes.request(`/runs/${RUN_ID}`)],
      ['GET step', 'automations:read', () => flowsRoutes.request(`/runs/${RUN_ID}/steps/${STEP_ID}`)],
      ['POST cancel', 'automations:write', () => post(`/runs/${RUN_ID}/cancel`)],
    ];

    it.each(routes)('%s 404s with the flag off, after auth', async (_n, _p, call) => {
      vi.stubEnv('FLOWS_ENABLED', 'false');
      expect((await call()).status).toBe(404);
      vi.mocked(authMiddleware).mockImplementation((c: any) => c.json({ error: 'Unauthorized' }, 401));
      expect((await call()).status).toBe(401);
      for (const f of allServices()) expect(f).not.toHaveBeenCalled();
    });

    it.each(routes)('%s 403s without its permission', async (_n, perm, call) => {
      setAuth({ scope: 'organization', orgId: ORG_ID, deny: [perm] } as never);
      expect((await call()).status).toBe(403);
      for (const f of allServices()) expect(f).not.toHaveBeenCalled();
    });

    it('write routes are stamped automations:write', async () => {
      vi.mocked(disableFlow).mockResolvedValue({ ok: true, cancelledRuns: 2 });
      const res = await post(`/${FLOW_ID}/disable`);
      expect(res.status).toBe(200);
      expect(res.headers.get('X-Test-Permission-Checked')).toBe('automations:write');
      expect(await res.json()).toEqual({ ok: true, cancelledRuns: 2 });
    });

    it('enable success returns 200 with the result', async () => {
      vi.mocked(enableFlow).mockResolvedValue({ ok: true, flow: { id: FLOW_ID }, publication: { id: 'p', publicationSeq: 1, definitionVersion: 1 } } as never);
      const res = await post(`/${FLOW_ID}/enable`, { expectedVersion: 3, preApprovedStepIds: ['a'] });
      expect(res.status).toBe(200);
      expect(enableFlow).toHaveBeenCalledWith(expect.anything(), FLOW_ID, { expectedVersion: 3, preApprovedStepIds: ['a'] });
    });

    it('enable rejects a bad body', async () => {
      expect((await post(`/${FLOW_ID}/enable`, {})).status).toBe(400);
      expect(enableFlow).not.toHaveBeenCalled();
    });

    it.each([
      ['flow_not_found', 404], ['version_conflict', 409], ['already_enabled', 409], ['slug_unavailable', 409],
      ['partner_wide_forbidden', 403], ['interactive_session_required', 403], ['delegation_scope_restricted', 403],
      ['event_dispatch_not_durable', 422], ['foreach_concurrency_not_available', 422],
    ])('enable maps %s to %i', async (error, status) => {
      vi.mocked(enableFlow).mockResolvedValue({ ok: false, error } as never);
      const res = await post(`/${FLOW_ID}/enable`, { expectedVersion: 1 });
      expect(res.status).toBe(status);
      expect((await res.json()).error).toBe(error);
    });

    it('enable maps invalid / permission_missing / pre_approval_not_eligible to 422 with details', async () => {
      vi.mocked(enableFlow).mockResolvedValueOnce({ ok: false, error: 'invalid', validation: { valid: false, issues: [] } } as never);
      let res = await post(`/${FLOW_ID}/enable`, { expectedVersion: 1 });
      expect(res.status).toBe(422);
      expect(await res.json()).toEqual({ error: 'invalid', validation: { valid: false, issues: [] } });
      vi.mocked(enableFlow).mockResolvedValueOnce({ ok: false, error: 'permission_missing', missing: [{ stepId: 's', permission: 'x:y' }] } as never);
      res = await post(`/${FLOW_ID}/enable`, { expectedVersion: 1 });
      expect(res.status).toBe(422);
      expect(await res.json()).toEqual({ error: 'permission_missing', missing: [{ stepId: 's', permission: 'x:y' }] });
      vi.mocked(enableFlow).mockResolvedValueOnce({ ok: false, error: 'pre_approval_not_eligible', stepId: 's', reason: 'r' } as never);
      res = await post(`/${FLOW_ID}/enable`, { expectedVersion: 1 });
      expect(res.status).toBe(422);
      expect(await res.json()).toEqual({ error: 'pre_approval_not_eligible', stepId: 's', reason: 'r' });
    });

    it.each([['flow_not_found', 404], ['not_enabled', 409], ['partner_wide_forbidden', 403]])('disable maps %s to %i', async (error, status) => {
      vi.mocked(disableFlow).mockResolvedValue({ ok: false, error } as never);
      expect((await post(`/${FLOW_ID}/disable`)).status).toBe(status);
    });

    it('POST runs returns 202 with runId and uses ui for an interactive session', async () => {
      setAuth({ scope: 'organization', orgId: ORG_ID, principal: { kind: 'user_session' } } as never);
      vi.mocked(startManualRun).mockResolvedValue({ ok: true, runId: RUN_ID, duplicate: false, preApprovalsHonored: true });
      const res = await post(`/${FLOW_ID}/runs`, { inputs: { a: 1 } });
      expect(res.status).toBe(202);
      expect(await res.json()).toEqual({ runId: RUN_ID, duplicate: false, preApprovalsHonored: true });
      expect(startManualRun).toHaveBeenCalledWith(expect.anything(), FLOW_ID, { inputs: { a: 1 } }, 'ui');
    });

    it('POST runs uses api for a non-session principal', async () => {
      setAuth({ scope: 'organization', orgId: ORG_ID, principal: { kind: 'api_key' } } as never);
      vi.mocked(startManualRun).mockResolvedValue({ ok: true, runId: RUN_ID, duplicate: true, preApprovalsHonored: false });
      expect((await post(`/${FLOW_ID}/runs`, {})).status).toBe(202);
      expect(vi.mocked(startManualRun).mock.calls[0]![3]).toBe('api');
    });

    it.each([
      ['flow_not_found', 404], ['not_enabled', 409], ['not_manual', 409], ['org_required', 422], ['org_forbidden', 403],
      ['interactive_user_required', 403], ['delegation_scope_restricted', 403], ['flow_queue_full', 429],
    ])('POST runs maps %s to %i', async (error, status) => {
      vi.mocked(startManualRun).mockResolvedValue({ ok: false, error } as never);
      const res = await post(`/${FLOW_ID}/runs`, {});
      expect(res.status).toBe(status);
      expect((await res.json()).error).toBe(error);
    });

    it('POST runs maps inputs_invalid and permission_missing to 422 with details', async () => {
      vi.mocked(startManualRun).mockResolvedValueOnce({ ok: false, error: 'inputs_invalid', issues: [{ name: 'a', message: 'bad' }] });
      let res = await post(`/${FLOW_ID}/runs`, {});
      expect(res.status).toBe(422);
      expect(await res.json()).toEqual({ error: 'inputs_invalid', issues: [{ name: 'a', message: 'bad' }] });
      vi.mocked(startManualRun).mockResolvedValueOnce({ ok: false, error: 'permission_missing', missing: [{ stepId: 's', permission: 'x:y' }] });
      res = await post(`/${FLOW_ID}/runs`, {});
      expect(res.status).toBe(422);
      expect(await res.json()).toEqual({ error: 'permission_missing', missing: [{ stepId: 's', permission: 'x:y' }] });
    });

    it('GET /:id/runs passes filters and validates them', async () => {
      vi.mocked(listFlowRuns).mockResolvedValue({ runs: [], total: 0 });
      const res = await flowsRoutes.request(`/${FLOW_ID}/runs?status=failed&orgId=${ORG_ID}&limit=50&offset=5`);
      expect(res.status).toBe(200);
      expect(listFlowRuns).toHaveBeenCalledWith(expect.anything(), { flowId: FLOW_ID, orgId: ORG_ID, status: 'failed', limit: 50, offset: 5 });
      expect((await flowsRoutes.request(`/${FLOW_ID}/runs?limit=101`)).status).toBe(400);
      expect((await flowsRoutes.request(`/${FLOW_ID}/runs?status=bogus`)).status).toBe(400);
    });

    it('GET /runs/:runId is not captured by /:id and requests body-less detail', async () => {
      vi.mocked(getFlowRun).mockResolvedValue({ id: RUN_ID, steps: [{ id: STEP_ID, hasBody: true }] } as never);
      const res = await flowsRoutes.request(`/runs/${RUN_ID}`);
      expect(res.status).toBe(200);
      expect(getFlow).not.toHaveBeenCalled();
      expect(getFlowRun).toHaveBeenCalledWith(expect.anything(), RUN_ID, { stepBodies: 'none' });
      const body = await res.json();
      expect(body.steps[0]).not.toHaveProperty('renderedInput');
      expect(body.steps[0]).not.toHaveProperty('output');
    });

    it('GET /runs/:runId 404s for a run the caller cannot see', async () => {
      vi.mocked(getFlowRun).mockResolvedValue(null);
      expect((await flowsRoutes.request(`/runs/${RUN_ID}`)).status).toBe(404);
    });

    it('step route returns bodies; 404 when the service returns null (other org)', async () => {
      vi.mocked(getFlowRunStep).mockResolvedValueOnce({ id: STEP_ID, renderedInput: { a: 1 }, output: { b: 2 } } as never);
      let res = await flowsRoutes.request(`/runs/${RUN_ID}/steps/${STEP_ID}`);
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ renderedInput: { a: 1 }, output: { b: 2 } });
      expect(getFlowRunStep).toHaveBeenCalledWith(expect.anything(), RUN_ID, STEP_ID);
      vi.mocked(getFlowRunStep).mockResolvedValueOnce(null);
      res = await flowsRoutes.request(`/runs/${RUN_ID}/steps/${STEP_ID}`);
      expect(res.status).toBe(404);
    });

    it('cancel returns status; 404 and 409 mapped', async () => {
      vi.mocked(cancelFlowRun).mockResolvedValueOnce({ ok: true, status: 'cancelled' });
      let res = await post(`/runs/${RUN_ID}/cancel`);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ status: 'cancelled' });
      vi.mocked(cancelFlowRun).mockResolvedValueOnce({ ok: false, error: 'already_terminal' });
      res = await post(`/runs/${RUN_ID}/cancel`);
      expect(res.status).toBe(409);
      expect((await res.json()).error).toBe('already_terminal');
      vi.mocked(cancelFlowRun).mockResolvedValueOnce({ ok: false, error: 'run_not_found' });
      expect((await post(`/runs/${RUN_ID}/cancel`)).status).toBe(404);
    });
  });
});
