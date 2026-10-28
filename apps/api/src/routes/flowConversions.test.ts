import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuthContext } from '../middleware/auth';

/**
 * Tool Catalog W06 (#5221) Task B1 — the conversion routes, reached through the
 * flows router (auth, kill switch and automations.read come from there).
 */
vi.mock('../middleware/auth', () => ({
  authMiddleware: vi.fn((c: any, next: any) => next()),
  requireScope: vi.fn(() => async (_c: any, next: any) => next()),
  isInteractiveUserSession: (a: { principal?: { kind?: string } }) => a.principal?.kind === 'user_session',
  requirePermission: vi.fn((resource: string, action: string) => async (c: any, next: any) => {
    c.header('X-Test-Permission-Checked', `${resource}:${action}`);
    const a = c.get('auth') as { deny?: string[] } | undefined;
    if (a?.deny?.includes(`${resource}:${action}`)) return c.json({ error: 'Forbidden' }, 403);
    return next();
  }),
  requireMfa: vi.fn(() => async (c: any, next: any) => {
    const a = c.get('auth') as { mfaUnsatisfied?: boolean } | undefined;
    if (a?.mfaUnsatisfied) return c.json({ error: 'MFA required', code: 'MFA_REQUIRED' }, 403);
    return next();
  }),
}));
vi.mock('../db', () => ({
  db: {},
  runOutsideDbContext: (fn: () => unknown) => fn(),
  withSystemDbAccessContext: async (fn: () => Promise<unknown>) => fn(),
  getCurrentDbAccessContext: () => ({ scope: 'organization' }),
}));
vi.mock('../services/flows/service', () => ({ listFlows: vi.fn(), getFlow: vi.fn() }));
vi.mock('../services/flows/versions', () => ({ enableFlow: vi.fn(), disableFlow: vi.fn() }));
vi.mock('../services/flows/webhook/secret', () => ({ createOrRotateWebhookSecret: vi.fn() }));
vi.mock('../services/flows/webhook/deliveries', () => ({ listWebhookDeliveries: vi.fn() }));
vi.mock('./flowLimits', () => ({ registerFlowLimitsRoutes: vi.fn() }));
vi.mock('../services/flows/runService', () => ({
  startManualRun: vi.fn(), cancelFlowRun: vi.fn(), listFlowRuns: vi.fn(), getFlowRun: vi.fn(), getFlowRunStep: vi.fn(),
}));
vi.mock('../services/flows/conversion/service', () => ({
  previewConversion: vi.fn(),
  createConversion: vi.fn(),
  createConversionsForOwner: vi.fn(),
  getConversion: vi.fn(),
  listConversions: vi.fn(),
}));
vi.mock('../services/flows/conversion/switch', () => ({ switchConversion: vi.fn() }));

import { authMiddleware } from '../middleware/auth';
import { getFlow } from '../services/flows/service';
import {
  createConversion,
  createConversionsForOwner,
  getConversion,
  listConversions,
  previewConversion,
} from '../services/flows/conversion/service';
import { switchConversion } from '../services/flows/conversion/switch';
import { flowsRoutes } from './flows';

const AUTOMATION = '66666666-6666-4666-8666-666666666666';
const CONV = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const ORG = '11111111-1111-4111-8111-111111111111';
const DIGEST = 'a'.repeat(64);

type TestAuth = Partial<AuthContext> & { deny?: string[]; mfaUnsatisfied?: boolean };
function setAuth(auth: TestAuth) {
  vi.mocked(authMiddleware).mockImplementation((c: any, next: any) => {
    c.set('auth', auth);
    return next();
  });
}
const session = (over: TestAuth = {}): TestAuth =>
  ({ scope: 'organization', orgId: ORG, principal: { kind: 'user_session' }, ...over } as TestAuth);

function post(path: string, body: unknown) {
  return flowsRoutes.request(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
}

describe('flow conversion routes', () => {
  beforeEach(() => {
    vi.stubEnv('FLOWS_ENABLED', 'true');
    setAuth(session());
    for (const fn of [previewConversion, createConversion, createConversionsForOwner, getConversion, listConversions, switchConversion]) vi.mocked(fn).mockReset();
    vi.mocked(getFlow).mockReset();
  });
  afterEach(() => vi.unstubAllEnvs());

  it('flag off is 404', async () => {
    vi.stubEnv('FLOWS_ENABLED', 'false');
    expect((await flowsRoutes.request(`/conversions/preview/${AUTOMATION}`)).status).toBe(404);
    expect((await post('/conversions', { automationId: AUTOMATION, expectedSourceDigest: DIGEST })).status).toBe(404);
    expect((await flowsRoutes.request('/conversions')).status).toBe(404);
    expect(previewConversion).not.toHaveBeenCalled();
    expect(createConversion).not.toHaveBeenCalled();
    expect(listConversions).not.toHaveBeenCalled();
  });

  it('no MFA is 403', async () => {
    setAuth(session({ mfaUnsatisfied: true }));
    const res = await post('/conversions', { automationId: AUTOMATION, expectedSourceDigest: DIGEST });
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ code: 'MFA_REQUIRED' });
    expect((await post('/conversions/bulk', { ownerScope: 'organization' })).status).toBe(403);
    expect(createConversion).not.toHaveBeenCalled();
    expect(createConversionsForOwner).not.toHaveBeenCalled();
  });

  it('API key session is 403 interactive_session_required', async () => {
    setAuth(session({ principal: { kind: 'api_key' } } as TestAuth));
    const res = await post('/conversions', { automationId: AUTOMATION, expectedSourceDigest: DIGEST });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'interactive_session_required' });
    const bulk = await post('/conversions/bulk', { ownerScope: 'organization' });
    expect(bulk.status).toBe(403);
    expect(createConversion).not.toHaveBeenCalled();
    expect(createConversionsForOwner).not.toHaveBeenCalled();
  });

  it('create needs automations.write; preview needs only automations.read', async () => {
    setAuth(session({ deny: ['automations:write'] }));
    const denied = await post('/conversions', { automationId: AUTOMATION, expectedSourceDigest: DIGEST });
    expect(denied.status).toBe(403);
    expect(denied.headers.get('X-Test-Permission-Checked')).toBe('automations:write');
    vi.mocked(previewConversion).mockResolvedValue({ automationId: AUTOMATION, fidelity: 'exact' } as never);
    const preview = await flowsRoutes.request(`/conversions/preview/${AUTOMATION}`);
    expect(preview.status).toBe(200);
    expect(preview.headers.get('X-Test-Permission-Checked')).toBe('automations:read');
  });

  it('preview of an invisible automation is 404, not the flow detail route', async () => {
    vi.mocked(previewConversion).mockResolvedValue(null);
    const res = await flowsRoutes.request(`/conversions/preview/${AUTOMATION}`);
    expect(res.status).toBe(404);
    expect(getFlow).not.toHaveBeenCalled();
  });

  it('maps create outcomes to statuses', async () => {
    const cases: Array<[unknown, number]> = [
      [{ ok: false, error: 'automation_not_found' }, 404],
      [{ ok: false, error: 'conversion_exists', conversionId: CONV }, 409],
      [{ ok: false, error: 'source_changed' }, 409],
      [{ ok: false, error: 'unconvertible', findings: [] }, 422],
      [{ ok: false, error: 'partner_wide_forbidden' }, 403],
      [{ ok: true, conversion: { id: CONV } }, 201],
    ];
    for (const [result, status] of cases) {
      vi.mocked(createConversion).mockResolvedValueOnce(result as never);
      const res = await post('/conversions', { automationId: AUTOMATION, expectedSourceDigest: DIGEST });
      expect(res.status).toBe(status);
    }
    expect(createConversion).toHaveBeenLastCalledWith(expect.anything(), AUTOMATION, { expectedSourceDigest: DIGEST });
  });

  it('validates the create body', async () => {
    expect((await post('/conversions', { automationId: AUTOMATION, expectedSourceDigest: 'nope' })).status).toBe(400);
    expect((await post('/conversions', { automationId: 'x', expectedSourceDigest: DIGEST })).status).toBe(400);
    expect(createConversion).not.toHaveBeenCalled();
  });

  it('bulk returns the counts', async () => {
    vi.mocked(createConversionsForOwner).mockResolvedValue({ ok: true, created: 2, skipped: { managed_row: 1 } });
    const res = await post('/conversions/bulk', { ownerScope: 'organization', orgId: ORG });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ created: 2, skipped: { managed_row: 1 } });
    expect(createConversionsForOwner).toHaveBeenCalledWith(expect.anything(), { ownerScope: 'organization', orgId: ORG });
  });

  it('list and get', async () => {
    vi.mocked(listConversions).mockResolvedValue({ conversions: [], total: 0 });
    const list = await flowsRoutes.request('/conversions?state=shadow');
    expect(list.status).toBe(200);
    expect(listConversions).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ state: 'shadow' }));
    expect((await flowsRoutes.request('/conversions?state=running')).status).toBe(400);

    vi.mocked(getConversion).mockResolvedValueOnce(null);
    expect((await flowsRoutes.request(`/conversions/${CONV}`)).status).toBe(404);
    vi.mocked(getConversion).mockResolvedValueOnce({ id: CONV } as never);
    const one = await flowsRoutes.request(`/conversions/${CONV}`);
    expect(one.status).toBe(200);
    expect(await one.json()).toEqual({ id: CONV });
    expect(getFlow).not.toHaveBeenCalled();
  });

  // W06 (#5221) Task B3 — POST /conversions/:id/switch.
  describe('switch', () => {
    const SWITCH = { expectedFlowVersion: 2, acceptDelegatorLifecycle: true };

    it('switch needs automations.write, MFA and an interactive session', async () => {
      setAuth(session({ deny: ['automations:write'] }));
      const denied = await post(`/conversions/${CONV}/switch`, SWITCH);
      expect(denied.status).toBe(403);
      expect(denied.headers.get('X-Test-Permission-Checked')).toBe('automations:write');

      setAuth(session({ mfaUnsatisfied: true }));
      const noMfa = await post(`/conversions/${CONV}/switch`, SWITCH);
      expect(noMfa.status).toBe(403);
      expect(await noMfa.json()).toMatchObject({ code: 'MFA_REQUIRED' });

      setAuth(session({ principal: { kind: 'api_key' } } as TestAuth));
      const apiKey = await post(`/conversions/${CONV}/switch`, SWITCH);
      expect(apiKey.status).toBe(403);
      expect(await apiKey.json()).toEqual({ error: 'interactive_session_required' });
      expect(switchConversion).not.toHaveBeenCalled();
    });

    it('flag off is 404', async () => {
      vi.stubEnv('FLOWS_ENABLED', 'false');
      expect((await post(`/conversions/${CONV}/switch`, SWITCH)).status).toBe(404);
      expect(switchConversion).not.toHaveBeenCalled();
    });

    it('validates the switch body: the delegator lifecycle must be accepted, pre-approvals default to none', async () => {
      expect((await post(`/conversions/${CONV}/switch`, { expectedFlowVersion: 2 })).status).toBe(400);
      expect((await post(`/conversions/${CONV}/switch`, { ...SWITCH, acceptDelegatorLifecycle: false })).status).toBe(400);
      expect((await post('/conversions/not-a-uuid/switch', SWITCH)).status).toBe(400);
      expect((await post(`/conversions/${CONV}/switch`, { ...SWITCH, preApprovals: [{ stepId: 'a0_command', maxTargets: 501 }] })).status).toBe(400);
      expect(switchConversion).not.toHaveBeenCalled();

      vi.mocked(switchConversion).mockResolvedValueOnce({ ok: true, conversion: { id: CONV } } as never);
      const ok = await post(`/conversions/${CONV}/switch`, SWITCH);
      expect(ok.status).toBe(200);
      expect(switchConversion).toHaveBeenCalledWith(expect.anything(), CONV, {
        expectedFlowVersion: 2, preApprovals: [], acceptScopeWidening: false, acceptDelegatorLifecycle: true, acknowledgeDivergence: false,
      });
    });

    it('maps switch outcomes to statuses', async () => {
      const cases: Array<[unknown, number]> = [
        [{ ok: false, error: 'conversion_not_found' }, 404],
        [{ ok: false, error: 'not_shadow' }, 409],
        [{ ok: false, error: 'source_changed' }, 409],
        [{ ok: false, error: 'version_conflict' }, 409],
        [{ ok: false, error: 'shadow_too_new' }, 409],
        [{ ok: false, error: 'shadow_too_short' }, 409],
        [{ ok: false, error: 'shadow_divergent' }, 409],
        [{ ok: false, error: 'scope_widening_not_accepted' }, 422],
        [{ ok: false, error: 'unconvertible', findings: [] }, 422],
        [{ ok: false, error: 'partner_wide_forbidden' }, 403],
        [{ ok: false, error: 'delegation_scope_restricted' }, 403],
        [{ ok: false, error: 'permission_missing', missing: [] }, 422],
        [{ ok: false, error: 'pre_approval_not_eligible', stepId: 'a0_command', reason: 'script_not_found' }, 422],
        [{ ok: false, error: 'event_dispatch_not_durable' }, 422],
      ];
      for (const [result, status] of cases) {
        vi.mocked(switchConversion).mockResolvedValueOnce(result as never);
        const res = await post(`/conversions/${CONV}/switch`, SWITCH);
        expect(res.status, JSON.stringify(result)).toBe(status);
        const body = await res.json();
        expect(body).not.toHaveProperty('ok');
        expect(body.error).toBe((result as { error: string }).error);
      }
    });
  });
});
