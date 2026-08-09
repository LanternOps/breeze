import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';

const { listAnnotatedMock, importMock, writeRouteAuditMock, QbImportError, authState } = vi.hoisted(() => {
  const listAnnotatedMock = vi.fn();
  const importMock = vi.fn();
  const writeRouteAuditMock = vi.fn();
  class QbImportError extends Error { code: string; status: number; constructor(m: string, c: string, s: number) { super(m); this.code = c; this.status = s; } }
  // Both customer routes create orgs + default sites, so both are gated on
  // organizations:write + sites:write.
  const authState = { permissions: new Set<string>(['organizations:write', 'sites:write']) };
  return { listAnnotatedMock, importMock, writeRouteAuditMock, QbImportError, authState };
});
vi.mock('../../services/accounting/quickbooksCustomerImport', () => ({
  listQuickbooksCustomersAnnotated: listAnnotatedMock,
  importQuickbooksCustomers: importMock,
  QbImportError,
}));

// Auth middleware stubs: inject a partner-scoped auth context.
vi.mock('../../middleware/auth', () => ({
  authMiddleware: async (c: any, next: any) => { c.set('auth', { scope: 'partner', partnerId: 'p1', user: { id: 'u1' } }); await next(); },
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

function app() {
  const a = new Hono();
  a.route('/accounting', accountingRoutes);
  return a;
}

beforeEach(() => {
  vi.clearAllMocks();
  authState.permissions = new Set(['organizations:write', 'sites:write']);
});

describe('GET /accounting/:provider/customers', () => {
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

  it('denies a caller without organizations:write (403)', async () => {
    authState.permissions = new Set(['sites:write']);
    const res = await app().request('/accounting/quickbooks/customers');
    expect(res.status).toBe(403);
    expect(listAnnotatedMock).not.toHaveBeenCalled();
  });

  it('denies a caller without sites:write (403)', async () => {
    authState.permissions = new Set(['organizations:write']);
    const res = await app().request('/accounting/quickbooks/customers');
    expect(res.status).toBe(403);
    expect(listAnnotatedMock).not.toHaveBeenCalled();
  });
});

describe('POST /accounting/:provider/customers/import', () => {
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
    authState.permissions = new Set(['sites:write']);
    const res = await app().request('/accounting/quickbooks/customers/import', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ customerIds: ['1'] }),
    });
    expect(res.status).toBe(403);
    expect(importMock).not.toHaveBeenCalled();
  });

  it('denies a caller without sites:write (403) — the import creates a default site', async () => {
    authState.permissions = new Set(['organizations:write']);
    const res = await app().request('/accounting/quickbooks/customers/import', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ customerIds: ['1'] }),
    });
    expect(res.status).toBe(403);
    expect(importMock).not.toHaveBeenCalled();
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
