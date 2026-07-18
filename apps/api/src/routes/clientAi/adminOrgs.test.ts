import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';

const { dbSelectMock, orgConditionMock } = vi.hoisted(() => ({
  dbSelectMock: vi.fn(),
  orgConditionMock: vi.fn(() => ({ __scope: 'caller-orgs' })),
}));

vi.mock('../../middleware/auth', () => ({
  authMiddleware: vi.fn((c: any, next: any) => {
    if (!c.req.header('authorization')) return c.json({ error: 'Unauthorized' }, 401);
    c.set('auth', {
      scope: 'partner',
      partnerId: 'f0f0f0f0-1111-4222-8333-444455556666',
      orgId: null,
      accessibleOrgIds: ['0c0c0c0c-1111-4222-8333-444455556666'],
      orgCondition: orgConditionMock,
      user: { id: 'ce11ce11-1111-4222-8333-444455556666', email: 'msp@example.com' },
    });
    return next();
  }),
  requirePermission: vi.fn(() => (c: any, next: any) => next()),
  requireMfa: vi.fn(() => (c: any, next: any) => next()),
}));

vi.mock('../../config/env', () => ({
  CLIENT_AI_ENTRA_CLIENT_ID: '00000000-aaaa-bbbb-cccc-000000000001',
}));

vi.mock('../../db', () => ({ db: { select: dbSelectMock } }));
vi.mock('drizzle-orm', async (importOriginal) => {
  const actual = await importOriginal<typeof import('drizzle-orm')>();
  return { ...actual, eq: vi.fn(actual.eq) };
});

import {
  clientAiAdminOrgRoutes,
  clientAiConsentCallbackRoute,
  buildClientAiConsentUrl,
  getClientAiConsentRedirectUri,
  currentMonthKey,
} from './adminOrgs';
import { authMiddleware } from '../../middleware/auth';
import { eq } from 'drizzle-orm';
import { m365Connections } from '../../db/schema/m365';

const ORG_ID = '0c0c0c0c-1111-4222-8333-444455556666';
const OTHER_ORG_ID = '9d9d9d9d-1111-4222-8333-444455556666';
const TID = '6f4f4f4f-1111-4222-8333-444455556666';

/** Flexible thenable Drizzle chain: awaitable after any builder method. */
function chain(rows: unknown[]) {
  const c: Record<string, unknown> = {};
  const self = vi.fn(() => c);
  for (const m of ['from', 'where', 'orderBy', 'groupBy', 'leftJoin', 'limit', 'offset']) {
    c[m] = self;
  }
  c.then = (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) =>
    Promise.resolve(rows).then(resolve, reject);
  return c;
}

/** GET /orgs issues 7 selects in a fixed order (see route comment). */
function setupOrgListDb(overrides: Partial<Record<number, unknown[]>> = {}) {
  const defaults: unknown[][] = [
    /* 1 orgs        */ [{ id: ORG_ID, name: 'Contoso Accounting' }],
    /* 2 mappings    */ [{ orgId: ORG_ID, entraTenantId: TID }],
    /* 3 policies    */ [{ orgId: ORG_ID, enabled: true }],
    /* 4 entra users */ [{ orgId: ORG_ID, n: 3 }],
    /* 5 usage       */ [{ orgId: ORG_ID, costCents: '1234.5', messages: '87' }],
    /* 6 m365        */ [{ orgId: ORG_ID, tenantId: TID }],
    /* 7 delegant    */ [],
  ];
  let call = 0;
  dbSelectMock.mockImplementation(() => {
    call++;
    return chain((overrides[call] as unknown[]) ?? defaults[call - 1] ?? []);
  });
}

function buildApp() {
  const app = new Hono();
  app.use('*', authMiddleware as never);
  app.route('/client-ai/admin', clientAiAdminOrgRoutes);
  return app;
}

const AUTHED = { Authorization: 'Bearer token' };

beforeEach(() => {
  vi.clearAllMocks();
});

describe('GET /client-ai/admin/orgs', () => {
  it('rejects unauthenticated requests', async () => {
    const res = await buildApp().request('/client-ai/admin/orgs');
    expect(res.status).toBe(401);
  });

  it('returns the merged per-org status row', async () => {
    setupOrgListDb();
    const res = await buildApp().request('/client-ai/admin/orgs', { headers: AUTHED });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data).toHaveLength(1);
    expect(body.data[0]).toMatchObject({
      orgId: ORG_ID,
      orgName: 'Contoso Accounting',
      mapped: true,
      entraTenantId: TID,
      suggestedEntraTenantId: TID,
      consentStatus: 'granted',
      policyEnabled: true,
      currentMonthCostCents: 1234.5,
      currentMonthMessages: 87,
    });
  });

  it('scopes the org list to the caller at the app layer (defense-in-depth vs cross-partner IDOR)', async () => {
    setupOrgListDb();
    const res = await buildApp().request('/client-ai/admin/orgs', { headers: AUTHED });
    expect(res.status).toBe(200);
    // The /orgs list MUST restrict to the caller's accessible orgs at the app layer
    // (agreeing with forced RLS, not relying on it alone) — proven by the org-status
    // select invoking auth.orgCondition(organizations.id). Removing the .where(...)
    // scope filter would fail this and regress the cross-partner org-list exposure.
    expect(orgConditionMock).toHaveBeenCalled();
  });

  it("derives consentStatus 'unknown' when unmapped and 'pending' when mapped without entra users", async () => {
    setupOrgListDb({ 2: [], 4: [] }); // no mapping, no entra users
    let res = await buildApp().request('/client-ai/admin/orgs', { headers: AUTHED });
    expect((await res.json()).data[0].consentStatus).toBe('unknown');

    setupOrgListDb({ 4: [] }); // mapped, no entra users
    res = await buildApp().request('/client-ai/admin/orgs', { headers: AUTHED });
    const row = (await res.json()).data[0];
    expect(row.consentStatus).toBe('pending');
    expect(row.mapped).toBe(true);
  });

  it('honors the orgId filter param (fetchWithAuth auto-injection tolerance)', async () => {
    setupOrgListDb({
      1: [
        { id: ORG_ID, name: 'Contoso Accounting' },
        { id: OTHER_ORG_ID, name: 'Fabrikam' },
      ],
    });
    const res = await buildApp().request(`/client-ai/admin/orgs?orgId=${ORG_ID}`, {
      headers: AUTHED,
    });
    const body = await res.json();
    expect(body.data).toHaveLength(1);
    expect(body.data[0].orgId).toBe(ORG_ID);
  });

  it('suggests the delegant tenant when no m365 connection exists, GUIDs only', async () => {
    setupOrgListDb({
      2: [],
      4: [],
      6: [],
      7: [
        { orgId: ORG_ID, tenantId: 'contoso.onmicrosoft.com' }, // non-GUID — skipped
        { orgId: ORG_ID, tenantId: TID },
      ],
    });
    const res = await buildApp().request('/client-ai/admin/orgs', { headers: AUTHED });
    expect((await res.json()).data[0].suggestedEntraTenantId).toBe(TID);
  });

  it('uses only legacy-direct rows for the transitional M365 tenant suggestion', async () => {
    setupOrgListDb();
    const res = await buildApp().request('/client-ai/admin/orgs', { headers: AUTHED });
    expect(res.status).toBe(200);
    expect(eq).toHaveBeenCalledWith(m365Connections.profile, 'legacy-direct');
  });

  it('ignores a legacy-direct row whose tenant id is null', async () => {
    setupOrgListDb({ 2: [], 4: [], 6: [{ orgId: ORG_ID, tenantId: null }] });
    const res = await buildApp().request('/client-ai/admin/orgs', { headers: AUTHED });
    expect(res.status).toBe(200);
    expect((await res.json()).data[0].suggestedEntraTenantId).toBeNull();
  });
});

describe('GET /client-ai/admin/orgs/:orgId/consent-url', () => {
  it('404s for an org outside the caller scope', async () => {
    dbSelectMock.mockImplementation(() => chain([]));
    const res = await buildApp().request(
      `/client-ai/admin/orgs/${OTHER_ORG_ID}/consent-url`,
      { headers: AUTHED }
    );
    expect(res.status).toBe(404);
  });

  it('builds a tenant-pinned URL when a mapping exists', async () => {
    dbSelectMock.mockImplementation(() => chain([{ orgId: ORG_ID, entraTenantId: TID }]));
    const res = await buildApp().request(`/client-ai/admin/orgs/${ORG_ID}/consent-url`, {
      headers: AUTHED,
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    const url = new URL(body.url);
    expect(url.pathname).toBe(`/${TID}/adminconsent`);
    expect(url.searchParams.get('client_id')).toBe('00000000-aaaa-bbbb-cccc-000000000001');
    expect(url.searchParams.get('redirect_uri')).toContain('/api/v1/client-ai/consent/callback');
  });

  it("falls back to the 'organizations' segment when unmapped", async () => {
    dbSelectMock.mockImplementation(() => chain([]));
    const res = await buildApp().request(`/client-ai/admin/orgs/${ORG_ID}/consent-url`, {
      headers: AUTHED,
    });
    const body = await res.json();
    expect(new URL(body.url).pathname).toBe('/organizations/adminconsent');
  });
});

describe('GET /client-ai/admin/orgs/:orgId/users', () => {
  it('lists the entra portal users of the org', async () => {
    dbSelectMock.mockImplementation(() =>
      chain([
        { id: 'beefbeef-1111-4222-8333-444455556666', email: 'a@contoso.com', name: 'A', lastLoginAt: null },
      ])
    );
    const res = await buildApp().request(`/client-ai/admin/orgs/${ORG_ID}/users`, {
      headers: AUTHED,
    });
    expect(res.status).toBe(200);
    expect((await res.json()).data[0].email).toBe('a@contoso.com');
  });

  it('404s outside the caller scope', async () => {
    const res = await buildApp().request(`/client-ai/admin/orgs/${OTHER_ORG_ID}/users`, {
      headers: AUTHED,
    });
    expect(res.status).toBe(404);
  });
});

describe('GET /client-ai/consent/callback (public)', () => {
  function callbackApp() {
    const app = new Hono();
    app.route('/client-ai', clientAiConsentCallbackRoute);
    return app;
  }

  it('renders the success page when admin_consent=True', async () => {
    const res = await callbackApp().request(
      `/client-ai/consent/callback?admin_consent=True&tenant=${TID}`
    );
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('Consent granted');
  });

  it('renders the failure page (escaped) otherwise', async () => {
    const res = await callbackApp().request(
      '/client-ai/consent/callback?error=access_denied&error_description=<script>alert(1)</script>'
    );
    expect(res.status).toBe(400);
    const html = await res.text();
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;');
  });
});

describe('helpers', () => {
  it('currentMonthKey is YYYY-MM (UTC)', () => {
    expect(currentMonthKey(new Date('2026-06-12T10:00:00Z'))).toBe('2026-06');
    expect(currentMonthKey(new Date('2026-01-01T00:30:00Z'))).toBe('2026-01');
  });
  it('buildClientAiConsentUrl encodes the redirect uri', () => {
    const url = buildClientAiConsentUrl({ clientId: 'cid', entraTenantId: null });
    expect(url).toContain('organizations/adminconsent');
    expect(url).toContain(encodeURIComponent(getClientAiConsentRedirectUri()));
  });
});
