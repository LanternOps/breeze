// apps/api/src/routes/trustPageTemplate.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';

const PARTNER = '33333333-3333-4333-8333-333333333333';
vi.mock('../middleware/auth', () => ({
  authMiddleware: async (c: any, next: any) => {
    if (!c.req.header('authorization')) return c.json({ error: 'Unauthorized' }, 401);
    const scope = c.req.header('x-scope') ?? 'partner';
    c.set('auth', {
      user: { id: 'u1', email: 'a@example.test' }, scope,
      partnerId: scope === 'partner' ? '33333333-3333-4333-8333-333333333333' : null,
      orgId: scope === 'organization' ? 'o1' : null,
      partnerOrgAccess: scope === 'partner' ? (c.req.header('x-org-access') ?? 'all') : undefined,
    });
    return next();
  },
  // Faithful stand-in: the real requireScope 403s a scope outside the list.
  requireScope: (...allowed: string[]) => async (c: any, next: any) =>
    allowed.includes(c.get('auth').scope) ? next() : c.json({ error: 'Forbidden', code: 'SCOPE' }, 403),
  requireMfa: () => async (c: any, next: any) => (c.req.header('x-mfa') === '1' ? next() : c.json({ error: 'MFA required', code: 'MFA_REQUIRED' }, 403)),
  requirePermission: (resource: string, action: string) => async (c: any, next: any) =>
    (c.req.header('x-allow') ?? '').split(',').includes(`${resource}:${action}`) ? next() : c.json({ error: 'Forbidden' }, 403),
}));
const svc = vi.hoisted(() => ({ loadPartnerTemplate: vi.fn(), savePartnerTemplate: vi.fn() }));
vi.mock('../services/trustPage/template', () => svc);
const auditMock = vi.hoisted(() => vi.fn());
vi.mock('../services/auditEvents', () => ({ writeRouteAudit: auditMock }));
const partnerRows = vi.hoisted(() => ({ rows: [] as unknown[][] }));
vi.mock('../db', () => {
  const chain = () => { const c: any = {}; for (const m of ['select', 'from', 'where', 'limit']) c[m] = vi.fn(() => c); c.then = (r: any) => Promise.resolve(partnerRows.rows.shift() ?? []).then(r); return c; };
  return { db: chain() };
});
import { trustPageTemplateRoutes } from './trustPageTemplate';

const app = new Hono(); app.route('/trust-page-template', trustPageTemplateRoutes);
const H = (extra: Record<string, string> = {}) => ({
  authorization: 'Bearer t', 'x-allow': 'organizations:read,organizations:write', 'x-mfa': '1', 'content-type': 'application/json', ...extra,
});
const put = (body: unknown, extra: Record<string, string> = {}, qs = '') =>
  app.request(`/trust-page-template${qs}`, { method: 'PUT', headers: H(extra), body: JSON.stringify(body) });

const SETTINGS = { introHtml: null, searchIndexable: null, showPercentages: null, showDeviceCount: null, showManagedBy: false, showHistory: null, hiddenControlIds: null, frameworkView: null };

describe('trust page template routes (W02g)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    partnerRows.rows = [];
    svc.loadPartnerTemplate.mockResolvedValue(null);
    svc.savePartnerTemplate.mockResolvedValue({ ok: true, settings: SETTINGS, revision: 1 });
  });

  describe('GET', () => {
    it('returns no template at revision 0 with the Breeze defaults and framework options', async () => {
      partnerRows.rows.push([{ id: PARTNER, country: 'AU' }]);
      const res = await app.request('/trust-page-template', { headers: H() });
      expect(res.status).toBe(200);
      const body = (await res.json()).data;
      expect(body.template).toBeNull();
      expect(body.revision).toBe(0);
      expect(body.defaults).toMatchObject({ showManagedBy: true, showPercentages: false, searchIndexable: false, frameworkView: ['nist_csf_2'] });
      expect(Array.isArray(body.frameworkOptions)).toBe(true);
      expect(body.canManage).toBe(true);
      expect(svc.loadPartnerTemplate).toHaveBeenCalledWith(PARTNER);
    });

    it('returns the stored template and its revision; a selected-org partner user can read but not manage', async () => {
      partnerRows.rows.push([{ id: PARTNER, country: null }]);
      svc.loadPartnerTemplate.mockResolvedValueOnce({ settings: SETTINGS, revision: 4 });
      const res = await app.request('/trust-page-template', { headers: H({ 'x-org-access': 'selected' }) });
      const body = (await res.json()).data;
      expect(body.template).toEqual(SETTINGS);
      expect(body.revision).toBe(4);
      expect(body.canManage).toBe(false);
    });

    it('system scope must name the partner (?partnerId=)', async () => {
      const res = await app.request('/trust-page-template', { headers: H({ 'x-scope': 'system' }) });
      expect(res.status).toBe(400);
      partnerRows.rows.push([{ id: PARTNER, country: null }]);
      const ok = await app.request(`/trust-page-template?partnerId=${PARTNER}`, { headers: H({ 'x-scope': 'system' }) });
      expect(ok.status).toBe(200);
      expect(svc.loadPartnerTemplate).toHaveBeenCalledWith(PARTNER);
    });

    it('a system-scope ?partnerId= that does not exist is 404', async () => {
      partnerRows.rows.push([]);
      const res = await app.request(`/trust-page-template?partnerId=${PARTNER}`, { headers: H({ 'x-scope': 'system' }) });
      expect(res.status).toBe(404);
    });

    it('an org-scoped token is refused (scope)', async () => {
      const res = await app.request('/trust-page-template', { headers: H({ 'x-scope': 'organization' }) });
      expect(res.status).toBe(403);
      expect(svc.loadPartnerTemplate).not.toHaveBeenCalled();
    });
  });

  describe('PUT', () => {
    it('a first PUT (expectedRevision 0) creates the row at revision 1 and is audited', async () => {
      partnerRows.rows.push([{ id: PARTNER, country: null }]);
      const res = await put({ expectedRevision: 0, showManagedBy: false });
      expect(res.status).toBe(200);
      expect((await res.json()).data).toMatchObject({ template: SETTINGS, revision: 1 });
      expect(svc.savePartnerTemplate).toHaveBeenCalledWith({ partnerId: PARTNER, expectedRevision: 0, patch: { showManagedBy: false }, actorUserId: 'u1', actor: expect.objectContaining({ scope: 'partner', partnerOrgAccess: 'all' }) });
      expect(auditMock).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
        orgId: null, action: 'trust_page_template.update', resourceType: 'trust_page_template', resourceId: PARTNER,
        details: expect.objectContaining({ fields: ['showManagedBy'], revision: 1 }),
      }));
    });

    it('a stale revision is 409 REVISION_MISMATCH and is not audited', async () => {
      partnerRows.rows.push([{ id: PARTNER, country: null }]);
      svc.savePartnerTemplate.mockResolvedValueOnce({ ok: false, reason: 'REVISION_MISMATCH' });
      const res = await put({ expectedRevision: 2, showManagedBy: true });
      expect(res.status).toBe(409);
      expect((await res.json()).code).toBe('REVISION_MISMATCH');
      expect(auditMock).not.toHaveBeenCalled();
    });

    it('a partner user without full org access is 403 PARTNER_WIDE_REQUIRED', async () => {
      const res = await put({ expectedRevision: 0, showManagedBy: false }, { 'x-org-access': 'selected' });
      expect(res.status).toBe(403);
      expect((await res.json()).code).toBe('PARTNER_WIDE_REQUIRED');
      expect(svc.savePartnerTemplate).not.toHaveBeenCalled();
    });

    it('an org-scoped token is refused (scope)', async () => {
      const res = await put({ expectedRevision: 0 }, { 'x-scope': 'organization' });
      expect(res.status).toBe(403);
      expect(svc.savePartnerTemplate).not.toHaveBeenCalled();
    });

    it('requires MFA and the organizations:write permission', async () => {
      expect((await put({ expectedRevision: 0 }, { 'x-mfa': '0' })).status).toBe(403);
      expect((await put({ expectedRevision: 0 }, { 'x-allow': 'organizations:read' })).status).toBe(403);
      expect(svc.savePartnerTemplate).not.toHaveBeenCalled();
    });

    it('sanitizes the intro: script is stripped, HTML that sanitizes to nothing is stored as "" (no intro), null clears', async () => {
      partnerRows.rows.push([{ id: PARTNER, country: null }], [{ id: PARTNER, country: null }], [{ id: PARTNER, country: null }]);
      await put({ expectedRevision: 1, introHtml: '<p>Hello</p><script>alert(1)</script>' });
      const first = svc.savePartnerTemplate.mock.calls[0]![0].patch.introHtml as string;
      expect(first).toContain('Hello');
      expect(first).not.toContain('script');
      await put({ expectedRevision: 1, introHtml: '<script>x</script>' });
      expect(svc.savePartnerTemplate.mock.calls[1]![0].patch).toEqual({ introHtml: '' });
      await put({ expectedRevision: 1, introHtml: null });
      expect(svc.savePartnerTemplate.mock.calls[2]![0].patch).toEqual({ introHtml: null });
    });

    it('rejects org-only fields and a missing expectedRevision (400)', async () => {
      expect((await put({ expectedRevision: 0, ndaText: 'x' })).status).toBe(400);
      expect((await put({ showManagedBy: true })).status).toBe(400);
      expect(svc.savePartnerTemplate).not.toHaveBeenCalled();
    });

    it('system scope writes the named partner', async () => {
      partnerRows.rows.push([{ id: PARTNER, country: null }]);
      const res = await put({ expectedRevision: 0, showHistory: true }, { 'x-scope': 'system' }, `?partnerId=${PARTNER}`);
      expect(res.status).toBe(200);
      expect(svc.savePartnerTemplate).toHaveBeenCalledWith(expect.objectContaining({ partnerId: PARTNER }));
    });
  });
});
