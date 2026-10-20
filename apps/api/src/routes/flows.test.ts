import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuthContext } from '../middleware/auth';

vi.mock('../middleware/auth', () => ({
  authMiddleware: vi.fn((c: any, next: any) => next()),
  requireScope: vi.fn(() => async (_c: any, next: any) => next()),
  // Stamps the checked permission so a deleted/mis-pointed gate fails the route's own assertion.
  requirePermission: vi.fn((resource: string, action: string) => async (c: any, next: any) => {
    c.header('X-Test-Permission-Checked', `${resource}:${action}`);
    if ((c.get('auth') as { denyAll?: boolean } | undefined)?.denyAll) return c.json({ error: 'Forbidden' }, 403);
    return next();
  }),
}));
vi.mock('../services/flows/service', () => ({ listFlows: vi.fn(), getFlow: vi.fn() }));

import { authMiddleware } from '../middleware/auth';
import { getFlow, listFlows } from '../services/flows/service';
import { flowsRoutes } from './flows';

const FLOW_ID = '11111111-1111-4111-8111-111111111111';
const ORG_ID = '33333333-3333-4333-8333-333333333333';

function setAuth(auth: Partial<AuthContext> & { denyAll?: boolean }) {
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
});
