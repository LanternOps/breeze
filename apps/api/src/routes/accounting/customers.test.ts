import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';

const { listAnnotatedMock, importMock, writeRouteAuditMock, QbImportError, authState } = vi.hoisted(() => {
  const listAnnotatedMock = vi.fn();
  const importMock = vi.fn();
  const writeRouteAuditMock = vi.fn();
  class QbImportError extends Error { code: string; status: number; constructor(m: string, c: string, s: number) { super(m); this.code = c; this.status = s; } }
  // The import route creates orgs + default sites and is gated on both write
  // permissions. The list route is read-only, but both routes still require
  // full-partner org access because they enter the partner-wide import seam.
  const authState = {
    scope: 'partner' as 'partner' | 'system',
    partnerOrgAccess: 'all' as 'all' | 'selected' | 'none' | null,
    permissions: new Set<string>(['accounting:read', 'accounting:manage', 'organizations:write', 'sites:write']),
  };
  return { listAnnotatedMock, importMock, writeRouteAuditMock, QbImportError, authState };
});
vi.mock('../../services/accounting/quickbooksCustomerImport', () => ({
  listQuickbooksCustomersAnnotated: listAnnotatedMock,
  importQuickbooksCustomers: importMock,
  QbImportError,
}));

// Auth middleware stubs: inject a partner-scoped auth context.
vi.mock('../../middleware/auth', () => ({
  authMiddleware: async (c: any, next: any) => {
    c.set('auth', {
      scope: authState.scope,
      partnerId: authState.scope === 'system' ? null : 'p1',
      partnerOrgAccess: authState.scope === 'system' ? null : authState.partnerOrgAccess,
      user: { id: 'u1' },
    });
    await next();
  },
  requireScope: () => async (_c: any, next: any) => next(),
  requireMfa: () => async (_c: any, next: any) => next(),
  requirePermission: (resource: string, action: string) => async (c: any, next: any) => {
    if (!authState.permissions.has(`${resource}:${action}`)) return c.json({ error: 'Permission denied' }, 403);
    return next();
  },
}));

vi.mock('../../services/auditEvents', () => ({ writeRouteAudit: writeRouteAuditMock }));

vi.mock('../../config/env', () => ({
  QBO_CLIENT_ID: 'client-id',
  QBO_CLIENT_SECRET: 'client-secret',
  QBO_REDIRECT_URI: 'https://api.example.test/accounting/quickbooks/callback',
  QBO_ENVIRONMENT: 'production',
}));

import { accountingRoutes } from './index';
import { PARTNER_WIDE_WRITE_DENIED_MESSAGE } from '../../services/partnerWideAccess';

function app() {
  const a = new Hono();
  a.route('/accounting', accountingRoutes);
  return a;
}

beforeEach(() => {
  vi.clearAllMocks();
  authState.scope = 'partner';
  authState.partnerOrgAccess = 'all';
  authState.permissions = new Set(['accounting:read', 'accounting:manage', 'organizations:write', 'sites:write']);
});

describe('GET /accounting/:provider/customers', () => {
  it.each(['selected', 'none'] as const)(
    'denies partnerOrgAccess=%s before the partner-wide preview seam',
    async (partnerOrgAccess) => {
      authState.partnerOrgAccess = partnerOrgAccess;

      const res = await app().request('/accounting/quickbooks/customers');

      expect(res.status).toBe(403);
      expect(await res.json()).toEqual({ error: PARTNER_WIDE_WRITE_DENIED_MESSAGE });
      expect(listAnnotatedMock).not.toHaveBeenCalled();
    },
  );

  it('returns annotated customers', async () => {
    listAnnotatedMock.mockResolvedValue([{ id: '1', displayName: 'Acme', alreadyImported: false, organizationId: null }]);
    const res = await app().request('/accounting/quickbooks/customers');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: [{ id: '1', displayName: 'Acme', alreadyImported: false, organizationId: null }] });
    expect(listAnnotatedMock).toHaveBeenCalledWith('p1');
  });

  it('maps QbImportError(not_connected) to 404', async () => {
    listAnnotatedMock.mockRejectedValue(new QbImportError('nope', 'not_connected', 404));
    const res = await app().request('/accounting/quickbooks/customers');
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ code: 'not_connected' });
  });

  it('maps QbImportError(reauth_required) to 409', async () => {
    listAnnotatedMock.mockRejectedValue(new QbImportError('reconnect', 'reauth_required', 409));
    const res = await app().request('/accounting/quickbooks/customers');
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: 'reauth_required' });
  });

  it('maps QbImportError(quickbooks_error) to 502', async () => {
    listAnnotatedMock.mockRejectedValue(new QbImportError('upstream', 'quickbooks_error', 502));
    const res = await app().request('/accounting/quickbooks/customers');
    expect(res.status).toBe(502);
    expect(await res.json()).toMatchObject({ code: 'quickbooks_error' });
  });

  it('denies a partner-scoped caller targeting a different partnerId (403)', async () => {
    const res = await app().request('/accounting/quickbooks/customers?partnerId=99999999-9999-4999-8999-999999999999');
    expect(res.status).toBe(403);
    expect(listAnnotatedMock).not.toHaveBeenCalled();
  });

  it('allows a read-only caller with NO write permissions (listing creates nothing)', async () => {
    // The seeded "Partner Billing" role owns the QuickBooks connection but has
    // no orgs:write — it must still be able to browse customers.
    authState.permissions = new Set(['accounting:read', 'accounting:manage']);
    listAnnotatedMock.mockResolvedValue([]);
    const res = await app().request('/accounting/quickbooks/customers');
    expect(res.status).toBe(200);
    expect(listAnnotatedMock).toHaveBeenCalled();
  });
});

describe('POST /accounting/:provider/customers/import', () => {
  it.each(['selected', 'none'] as const)(
    'denies partnerOrgAccess=%s before the partner-wide commit seam',
    async (partnerOrgAccess) => {
      authState.partnerOrgAccess = partnerOrgAccess;

      const res = await app().request('/accounting/quickbooks/customers/import', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ customerIds: ['1'] }),
      });

      expect(res.status).toBe(403);
      expect(await res.json()).toEqual({ error: PARTNER_WIDE_WRITE_DENIED_MESSAGE });
      expect(importMock).not.toHaveBeenCalled();
    },
  );

  it('imports selected customers and returns the summary', async () => {
    importMock.mockResolvedValue({
      imported: [{ customerId: '1', displayName: 'Acme', organizationId: 'org-1', siteId: 'site-1' }],
      skipped: [], errors: [],
    });
    const res = await app().request('/accounting/quickbooks/customers/import', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ customerIds: ['1'] }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.imported).toHaveLength(1);
    // The actor is forwarded so the seam stamps organization_external_links.created_by.
    expect(importMock).toHaveBeenCalledWith({ partnerId: 'p1', customerIds: ['1'], actor: { userId: 'u1' } });
    // Each created org is audited — guards against the audit loop being dropped.
    expect(writeRouteAuditMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: 'organization.create', resourceId: 'org-1' }),
    );
  });

  it('denies a caller without organizations:write (403) before importing anything', async () => {
    authState.permissions = new Set(['accounting:read', 'accounting:manage', 'sites:write']);
    const res = await app().request('/accounting/quickbooks/customers/import', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ customerIds: ['1'] }),
    });
    expect(res.status).toBe(403);
    expect(importMock).not.toHaveBeenCalled();
  });

  it('denies a caller without sites:write (403) — the import creates a default site', async () => {
    authState.permissions = new Set(['accounting:read', 'accounting:manage', 'organizations:write']);
    const res = await app().request('/accounting/quickbooks/customers/import', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ customerIds: ['1'] }),
    });
    expect(res.status).toBe(403);
    expect(importMock).not.toHaveBeenCalled();
  });

  it('allows a SYSTEM-scope caller that holds no per-partner role', async () => {
    // requirePermission resolves a role from auth.partnerId/orgId, which a
    // system-scope token does not have — without the bypass every system-scope
    // import 403s while requireScope still advertises support for it.
    authState.scope = 'system';
    authState.permissions = new Set(['accounting:read', 'accounting:manage']);
    importMock.mockResolvedValue({ imported: [], skipped: [], errors: [] });
    const res = await app().request('/accounting/quickbooks/customers/import?partnerId=11111111-1111-4111-8111-111111111111', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ customerIds: ['1'] }),
    });
    expect(res.status).toBe(200);
    expect(importMock).toHaveBeenCalledWith(expect.objectContaining({
      partnerId: '11111111-1111-4111-8111-111111111111',
    }));
  });

  it('rejects an empty customerIds array with 400', async () => {
    const res = await app().request('/accounting/quickbooks/customers/import', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ customerIds: [] }),
    });
    expect(res.status).toBe(400);
    expect(importMock).not.toHaveBeenCalled();
  });
});
