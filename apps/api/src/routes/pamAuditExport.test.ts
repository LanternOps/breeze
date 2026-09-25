import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

const mocks = vi.hoisted(() => ({
  requirePermission: vi.fn((_resource: string, _action: string) => async (_c: unknown, next: () => Promise<void>) => next()),
  requireMfa: vi.fn(() => async (_c: unknown, next: () => Promise<void>) => next()),
  fetchPage: vi.fn(),
  writeRouteAudit: vi.fn(),
}));

vi.mock('../middleware/auth', () => ({
  requirePermission: mocks.requirePermission,
  requireMfa: mocks.requireMfa,
}));
vi.mock('../services/auditEvents', () => ({ writeRouteAudit: mocks.writeRouteAudit }));
vi.mock('../services/pamAuditExport', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../services/pamAuditExport')>();
  return { ...actual, fetchElevationAuditExportPage: mocks.fetchPage };
});

import { pamAuditExportRoutes } from './pamAuditExport';
import { encodeExportCursor } from '../services/pamAuditExport';

// Captured at import: the permission gates are built when the module loads,
// and beforeEach clears call history.
const PERMISSION_GATES = mocks.requirePermission.mock.calls.map(([r, a]) => `${r}:${a}`);
const MFA_GATES = mocks.requireMfa.mock.calls.length;

const ORG = '11111111-1111-4111-8111-111111111111';
const OTHER_ORG = '22222222-2222-4222-8222-222222222222';
const SITE = '33333333-3333-4333-8333-333333333333';
const REQ_ID = '44444444-4444-4444-8444-444444444444';

function app(opts: { allowedSiteIds?: string[] } = {}) {
  const a = new Hono();
  a.use('*', async (c, next) => {
    c.set('auth', {
      scope: 'organization',
      orgId: ORG,
      canAccessOrg: (id: string) => id === ORG,
      orgCondition: () => undefined,
      user: { id: 'u1' },
    } as never);
    if (opts.allowedSiteIds) c.set('permissions', { allowedSiteIds: opts.allowedSiteIds } as never);
    await next();
  });
  a.route('/pam', pamAuditExportRoutes);
  return a;
}

const Q = 'from=2026-09-01T00:00:00Z&to=2026-09-25T00:00:00Z';

beforeEach(() => {
  vi.clearAllMocks();
  mocks.fetchPage.mockResolvedValue({ records: [], hasMore: false, nextCursor: '' });
});

describe('GET /pam/elevation-audit/export (#4910)', () => {
  it('requires devices:read AND audit:export, plus MFA', () => {
    expect(PERMISSION_GATES).toEqual(expect.arrayContaining(['devices:read', 'audit:export']));
    expect(MFA_GATES).toBeGreaterThan(0);
  });

  it('403s an orgId the caller cannot access, before querying', async () => {
    const res = await app().request(`/pam/elevation-audit/export?${Q}&orgId=${OTHER_ORG}`);
    expect(res.status).toBe(403);
    expect(mocks.fetchPage).not.toHaveBeenCalled();
  });

  it('403s a siteId outside a site-restricted caller, before querying', async () => {
    const res = await app({ allowedSiteIds: ['55555555-5555-4555-8555-555555555555'] })
      .request(`/pam/elevation-audit/export?${Q}&siteId=${SITE}`);
    expect(res.status).toBe(403);
    expect(mocks.fetchPage).not.toHaveBeenCalled();
  });

  it('400s a malformed cursor', async () => {
    const res = await app().request(`/pam/elevation-audit/export?${Q}&cursor=not-a-cursor`);
    expect(res.status).toBe(400);
    expect(mocks.fetchPage).not.toHaveBeenCalled();
  });

  it('passes the decoded cursor, site allowlist and filters through, and returns CSV with paging headers', async () => {
    mocks.fetchPage.mockResolvedValue({ records: [], hasMore: true, nextCursor: 'NEXT' });
    const cursor = encodeExportCursor('2026-09-10 12:00:00.000001+00', REQ_ID);
    const res = await app({ allowedSiteIds: [SITE] })
      .request(`/pam/elevation-audit/export?${Q}&limit=50&eventType=approved&cursor=${cursor}`);

    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/csv');
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(res.headers.get('x-next-cursor')).toBe('NEXT');
    expect(res.headers.get('x-row-count')).toBe('0');
    const input = mocks.fetchPage.mock.calls[0]![0];
    expect(input).toMatchObject({
      allowedSiteIds: [SITE],
      after: { occurredAt: '2026-09-10 12:00:00.000001+00', id: REQ_ID },
      limit: 50,
      filters: { eventType: 'approved' },
    });
    expect(input.filters.from.toISOString()).toBe('2026-09-01T00:00:00.000Z');
  });

  it('audits every page it generates, without the row contents', async () => {
    const res = await app().request(`/pam/elevation-audit/export?${Q}&format=jsonl`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('application/x-ndjson');
    expect(mocks.writeRouteAudit).toHaveBeenCalledTimes(1);
    const event = mocks.writeRouteAudit.mock.calls[0]![1];
    expect(event).toMatchObject({
      orgId: ORG,
      action: 'pam.elevation_audit.export',
      resourceType: 'elevation_audit',
      details: { format: 'jsonl', rowCount: 0, hasMore: false, continuation: false },
    });
    expect(event.details).not.toHaveProperty('records');
  });

  it('rejects a window over 366 days with 400', async () => {
    const res = await app().request('/pam/elevation-audit/export?from=2025-01-01T00:00:00Z&to=2026-09-25T00:00:00Z');
    expect(res.status).toBe(400);
  });
});
