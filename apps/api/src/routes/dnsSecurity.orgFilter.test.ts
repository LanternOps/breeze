/**
 * #10931 — the DNS Security list and aggregate reads honour the selected org.
 *
 * /dns-security is an `org-or-all` page: with an org picked in the switcher,
 * fetchWithAuth adds `?orgId=<selected>` to every call, and with "All
 * organizations" it adds nothing. The read routes used to ignore `orgId`, so a
 * partner caller saw every org it could reach under the selected org's name, and
 * an orgId outside its reach came back 200 instead of 403.
 *
 * The db is mocked, so these tests check the WHERE clause each read builds,
 * rendered to text over the mocked column names. Real-Postgres coverage, with
 * the rows each org actually gets back, is in
 * __tests__/integration/dnsSecurityOrgFilter.integration.test.ts.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { inArray } from 'drizzle-orm';

const { authState } = vi.hoisted(() => ({
  authState: { auth: null as Record<string, unknown> | null }
}));

vi.mock('../db', () => ({
  runAfterDbContextCommit: vi.fn(),
  runOutsideDbContext: vi.fn((fn) => fn()),
  withDbAccessContext: vi.fn(async (_ctx: unknown, fn: () => Promise<unknown>) => fn()),
  withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
  db: { select: vi.fn(), insert: vi.fn(), update: vi.fn(), delete: vi.fn() }
}));

// Columns are plain strings so a WHERE clause renders to readable text.
vi.mock('../db/schema', () => ({
  devices: { id: 'devices.id', siteId: 'devices.site_id', orgId: 'devices.org_id', hostname: 'devices.hostname' },
  dnsActionEnum: { enumValues: ['allowed', 'blocked', 'redirected'] },
  dnsEventAggregations: {
    orgId: 'dns_event_aggregations.org_id',
    date: 'dns_event_aggregations.date',
    integrationId: 'dns_event_aggregations.integration_id',
    deviceId: 'dns_event_aggregations.device_id',
    domain: 'dns_event_aggregations.domain',
    category: 'dns_event_aggregations.category',
    totalQueries: 'dns_event_aggregations.total_queries',
    blockedQueries: 'dns_event_aggregations.blocked_queries',
    allowedQueries: 'dns_event_aggregations.allowed_queries'
  },
  dnsFilterIntegrations: {
    id: 'dns_filter_integrations.id',
    orgId: 'dns_filter_integrations.org_id',
    isActive: 'dns_filter_integrations.is_active',
    config: 'dns_filter_integrations.config',
    name: 'dns_filter_integrations.name',
    provider: 'dns_filter_integrations.provider',
    createdAt: 'dns_filter_integrations.created_at'
  },
  dnsPolicies: {
    id: 'dns_policies.id',
    orgId: 'dns_policies.org_id',
    integrationId: 'dns_policies.integration_id',
    createdAt: 'dns_policies.created_at'
  },
  dnsProviderEnum: { enumValues: ['umbrella', 'cloudflare', 'pihole', 'adguard_home'] },
  dnsSecurityEvents: {
    id: 'dns_security_events.id',
    orgId: 'dns_security_events.org_id',
    timestamp: 'dns_security_events.timestamp',
    action: 'dns_security_events.action',
    category: 'dns_security_events.category',
    deviceId: 'dns_security_events.device_id',
    integrationId: 'dns_security_events.integration_id',
    domain: 'dns_security_events.domain'
  },
  dnsThreatCategoryEnum: { enumValues: ['malware', 'phishing'] }
}));

vi.mock('../middleware/auth', () => ({
  authMiddleware: vi.fn((c: any, next: any) => {
    c.set('auth', authState.auth);
    return next();
  }),
  requireScope: vi.fn(() => async (_c: any, next: any) => next()),
  requirePermission: vi.fn(() => async (_c: any, next: any) => next()),
  requireMfa: vi.fn(() => async (_c: any, next: any) => next())
}));

vi.mock('../middleware/integrationConnectionScope', () => ({
  requireOrgWideIntegrationAccess: vi.fn(async (_c: any, next: any) => next())
}));
vi.mock('../jobs/dnsSyncJob', () => ({ scheduleDnsEventSync: vi.fn(), schedulePolicySync: vi.fn() }));
vi.mock('../jobs/dnsSecurityRetention', () => ({
  DNS_INTEGRATION_DELETING_STATUS: 'deleting',
  enqueueDnsIntegrationDelete: vi.fn()
}));
vi.mock('../services/auditEvents', () => ({ writeRouteAudit: vi.fn() }));
vi.mock('../services/sentry', () => ({ captureException: vi.fn() }));
vi.mock('../services/secretCrypto', () => ({ encryptSecret: vi.fn() }));
vi.mock('../services/permissions', () => ({
  PERMISSIONS: {
    ORGS_WRITE: { resource: 'organizations', action: 'write' },
    DEVICES_READ: { resource: 'devices', action: 'read' }
  },
  canAccessSite: () => true
}));
vi.mock('../services/dnsSecurityEventsPage', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../services/dnsSecurityEventsPage')>()),
  listDnsSecurityEventsPage: vi.fn()
}));

import { db } from '../db';
import { listDnsSecurityEventsPage } from '../services/dnsSecurityEventsPage';
import { dnsSecurityRoutes } from './dnsSecurity';

const ORG_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const ORG_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const ORG_FOREIGN = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

/** Partner caller who can reach ORG_A and ORG_B (siblings), not ORG_FOREIGN. */
function setPartnerAuth() {
  const reach = [ORG_A, ORG_B];
  authState.auth = {
    scope: 'partner',
    orgId: null,
    partnerId: 'partner-1',
    accessibleOrgIds: reach,
    canAccessOrg: (orgId: string) => reach.includes(orgId),
    orgCondition: (column: any) => inArray(column, reach),
    user: { id: 'user-1', email: 'tech@example.test' }
  };
}

/** Org-scope caller pinned to ORG_A. */
function setOrgAuth() {
  authState.auth = {
    scope: 'organization',
    orgId: ORG_A,
    partnerId: 'partner-1',
    accessibleOrgIds: [ORG_A],
    canAccessOrg: (orgId: string) => orgId === ORG_A,
    orgCondition: (column: any) => inArray(column, [ORG_A]),
    user: { id: 'user-2', email: 'org@example.test' }
  };
}

/** System-scope caller: canAccessOrg is always true and orgCondition adds nothing. */
function setSystemAuth() {
  authState.auth = {
    scope: 'system',
    orgId: null,
    partnerId: null,
    accessibleOrgIds: null,
    canAccessOrg: () => true,
    orgCondition: () => undefined,
    user: { id: 'user-3', email: 'admin@example.test' }
  };
}

/** Render a drizzle SQL tree over the mocked string columns. */
function render(node: unknown): string {
  if (node === null || node === undefined) return '';
  if (typeof node === 'string') return node;
  if (typeof node !== 'object') return String(node);
  if (Array.isArray(node)) return `(${node.map(render).join(', ')})`;
  const n = node as { queryChunks?: unknown[]; value?: unknown };
  if (Array.isArray(n.queryChunks)) return n.queryChunks.map(render).join('');
  if (Array.isArray(n.value)) return n.value.join(''); // StringChunk
  if ('value' in n) return render(n.value); // Param
  return '';
}

const wheres: string[] = [];

/** Every db.select chain resolves to `rows` and records its WHERE clause. */
function mockSelects(rows: unknown[] = []) {
  vi.mocked(db.select).mockImplementation((() => {
    const chain: any = {};
    for (const m of ['from', 'innerJoin', 'leftJoin', 'groupBy', 'orderBy', 'limit']) {
      chain[m] = vi.fn(() => chain);
    }
    chain.where = vi.fn((clause: unknown) => {
      wheres.push(render(clause));
      return chain;
    });
    chain.then = (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) =>
      Promise.resolve(rows).then(resolve, reject);
    return chain;
  }) as any);
}

const EMPTY_PAGE = { rows: [], nextCursor: null, total: 0, totalCapped: false };

// A >7-day window takes the aggregation path on /stats and /top-blocked.
const AGG_WINDOW = 'start=2026-09-01T00:00:00.000Z&end=2026-09-20T00:00:00.000Z';

// path → the org column every WHERE it runs must name.
const ROUTES: Array<{ name: string; path: string; columns: string[] }> = [
  { name: 'GET /integrations', path: '/integrations', columns: ['dns_filter_integrations.org_id'] },
  { name: 'GET /policies', path: '/policies', columns: ['dns_policies.org_id'] },
  { name: 'GET /stats (raw)', path: '/stats', columns: ['dns_security_events.org_id', 'dns_filter_integrations.org_id'] },
  {
    name: 'GET /stats (aggregated)',
    path: `/stats?${AGG_WINDOW}`,
    columns: ['dns_event_aggregations.org_id', 'dns_filter_integrations.org_id']
  },
  { name: 'GET /top-blocked (raw)', path: '/top-blocked', columns: ['dns_security_events.org_id'] },
  { name: 'GET /top-blocked (aggregated)', path: `/top-blocked?${AGG_WINDOW}`, columns: ['dns_event_aggregations.org_id'] }
];

function withOrg(path: string, orgId: string): string {
  return `${path}${path.includes('?') ? '&' : '?'}orgId=${orgId}`;
}

/** WHERE clauses that mention one of `columns` (skips e.g. a device lookup). */
function orgWheres(columns: string[]): string[] {
  return wheres.filter((w) => columns.some((col) => w.includes(col)));
}

describe('DNS Security reads honour the selected org (#10931)', () => {
  let app: Hono;

  beforeEach(() => {
    vi.clearAllMocks();
    wheres.length = 0;
    // count: 1 sends /stats and /top-blocked down the aggregation path when the window allows it.
    mockSelects([{ count: 1, totalQueries: 0, blockedQueries: 0, allowedQueries: 0 }]);
    vi.mocked(listDnsSecurityEventsPage).mockResolvedValue(EMPTY_PAGE);
    app = new Hono();
    app.route('/dns-security', dnsSecurityRoutes);
  });

  describe('GET /events', () => {
    function eventsWhere(): string {
      return render(vi.mocked(listDnsSecurityEventsPage).mock.calls[0]![0].where);
    }

    it('narrows a partner caller to the selected org', async () => {
      setPartnerAuth();
      const res = await app.request(`/dns-security/events?orgId=${ORG_A}`);
      expect(res.status).toBe(200);
      expect(eventsWhere()).toContain(`dns_security_events.org_id = ${ORG_A}`);
      expect(eventsWhere()).not.toContain(`dns_security_events.org_id = ${ORG_B}`);
    });

    it('narrows a partner caller to the sibling org when that one is selected', async () => {
      setPartnerAuth();
      const res = await app.request(`/dns-security/events?orgId=${ORG_B}`);
      expect(res.status).toBe(200);
      expect(eventsWhere()).toContain(`dns_security_events.org_id = ${ORG_B}`);
      expect(eventsWhere()).not.toContain(`dns_security_events.org_id = ${ORG_A}`);
    });

    it('keeps the caller reach ANDed in, so the selection only narrows', async () => {
      setPartnerAuth();
      await app.request(`/dns-security/events?orgId=${ORG_A}`);
      expect(eventsWhere()).toContain(`dns_security_events.org_id in (${ORG_A}, ${ORG_B})`);
    });

    it('refuses a foreign partner org with 403 before querying', async () => {
      setPartnerAuth();
      const res = await app.request(`/dns-security/events?orgId=${ORG_FOREIGN}`);
      expect(res.status).toBe(403);
      expect((await res.json()).error).toBe('Access to this organization denied');
      expect(listDnsSecurityEventsPage).not.toHaveBeenCalled();
    });

    it('refuses an org-scope caller asking for another org', async () => {
      setOrgAuth();
      const res = await app.request(`/dns-security/events?orgId=${ORG_B}`);
      expect(res.status).toBe(403);
      expect(listDnsSecurityEventsPage).not.toHaveBeenCalled();
    });

    it('rejects a malformed orgId with 400', async () => {
      setPartnerAuth();
      const res = await app.request('/dns-security/events?orgId=not-a-uuid');
      expect(res.status).toBe(400);
      expect(listDnsSecurityEventsPage).not.toHaveBeenCalled();
    });

    it('keeps the full reach when no orgId is sent (All organizations)', async () => {
      setPartnerAuth();
      const res = await app.request('/dns-security/events');
      expect(res.status).toBe(200);
      expect(eventsWhere()).toContain(`dns_security_events.org_id in (${ORG_A}, ${ORG_B})`);
      expect(eventsWhere()).not.toContain('dns_security_events.org_id = ');
    });
  });

  describe.each(ROUTES)('$name', ({ path, columns }) => {
    it('narrows every org-scoped query to the selected org', async () => {
      setPartnerAuth();
      const res = await app.request(`/dns-security${withOrg(path, ORG_B)}`);
      expect(res.status).toBe(200);
      const scoped = orgWheres(columns);
      for (const col of columns) {
        expect(scoped.some((w) => w.includes(col)), `no query filtered on ${col}`).toBe(true);
      }
      for (const w of scoped) {
        expect(w).toMatch(new RegExp(`\\.org_id = ${ORG_B}`));
        expect(w).not.toMatch(new RegExp(`\\.org_id = ${ORG_A}`));
      }
    });

    it('refuses a foreign partner org with 403 before querying', async () => {
      setPartnerAuth();
      const res = await app.request(`/dns-security${withOrg(path, ORG_FOREIGN)}`);
      expect(res.status).toBe(403);
      expect(db.select).not.toHaveBeenCalled();
    });

    it('refuses an org-scope caller asking for another org', async () => {
      setOrgAuth();
      const res = await app.request(`/dns-security${withOrg(path, ORG_B)}`);
      expect(res.status).toBe(403);
      expect(db.select).not.toHaveBeenCalled();
    });

    it('lets an org-scope caller name its own org', async () => {
      setOrgAuth();
      const res = await app.request(`/dns-security${withOrg(path, ORG_A)}`);
      expect(res.status).toBe(200);
    });

    it('rejects a malformed orgId with 400 before querying', async () => {
      setPartnerAuth();
      const res = await app.request(`/dns-security${withOrg(path, 'not-a-uuid')}`);
      expect(res.status).toBe(400);
      expect(db.select).not.toHaveBeenCalled();
    });

    it('narrows a system-scope caller to the selected org', async () => {
      setSystemAuth();
      const res = await app.request(`/dns-security${withOrg(path, ORG_B)}`);
      expect(res.status).toBe(200);
      const scoped = orgWheres(columns);
      for (const col of columns) {
        expect(scoped.some((w) => w.includes(col)), `no query filtered on ${col}`).toBe(true);
      }
      for (const w of scoped) expect(w).toMatch(new RegExp(`\\.org_id = ${ORG_B}`));
    });

    it('leaves a system-scope caller unfiltered by org when no orgId is sent', async () => {
      setSystemAuth();
      const res = await app.request(`/dns-security${path}`);
      expect(res.status).toBe(200);
      expect(wheres.some((w) => w.includes('.org_id'))).toBe(false);
    });

    it('keeps the full reach when no orgId is sent (All organizations)', async () => {
      setPartnerAuth();
      const res = await app.request(`/dns-security${path}`);
      expect(res.status).toBe(200);
      const scoped = orgWheres(columns);
      expect(scoped.length).toBeGreaterThan(0);
      for (const w of scoped) {
        expect(w).toContain(`.org_id in (${ORG_A}, ${ORG_B})`);
        expect(w).not.toContain('.org_id = ');
      }
    });
  });
});
