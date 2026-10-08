import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';

const { authRef, orgRow, svc, auditSpy, partnerWide } = vi.hoisted(() => ({
  authRef: { current: null as any },
  orgRow: vi.fn(),
  svc: {
    resolveTicketApprovalSettings: vi.fn(),
    updatePartnerTicketApprovalSettings: vi.fn(),
    updateOrgTicketApprovalSettings: vi.fn(),
  },
  auditSpy: vi.fn(),
  partnerWide: vi.fn(),
}));

vi.mock('../../middleware/auth', () => ({
  authMiddleware: vi.fn(async (c: any, next: any) => {
    if (!authRef.current) return c.json({ error: 'Not authenticated' }, 401);
    c.set('auth', authRef.current);
    await next();
  }),
  requireScope: (...scopes: string[]) => async (c: any, next: any) => {
    if (!scopes.includes(c.get('auth').scope)) return c.json({ error: 'Forbidden scope' }, 403);
    await next();
  },
  // Real-shaped gates: deny when the stub auth lacks the named grant / MFA,
  // so a dropped requirePermission(...) or requireMfa() reds a test below.
  requirePermission: (resource: string, action: string) => async (c: any, next: any) => {
    const perms: string[] | undefined = c.get('auth').perms;
    if (perms && !perms.includes(`${resource}:${action}`)) return c.json({ error: 'Permission denied' }, 403);
    await next();
  },
  requireMfa: () => async (c: any, next: any) => {
    if (c.get('auth').mfa === false) return c.json({ error: 'MFA required' }, 403);
    await next();
  },
}));

vi.mock('../../db', () => ({
  db: {
    select: vi.fn(() => ({
      from: vi.fn(() => ({ where: vi.fn(() => ({ limit: vi.fn(async () => orgRow()) })) })),
    })),
  },
}));

vi.mock('../../db/schema', () => ({ organizations: { id: 'id', partnerId: 'partnerId' } }));

vi.mock('../../services/ticketApproval/settings', () => ({
  resolveTicketApprovalSettings: (...a: unknown[]) => svc.resolveTicketApprovalSettings(...a),
  updatePartnerTicketApprovalSettings: (...a: unknown[]) => svc.updatePartnerTicketApprovalSettings(...a),
  updateOrgTicketApprovalSettings: (...a: unknown[]) => svc.updateOrgTicketApprovalSettings(...a),
}));

vi.mock('../../services/partnerWideAccess', () => ({
  canManagePartnerWidePolicies: (...a: unknown[]) => partnerWide(...a),
  PARTNER_WIDE_WRITE_DENIED_MESSAGE: 'partner-wide denied',
}));

vi.mock('../../services/auditEvents', () => ({ writeRouteAudit: (...a: unknown[]) => auditSpy(...a) }));
vi.mock('../../services/auditOrgResolver', () => ({ resolveAuditOrgIdForPartner: async () => null }));

import { ticketApprovalSettingsRoutes } from './approvalSettings';

const ORG_ID = '7c0a1f7e-1111-4222-8333-444455556666';
const EFFECTIVE = {
  enabled: { value: true, source: 'partner' },
  budgetTrigger: { value: true, source: 'default' },
  afterHoursTrigger: { value: true, source: 'default' },
  enforcement: { value: 'soft', source: 'default' },
  requestTtlHours: { value: 72, source: 'default' },
};

function partnerAuth(overrides: Record<string, unknown> = {}) {
  return {
    scope: 'partner',
    user: { id: 'u-1' },
    partnerId: 'p-1',
    orgId: null,
    canAccessOrg: () => true,
    ...overrides,
  };
}

function app() {
  return new Hono().route('/', ticketApprovalSettingsRoutes);
}

function json(method: string, body: unknown) {
  return { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) };
}

beforeEach(() => {
  vi.clearAllMocks();
  authRef.current = partnerAuth();
  partnerWide.mockReturnValue(true);
  orgRow.mockReturnValue([{ partnerId: 'p-1' }]);
  svc.resolveTicketApprovalSettings.mockResolvedValue(EFFECTIVE);
});

describe('partner default: /ticketing/approval-settings', () => {
  it('GET returns the effective settings with sources', async () => {
    const res = await app().request('/ticketing/approval-settings');
    expect(res.status).toBe(200);
    expect((await res.json()).data).toEqual(EFFECTIVE);
    expect(svc.resolveTicketApprovalSettings).toHaveBeenCalledWith(expect.anything(), { partnerId: 'p-1' });
  });

  it('GET is partner-scope only', async () => {
    authRef.current = partnerAuth({ scope: 'organization', orgId: ORG_ID });
    const res = await app().request('/ticketing/approval-settings');
    expect(res.status).toBe(403);
  });

  it('PATCH without partner-wide rights is 403 and writes nothing', async () => {
    partnerWide.mockReturnValue(false);
    const res = await app().request('/ticketing/approval-settings', json('PATCH', { enabled: true }));
    expect(res.status).toBe(403);
    expect(svc.updatePartnerTicketApprovalSettings).not.toHaveBeenCalled();
  });

  it('PATCH upserts, audits and returns the resolved settings', async () => {
    const res = await app().request('/ticketing/approval-settings', json('PATCH', { enabled: true, enforcement: 'hard' }));
    expect(res.status).toBe(200);
    expect(svc.updatePartnerTicketApprovalSettings).toHaveBeenCalledWith(
      expect.anything(), 'p-1', { enabled: true, enforcement: 'hard' });
    expect(auditSpy).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      action: 'partner.ticket_approval_settings.update',
      details: { changedFields: ['enabled', 'enforcement'] },
    }));
    expect((await res.json()).data).toEqual(EFFECTIVE);
  });

  it('PATCH with an unknown key is 400', async () => {
    const res = await app().request('/ticketing/approval-settings', json('PATCH', { budgetMinutes: 60 }));
    expect(res.status).toBe(400);
    expect(svc.updatePartnerTicketApprovalSettings).not.toHaveBeenCalled();
  });

  it('PATCH with null is 400 (the partner row has nothing to inherit from)', async () => {
    const res = await app().request('/ticketing/approval-settings', json('PATCH', { enforcement: null }));
    expect(res.status).toBe(400);
  });
});

describe('gates', () => {
  const ROUTES = [
    { name: 'partner', path: '/ticketing/approval-settings', write: 'PATCH' },
    { name: 'org', path: `/orgs/${ORG_ID}/ticketing/approval-settings`, write: 'PATCH' },
  ];
  for (const r of ROUTES) {
    it(`${r.name} PATCH requires MFA`, async () => {
      authRef.current = partnerAuth({ mfa: false });
      const res = await app().request(r.path, json(r.write, { enabled: true }));
      expect(res.status).toBe(403);
    });
    it(`${r.name} PATCH requires organizations:write`, async () => {
      authRef.current = partnerAuth({ perms: ['organizations:read'] });
      const res = await app().request(r.path, json(r.write, { enabled: true }));
      expect(res.status).toBe(403);
    });
    it(`${r.name} GET requires organizations:read but not write or MFA`, async () => {
      authRef.current = partnerAuth({ perms: ['organizations:read'], mfa: false });
      expect((await app().request(r.path)).status).toBe(200);
      authRef.current = partnerAuth({ perms: [] });
      expect((await app().request(r.path)).status).toBe(403);
    });
    it(`${r.name} PATCH {} is 400 and writes/audits nothing`, async () => {
      const res = await app().request(r.path, json(r.write, {}));
      expect(res.status).toBe(400);
      expect(svc.updatePartnerTicketApprovalSettings).not.toHaveBeenCalled();
      expect(svc.updateOrgTicketApprovalSettings).not.toHaveBeenCalled();
      expect(auditSpy).not.toHaveBeenCalled();
    });
  }

  it('org routes refuse an organization-scope token', async () => {
    authRef.current = partnerAuth({ scope: 'organization', orgId: ORG_ID });
    expect((await app().request(`/orgs/${ORG_ID}/ticketing/approval-settings`)).status).toBe(403);
  });
});

describe('org override: /orgs/:orgId/ticketing/approval-settings', () => {
  it('GET resolves for the org under its partner', async () => {
    const res = await app().request(`/orgs/${ORG_ID}/ticketing/approval-settings`);
    expect(res.status).toBe(200);
    expect(svc.resolveTicketApprovalSettings).toHaveBeenCalledWith(expect.anything(), { partnerId: 'p-1', orgId: ORG_ID });
  });

  it('PATCH { enforcement: null } clears the override', async () => {
    const res = await app().request(`/orgs/${ORG_ID}/ticketing/approval-settings`, json('PATCH', { enforcement: null }));
    expect(res.status).toBe(200);
    expect(svc.updateOrgTicketApprovalSettings).toHaveBeenCalledWith(expect.anything(), ORG_ID, { enforcement: null });
    expect(auditSpy).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      orgId: ORG_ID, action: 'organization.ticket_approval_settings.update',
    }));
  });

  it('PATCH with an unknown key is 400', async () => {
    const res = await app().request(`/orgs/${ORG_ID}/ticketing/approval-settings`, json('PATCH', { partnerId: 'p-2' }));
    expect(res.status).toBe(400);
    expect(svc.updateOrgTicketApprovalSettings).not.toHaveBeenCalled();
  });

  it('an org the caller cannot access is 403', async () => {
    authRef.current = partnerAuth({ canAccessOrg: () => false });
    const res = await app().request(`/orgs/${ORG_ID}/ticketing/approval-settings`, json('PATCH', { enabled: false }));
    expect(res.status).toBe(403);
    expect(svc.updateOrgTicketApprovalSettings).not.toHaveBeenCalled();
  });

  it("another partner's org is 404", async () => {
    orgRow.mockReturnValue([{ partnerId: 'p-2' }]);
    const res = await app().request(`/orgs/${ORG_ID}/ticketing/approval-settings`);
    expect(res.status).toBe(404);
    expect(svc.resolveTicketApprovalSettings).not.toHaveBeenCalled();
  });

  it('a non-uuid org id is 400', async () => {
    const res = await app().request('/orgs/not-a-uuid/ticketing/approval-settings');
    expect(res.status).toBe(400);
  });
});
