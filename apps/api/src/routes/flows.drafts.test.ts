/**
 * Flows completion W01b (#12435): the REST draft routes in routes/flows.ts.
 *
 *   POST   /flows            create a draft          automations.read + write, no MFA (P8)
 *   PUT    /flows/:id        replace a draft         automations.read + write, no MFA (P8)
 *   POST   /flows/validate   validate, write nothing automations.read
 *   DELETE /flows/:id        delete a never-run draft automations.read + delete + MFA
 *
 * The services are mocked: their own suites (service.test.ts, the integration
 * files) prove reach, owner and validation. Here: the gates, the body schemas,
 * and the failure → status table (plan Decision P13).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuthContext } from '../middleware/auth';

vi.mock('../middleware/auth', () => ({
  authMiddleware: vi.fn((c: any, next: any) => next()),
  requireScope: vi.fn(() => async (_c: any, next: any) => next()),
  isInteractiveUserSession: (a: { principal?: { kind?: string } }) => a.principal?.kind === 'user_session',
  // Appends each checked permission, so a test sees the whole chain.
  requirePermission: vi.fn((resource: string, action: string) => async (c: any, next: any) => {
    const prior = c.res.headers.get('X-Test-Permissions');
    c.header('X-Test-Permissions', prior ? `${prior},${resource}:${action}` : `${resource}:${action}`);
    const a = c.get('auth') as { denyAll?: boolean; deny?: string[] } | undefined;
    if (a?.denyAll || a?.deny?.includes(`${resource}:${action}`)) return c.json({ error: 'Forbidden' }, 403);
    return next();
  }),
  // A session without satisfied MFA is refused the way the real gate refuses it.
  requireMfa: vi.fn(() => async (c: any, next: any) => {
    c.header('X-Test-Mfa-Checked', '1');
    const a = c.get('auth') as { mfaUnsatisfied?: boolean } | undefined;
    if (a?.mfaUnsatisfied) return c.json({ error: 'MFA required', code: 'MFA_REQUIRED' }, 403);
    return next();
  }),
}));
vi.mock('../db', () => ({ db: {}, runOutsideDbContext: (fn: () => unknown) => fn(), withSystemDbAccessContext: vi.fn() }));
vi.mock('../services/flows/service', () => ({ listFlows: vi.fn(), getFlow: vi.fn(), saveDraftFlow: vi.fn() }));
vi.mock('../services/flows/versions', () => ({ enableFlow: vi.fn(), disableFlow: vi.fn() }));
vi.mock('../services/flows/deleteDraft', () => ({ deleteDraftFlow: vi.fn() }));
vi.mock('../services/flows/draftValidation', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../services/flows/draftValidation')>();
  return { ...actual, validateFlowDraft: vi.fn() };
});
vi.mock('../services/flows/webhook/secret', () => ({ createOrRotateWebhookSecret: vi.fn() }));
vi.mock('../services/flows/webhook/deliveries', () => ({ listWebhookDeliveries: vi.fn() }));
vi.mock('../services/flows/runService', () => ({
  startManualRun: vi.fn(), cancelFlowRun: vi.fn(), listFlowRuns: vi.fn(), getFlowRun: vi.fn(), getFlowRunStep: vi.fn(),
}));
vi.mock('./flowLimits', () => ({
  registerFlowLimitsRoutes: vi.fn((app: { put: (p: string, h: (c: any) => unknown) => void }) => {
    app.put('/limits', (c: any) => c.json({ stub: 'limits' }, 299));
  }),
}));

import { authMiddleware } from '../middleware/auth';
import { saveDraftFlow } from '../services/flows/service';
import { validateFlowDraft } from '../services/flows/draftValidation';
import { deleteDraftFlow } from '../services/flows/deleteDraft';
import { PARTNER_WIDE_WRITE_DENIED_MESSAGE } from '../services/partnerWideAccess';
import { flowsRoutes } from './flows';

const FLOW_ID = '11111111-1111-4111-8111-111111111111';
const ORG_ID = '33333333-3333-4333-8333-333333333333';
const DOC = { version: 1, name: 'Nightly', trigger: { type: 'manual' }, steps: [{ id: 'a', tool: 'wait', input: { minutes: 1 } }] };
const VALID = { valid: true, effectiveTier: 1, steps: [], issues: [] };
const INVALID = { valid: false, effectiveTier: null, steps: [], issues: [{ code: 'tool_not_found', severity: 'error', message: 'x', pointer: '/steps/0/tool' }] };
const FLOW = { id: FLOW_ID, definitionVersion: 2 };

function setAuth(auth: Partial<AuthContext> & { denyAll?: boolean; deny?: string[]; mfaUnsatisfied?: boolean }) {
  vi.mocked(authMiddleware).mockImplementation((c: any, next: any) => {
    c.set('auth', auth);
    return next();
  });
}

const send = (method: string, path: string, body: unknown) =>
  flowsRoutes.request(path, { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

describe('flows draft routes (W01b)', () => {
  beforeEach(() => {
    vi.stubEnv('FLOWS_ENABLED', 'true');
    setAuth({ scope: 'organization', orgId: ORG_ID } as Partial<AuthContext>);
    vi.mocked(saveDraftFlow).mockReset().mockResolvedValue({ saved: true, flow: FLOW, validation: VALID } as never);
    vi.mocked(validateFlowDraft).mockReset();
    vi.mocked(deleteDraftFlow).mockReset().mockResolvedValue({ ok: true });
  });
  afterEach(() => vi.unstubAllEnvs());

  // ── POST / ────────────────────────────────────────────────────────────────

  it('POST /flows saves a draft and is 201', async () => {
    const res = await send('POST', '/', { document: DOC, ownerScope: 'organization', orgId: ORG_ID, slug: 'nightly' });
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ flow: FLOW, validation: VALID });
    expect(res.headers.get('X-Test-Permissions')).toBe('automations:read,automations:write');
    expect(saveDraftFlow).toHaveBeenCalledWith(expect.anything(), { document: DOC, ownerScope: 'organization', orgId: ORG_ID, slug: 'nightly' });
  });

  it('an invalid document is 422 invalid with the validation', async () => {
    vi.mocked(saveDraftFlow).mockResolvedValue({ saved: false, validation: INVALID } as never);
    const res = await send('POST', '/', { document: DOC });
    expect(res.status).toBe(422);
    expect(await res.json()).toEqual({ error: 'invalid', validation: INVALID });
  });

  it('a selected-access partner user creating a partner-wide flow is 403 partner_wide_forbidden', async () => {
    setAuth({ scope: 'partner', partnerId: 'p1', partnerOrgAccess: 'selected' } as never);
    vi.mocked(saveDraftFlow).mockResolvedValue({ saved: false, error: PARTNER_WIDE_WRITE_DENIED_MESSAGE } as never);
    const res = await send('POST', '/', { document: DOC, ownerScope: 'partner' });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'partner_wide_forbidden' });
  });

  it.each([
    ['slug_unavailable', 409],
    ['slug_conflict', 409],
    ['invalid_slug', 422],
  ] as const)('a create that fails with %s is %i, the code checked before the validation', async (error, status) => {
    vi.mocked(saveDraftFlow).mockResolvedValue({ saved: false, error, validation: VALID } as never);
    const res = await send('POST', '/', { document: DOC, slug: 'nightly' });
    expect(res.status).toBe(status);
    expect((await res.json()).error).toBe(error);
  });

  it.each([
    ['Cannot access another organization', 403],
    ['Access denied to this organization', 403],
    ['Partner-wide flows require a partner-scoped caller', 403],
    ['orgId cannot be combined with ownerScope "partner"', 400],
    ['Organization context required', 400],
    ['orgId is required for this operation', 400],
    ['Organization not found', 400],
  ] as const)('owner message "%s" is %i owner_invalid', async (message, status) => {
    vi.mocked(saveDraftFlow).mockResolvedValue({ saved: false, error: message } as never);
    const res = await send('POST', '/', { document: DOC });
    expect(res.status).toBe(status);
    expect(await res.json()).toEqual({ error: 'owner_invalid', message });
  });

  it('a create body with a flowId or expectedVersion is 400 and never reaches the service', async () => {
    expect((await send('POST', '/', { document: DOC, flowId: FLOW_ID })).status).toBe(400);
    expect((await send('POST', '/', { document: DOC, expectedVersion: 1 })).status).toBe(400);
    expect((await send('POST', '/', { document: [] })).status).toBe(400);
    expect(saveDraftFlow).not.toHaveBeenCalled();
  });

  // ── PUT /:id ──────────────────────────────────────────────────────────────

  it('PUT /flows/:id replaces the draft and is 200', async () => {
    const res = await send('PUT', `/${FLOW_ID}`, { document: DOC, expectedVersion: 1 });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ flow: FLOW, validation: VALID });
    expect(res.headers.get('X-Test-Permissions')).toBe('automations:read,automations:write');
    expect(saveDraftFlow).toHaveBeenCalledWith(expect.anything(), { document: DOC, expectedVersion: 1, flowId: FLOW_ID });
  });

  it('PUT with a stale expectedVersion is 409 version_conflict', async () => {
    vi.mocked(saveDraftFlow).mockResolvedValue({ saved: false, error: 'version_conflict' } as never);
    const res = await send('PUT', `/${FLOW_ID}`, { document: DOC, expectedVersion: 1 });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'version_conflict' });
  });

  it('PUT on an enabled flow is 409 flow_not_draft', async () => {
    vi.mocked(saveDraftFlow).mockResolvedValue({ saved: false, error: 'flow_not_draft' } as never);
    const res = await send('PUT', `/${FLOW_ID}`, { document: DOC, expectedVersion: 1 });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'flow_not_draft' });
  });

  it('org token PUT on a partner-wide flow is 404', async () => {
    // updateDraft answers an org token on a partner-wide row as absent (service.test.ts pins the rule).
    vi.mocked(saveDraftFlow).mockResolvedValue({ saved: false, error: 'flow_not_found' } as never);
    const res = await send('PUT', `/${FLOW_ID}`, { document: DOC, expectedVersion: 1 });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'flow_not_found' });
  });

  it('a selected-access partner user updating a partner-wide flow is 403 partner_wide_forbidden', async () => {
    vi.mocked(saveDraftFlow).mockResolvedValue({ saved: false, error: PARTNER_WIDE_WRITE_DENIED_MESSAGE } as never);
    const res = await send('PUT', `/${FLOW_ID}`, { document: DOC, expectedVersion: 1 });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'partner_wide_forbidden' });
  });

  it('PUT without expectedVersion is 400', async () => {
    const res = await send('PUT', `/${FLOW_ID}`, { document: DOC });
    expect(res.status).toBe(400);
    expect(saveDraftFlow).not.toHaveBeenCalled();
  });

  it('PUT that tries to change the owner or slug is 400', async () => {
    expect((await send('PUT', `/${FLOW_ID}`, { document: DOC, expectedVersion: 1, ownerScope: 'partner' })).status).toBe(400);
    expect((await send('PUT', `/${FLOW_ID}`, { document: DOC, expectedVersion: 1, slug: 'other' })).status).toBe(400);
    expect(saveDraftFlow).not.toHaveBeenCalled();
  });

  it('PUT with a non-uuid id is 400', async () => {
    expect((await send('PUT', '/nope', { document: DOC, expectedVersion: 1 })).status).toBe(400);
    expect(saveDraftFlow).not.toHaveBeenCalled();
  });

  it('PUT /limits still reaches the limits route, not PUT /:id', async () => {
    const res = await send('PUT', '/limits', { anything: true });
    expect(res.status).toBe(299);
    expect(saveDraftFlow).not.toHaveBeenCalled();
  });

  // ── POST /validate ────────────────────────────────────────────────────────

  it('validate answers 200 { validation } for an invalid document', async () => {
    vi.mocked(validateFlowDraft).mockResolvedValue({ ok: true, validation: INVALID } as never);
    const res = await send('POST', '/validate', { document: DOC, flowId: FLOW_ID });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ validation: INVALID });
    expect(validateFlowDraft).toHaveBeenCalledWith(expect.anything(), { document: DOC, flowId: FLOW_ID });
  });

  it('validate needs only automations.read, and no MFA', async () => {
    setAuth({ scope: 'organization', orgId: ORG_ID, deny: ['automations:write'], mfaUnsatisfied: true } as never);
    vi.mocked(validateFlowDraft).mockResolvedValue({ ok: true, validation: VALID } as never);
    const res = await send('POST', '/validate', { document: DOC });
    expect(res.status).toBe(200);
    expect(res.headers.get('X-Test-Permissions')).toBe('automations:read');
    expect(res.headers.get('X-Test-Mfa-Checked')).toBeNull();
  });

  it('validate of an unknown flowId is 404 flow_not_found', async () => {
    vi.mocked(validateFlowDraft).mockResolvedValue({ ok: false, error: 'flow_not_found' } as never);
    const res = await send('POST', '/validate', { document: DOC, flowId: FLOW_ID });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'flow_not_found' });
  });

  it('validate: an access-denied owner message is 403 owner_invalid and any other is 400', async () => {
    vi.mocked(validateFlowDraft).mockResolvedValueOnce({ ok: false, error: 'owner_invalid', message: 'Cannot access another organization', accessDenied: true } as never);
    const denied = await send('POST', '/validate', { document: DOC, orgId: ORG_ID });
    expect(denied.status).toBe(403);
    expect(await denied.json()).toEqual({ error: 'owner_invalid', message: 'Cannot access another organization' });
    vi.mocked(validateFlowDraft).mockResolvedValueOnce({ ok: false, error: 'owner_invalid', message: 'Organization not found', accessDenied: false } as never);
    const malformed = await send('POST', '/validate', { document: DOC });
    expect(malformed.status).toBe(400);
    expect(await malformed.json()).toEqual({ error: 'owner_invalid', message: 'Organization not found' });
  });

  it('validate rejects an unknown body key and a non-uuid flowId with 400', async () => {
    expect((await send('POST', '/validate', { document: DOC, expectedVersion: 1 })).status).toBe(400);
    expect((await send('POST', '/validate', { document: DOC, flowId: 'nope' })).status).toBe(400);
    expect(validateFlowDraft).not.toHaveBeenCalled();
  });

  // ── DELETE /:id ───────────────────────────────────────────────────────────

  it('delete of a never-published draft is 204 with no body', async () => {
    const res = await send('DELETE', `/${FLOW_ID}`, { expectedVersion: 2 });
    expect(res.status).toBe(204);
    expect(await res.text()).toBe('');
    expect(res.headers.get('X-Test-Permissions')).toBe('automations:read,automations:delete');
    expect(res.headers.get('X-Test-Mfa-Checked')).toBe('1');
    expect(deleteDraftFlow).toHaveBeenCalledWith(expect.anything(), FLOW_ID, 2);
  });

  it.each([
    ['flow_not_found', 404],
    ['partner_wide_forbidden', 403],
    ['version_conflict', 409],
    ['flow_has_history', 409],
  ] as const)('a delete refused with %s is %i', async (error, status) => {
    vi.mocked(deleteDraftFlow).mockResolvedValue({ ok: false, error } as never);
    const res = await send('DELETE', `/${FLOW_ID}`, { expectedVersion: 2 });
    expect(res.status).toBe(status);
    expect(await res.json()).toEqual({ error });
  });

  it("a shadow conversion's draft is 409 flow_has_history with conversionId and automationId", async () => {
    const refusal = { ok: false, error: 'flow_has_history', conversionId: 'c1', automationId: 'a1' } as const;
    vi.mocked(deleteDraftFlow).mockResolvedValue(refusal);
    const res = await send('DELETE', `/${FLOW_ID}`, { expectedVersion: 2 });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'flow_has_history', conversionId: 'c1', automationId: 'a1' });
  });

  it('org token DELETE on a partner-wide flow is 404', async () => {
    // deleteDraft.test.ts pins the reach rule; here the 404 mapping.
    vi.mocked(deleteDraftFlow).mockResolvedValue({ ok: false, error: 'flow_not_found' });
    expect((await send('DELETE', `/${FLOW_ID}`, { expectedVersion: 2 })).status).toBe(404);
  });

  it('automations.write without automations.delete is 403', async () => {
    setAuth({ scope: 'organization', orgId: ORG_ID, deny: ['automations:delete'] } as never);
    const res = await send('DELETE', `/${FLOW_ID}`, { expectedVersion: 2 });
    expect(res.status).toBe(403);
    expect(res.headers.get('X-Test-Permissions')).toBe('automations:read,automations:delete');
    expect(deleteDraftFlow).not.toHaveBeenCalled();
  });

  it('an MFA-unsatisfied session is 403 MFA_REQUIRED on delete', async () => {
    setAuth({ scope: 'organization', orgId: ORG_ID, mfaUnsatisfied: true } as never);
    const res = await send('DELETE', `/${FLOW_ID}`, { expectedVersion: 2 });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'MFA required', code: 'MFA_REQUIRED' });
    expect(deleteDraftFlow).not.toHaveBeenCalled();
  });

  it('a delete without expectedVersion, or with extra keys, is 400', async () => {
    expect((await send('DELETE', `/${FLOW_ID}`, {})).status).toBe(400);
    expect((await send('DELETE', `/${FLOW_ID}`, { expectedVersion: 2, force: true })).status).toBe(400);
    expect(deleteDraftFlow).not.toHaveBeenCalled();
  });

  // ── gates ─────────────────────────────────────────────────────────────────

  it('an MFA-unsatisfied session can save a draft', async () => {
    setAuth({ scope: 'organization', orgId: ORG_ID, mfaUnsatisfied: true } as never);
    const created = await send('POST', '/', { document: DOC });
    expect(created.status).toBe(201);
    expect(created.headers.get('X-Test-Mfa-Checked')).toBeNull();
    const updated = await send('PUT', `/${FLOW_ID}`, { document: DOC, expectedVersion: 1 });
    expect(updated.status).toBe(200);
    expect(updated.headers.get('X-Test-Mfa-Checked')).toBeNull();
  });

  it('FLOWS_ENABLED=false makes every draft route 404', async () => {
    vi.stubEnv('FLOWS_ENABLED', 'false');
    expect((await send('POST', '/', { document: DOC })).status).toBe(404);
    expect((await send('PUT', `/${FLOW_ID}`, { document: DOC, expectedVersion: 1 })).status).toBe(404);
    expect((await send('POST', '/validate', { document: DOC })).status).toBe(404);
    expect((await send('DELETE', `/${FLOW_ID}`, { expectedVersion: 1 })).status).toBe(404);
    expect(deleteDraftFlow).not.toHaveBeenCalled();
    expect(saveDraftFlow).not.toHaveBeenCalled();
    expect(validateFlowDraft).not.toHaveBeenCalled();
  });

  it('automations.read alone cannot save', async () => {
    setAuth({ scope: 'organization', orgId: ORG_ID, deny: ['automations:write'] } as never);
    const created = await send('POST', '/', { document: DOC });
    expect(created.status).toBe(403);
    expect(created.headers.get('X-Test-Permissions')).toBe('automations:read,automations:write');
    expect((await send('PUT', `/${FLOW_ID}`, { document: DOC, expectedVersion: 1 })).status).toBe(403);
    expect(saveDraftFlow).not.toHaveBeenCalled();
  });

  it('automations.write without automations.read cannot save (the router-level read gate)', async () => {
    setAuth({ scope: 'organization', orgId: ORG_ID, deny: ['automations:read'] } as never);
    expect((await send('POST', '/', { document: DOC })).status).toBe(403);
    expect(saveDraftFlow).not.toHaveBeenCalled();
  });
});
