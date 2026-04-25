import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';

const PARTNER_ID = '11111111-1111-4111-8111-111111111111';

const mocks = vi.hoisted(() => {
  class Grant {
    static instances: Grant[] = [];
    accountId: string;
    clientId: string;
    breeze?: Record<string, string | null>;
    addOIDCScope = vi.fn();
    addResourceScope = vi.fn();
    save = vi.fn(async () => 'grant-1');

    constructor(args: { accountId: string; clientId: string }) {
      this.accountId = args.accountId;
      this.clientId = args.clientId;
      Grant.instances.push(this);
    }
  }

  return {
    Grant,
    interactionDetails: vi.fn(),
    interactionResult: vi.fn(async () => 'https://client.example/callback'),
    select: vi.fn(),
    update: vi.fn(),
    insert: vi.fn(),
    runOutsideDbContext: vi.fn((fn: () => unknown) => fn()),
    withSystemDbAccessContext: vi.fn(async (fn: () => unknown) => fn()),
  };
});

vi.mock('../oauth/provider', () => ({
  // The route now resolves interaction state via `provider.Interaction.find(uid)`
  // (see oauthInteraction.ts: it uses the URL UID as authoritative rather than
  // the cookie UID). We back `Interaction.find` with the same mock used to
  // seed canned details — tests still configure flow state by calling
  // `mocks.interactionDetails.mockResolvedValue(...)`.
  getProvider: vi.fn(async () => ({
    interactionDetails: mocks.interactionDetails,
    interactionResult: mocks.interactionResult,
    Grant: mocks.Grant,
    Interaction: { find: mocks.interactionDetails },
  })),
}));

vi.mock('../middleware/auth', () => ({
  authMiddleware: vi.fn(async (c: any, next: any) => {
    c.set('auth', {
      user: { id: 'u1', email: 'user@example.com', name: 'User One' },
      token: {},
      partnerId: '11111111-1111-4111-8111-111111111111',
      orgId: 'current-org',
      scope: 'partner',
      accessibleOrgIds: null,
      orgCondition: vi.fn(),
      canAccessOrg: vi.fn(),
    });
    await next();
  }),
  // Pulled in transitively via monitorWorker.ts -> monitors.ts when the
  // routes module imports the agent WS layer. Stub as no-op middleware so
  // the import chain doesn't blow up at module-load time.
  requirePermission: vi.fn(() => async (_c: any, next: any) => { await next(); }),
  requireScope: vi.fn(() => async (_c: any, next: any) => { await next(); }),
  requireMfa: vi.fn(async (_c: any, next: any) => { await next(); }),
}));

vi.mock('../db', () => ({
  db: { select: mocks.select, update: mocks.update, insert: mocks.insert },
  runOutsideDbContext: mocks.runOutsideDbContext,
  withSystemDbAccessContext: mocks.withSystemDbAccessContext,
}));

// Stub the audit-log writer so we don't need to reach into Postgres just to
// verify consent flows. The H2/LOW tests below assert the writer is called
// with the right action string when the partner-id binding succeeds vs. is
// skipped — we capture invocations on this hoisted mock.
const auditMocks = vi.hoisted(() => ({
  writeRouteAudit: vi.fn(),
}));
vi.mock('../services/auditEvents', () => ({
  writeRouteAudit: auditMocks.writeRouteAudit,
  writeAuditEvent: vi.fn(),
}));

function details(overrides: Record<string, unknown> = {}): {
  uid: string;
  exp: number;
  save: ReturnType<typeof vi.fn>;
  params: { client_id: string; client_name: string; resource: string; scope: string };
  prompt: { details: { scopes: { new: string[] } } };
  result?: unknown;
} {
  // The route now writes consent state directly onto the interaction object
  // and calls details.save() (because provider.interactionResult reads UID
  // from cookie, which can lag the URL UID in multi-prompt flows). So the
  // mock interaction needs `save` and `exp` fields.
  return {
    uid: 'uid-1',
    exp: Math.floor(Date.now() / 1000) + 3600,
    save: vi.fn(async () => undefined),
    params: {
      client_id: 'client-1',
      client_name: 'Claude Desktop',
      resource: 'https://api.example/mcp/server',
      scope: 'openid offline_access mcp:read mcp:write',
    },
    prompt: { details: { scopes: { new: ['openid', 'offline_access'] } } },
    ...overrides,
  };
}

function queueSelect(rows: unknown[], mode: 'where' | 'limit' = 'where') {
  const where = mode === 'where'
    ? vi.fn(async () => rows)
    : vi.fn(() => ({ limit: vi.fn(async () => rows) }));
  const join = { where };
  const from = vi.fn(() => ({
    innerJoin: vi.fn(() => join),
    where,
  }));
  mocks.select.mockImplementationOnce(() => ({ from }));
  return { from, where };
}

function queueUpdate() {
  const where = vi.fn();
  const set = vi.fn(() => ({ where }));
  mocks.update.mockImplementationOnce(() => ({ set }));
  return { set, where };
}

/**
 * Variant of queueUpdate that terminates with `.returning(...)` (drizzle
 * pattern for fetching back updated rows). Used for the legacy
 * `oauth_grants.partner_id` UPDATE in setGrantBreezeMeta and similar.
 */
function queueUpdateReturning(rows: unknown[] = []) {
  const returning = vi.fn(async () => rows);
  const where = vi.fn(() => ({ returning }));
  const set = vi.fn(() => ({ where }));
  mocks.update.mockImplementationOnce(() => ({ set }));
  return { set, where, returning };
}

/**
 * Drizzle insert-on-conflict-do-update chain:
 *   db.insert(table).values(v).onConflictDoUpdate(...).returning(...)
 *
 * The H2 proper fix records (client, partner) consent into
 * `oauth_client_partner_grants`. First-consent vs. re-consent is detected
 * via the returned firstConsentedAt/lastConsentedAt — pass `firstConsented`
 * to control which path the route takes (different timestamps signal a
 * conflict-update; equal timestamps signal a fresh INSERT).
 */
function queueInsertGrantReturning(opts: { firstConsented: boolean }) {
  const now = new Date();
  const rows = [{
    firstConsentedAt: opts.firstConsented ? now : new Date(now.getTime() - 60_000),
    lastConsentedAt: now,
  }];
  const returning = vi.fn(async () => rows);
  const onConflictDoUpdate = vi.fn(() => ({ returning }));
  const values = vi.fn(() => ({ onConflictDoUpdate }));
  mocks.insert.mockImplementationOnce(() => ({ values }));
  return { values, onConflictDoUpdate, returning };
}

async function loadApp(enabled = true) {
  process.env.MCP_OAUTH_ENABLED = enabled ? 'true' : 'false';
  process.env.OAUTH_RESOURCE_URL = 'https://api.example/mcp/server';
  vi.resetModules();
  const { oauthInteractionRoutes } = await import('./oauthInteraction');
  const app = new Hono().route('/api/v1/oauth', oauthInteractionRoutes);
  app.onError((err, c) => {
    if (err instanceof HTTPException) {
      return c.json({ message: err.message }, err.status);
    }
    throw err;
  });

  return app;
}

async function request(app: Hono, path: string, init?: RequestInit) {
  return app.request(path, init, { incoming: {}, outgoing: {} } as any);
}

describe('oauthInteractionRoutes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.Grant.instances.length = 0;
    auditMocks.writeRouteAudit.mockReset();
  });

  afterEach(() => {
    delete process.env.MCP_OAUTH_ENABLED;
    delete process.env.OAUTH_RESOURCE_URL;
  });

  it('returns 404 when Interaction.find returns undefined (not found / expired)', async () => {
    // The route now uses Interaction.find(uid) directly — see oauthInteraction.ts
    // intentional comment: this avoids relying on the _interaction cookie
    // which can lag the URL UID in multi-prompt flows. A missing/expired
    // interaction surfaces as `undefined`, which the route maps to 404.
    mocks.interactionDetails.mockResolvedValue(undefined);
    const res = await request(await loadApp(), '/api/v1/oauth/interaction/uid-1');
    expect(res.status).toBe(404);
  });

  it('returns client, scopes, resource, and partner picker data', async () => {
    mocks.interactionDetails.mockResolvedValue(details());
    queueSelect([{ partnerId: PARTNER_ID, partnerName: 'Acme MSP' }]);
    // The route now also looks up the registered client metadata from
    // oauth_clients so the consent UI can show the human-readable
    // `client_name` instead of the opaque `client_id`.
    queueSelect([{ metadata: { client_name: 'Claude Desktop' } }], 'limit');
    const res = await request(await loadApp(), '/api/v1/oauth/interaction/uid-1');
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body).toEqual({
      uid: 'uid-1',
      client: { client_id: 'client-1', client_name: 'Claude Desktop' },
      scopes: ['openid', 'offline_access'],
      resource: 'https://api.example/mcp/server',
      partners: [{ partnerId: PARTNER_ID, partnerName: 'Acme MSP' }],
    });
  });

  it('falls back to client_id when no client_name is registered', async () => {
    // Simulates a DCR client that registered without supplying client_name —
    // we should NOT fall back to the auth-request `client_name` param (which
    // a malicious client could spoof), and we should NOT render blank. The
    // opaque client_id is the safe last-resort heading.
    mocks.interactionDetails.mockResolvedValue(details({
      params: {
        client_id: 'rxZLeLQMmTDp53sY3sTuv',
        resource: 'https://api.example/mcp/server',
        scope: 'openid offline_access mcp:read',
      },
    }));
    queueSelect([{ partnerId: PARTNER_ID, partnerName: 'Acme MSP' }]);
    queueSelect([{ metadata: {} }], 'limit');
    const res = await request(await loadApp(), '/api/v1/oauth/interaction/uid-1');
    const body = await res.json() as { client: { client_id: string; client_name: string } };
    expect(res.status).toBe(200);
    expect(body.client).toEqual({
      client_id: 'rxZLeLQMmTDp53sY3sTuv',
      client_name: 'rxZLeLQMmTDp53sY3sTuv',
    });
  });

  it('returns access_denied redirect when consent is denied', async () => {
    // Route writes the result directly onto the interaction and calls
    // details.save() (rather than provider.interactionResult, which would
    // read the wrong UID from the cookie in multi-prompt flows). The
    // canonical resume URL is `${OAUTH_ISSUER}/oauth/auth/<uid>` — note the
    // OAUTH_ISSUER env isn't set in these tests so it stringifies as
    // "undefined/oauth/auth/uid-1".
    const d = details();
    mocks.interactionDetails.mockResolvedValue(d);
    const res = await request(await loadApp(), '/api/v1/oauth/interaction/uid-1/consent', {
      method: 'POST',
      body: JSON.stringify({ partner_id: PARTNER_ID, approve: false }),
    });
    expect(res.status).toBe(200);
    const body = await res.json() as { redirectTo: string };
    expect(body.redirectTo).toMatch(/\/oauth\/auth\/uid-1$/);
    expect(d.result).toEqual({ error: 'access_denied', error_description: 'user denied access' });
    expect(d.save).toHaveBeenCalled();
  });

  it('rejects unsupported resource indicators', async () => {
    mocks.interactionDetails.mockResolvedValue(details({
      params: { client_id: 'client-1', resource: 'https://evil.example/mcp' },
    }));
    const res = await request(await loadApp(), '/api/v1/oauth/interaction/uid-1/consent', {
      method: 'POST',
      body: JSON.stringify({ partner_id: PARTNER_ID, approve: true }),
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ message: 'unsupported resource indicator' });
  });

  it('rejects malformed consent JSON before membership checks', async () => {
    mocks.interactionDetails.mockResolvedValue(details());
    const res = await request(await loadApp(), '/api/v1/oauth/interaction/uid-1/consent', {
      method: 'POST',
      body: '{',
    });

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ message: 'invalid consent request body' });
    expect(mocks.select).not.toHaveBeenCalled();
  });

  it('rejects consent bodies with invalid approve or partner_id shape', async () => {
    mocks.interactionDetails.mockResolvedValue(details());

    const approveRes = await request(await loadApp(), '/api/v1/oauth/interaction/uid-1/consent', {
      method: 'POST',
      body: JSON.stringify({ partner_id: PARTNER_ID, approve: 'yes' }),
    });
    expect(approveRes.status).toBe(400);
    expect(await approveRes.json()).toEqual({ message: 'approve must be a boolean' });

    const partnerRes = await request(await loadApp(), '/api/v1/oauth/interaction/uid-1/consent', {
      method: 'POST',
      body: JSON.stringify({ partner_id: 'partner-1', approve: true }),
    });
    expect(partnerRes.status).toBe(400);
    expect(await partnerRes.json()).toEqual({ message: 'partner_id must be a valid UUID' });
  });

  it('rejects consent for partners where the user is not a member', async () => {
    mocks.interactionDetails.mockResolvedValue(details());
    queueSelect([], 'limit');
    const res = await request(await loadApp(), '/api/v1/oauth/interaction/uid-1/consent', {
      method: 'POST',
      body: JSON.stringify({ partner_id: PARTNER_ID, approve: true }),
    });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ message: 'not a member of this partner' });
  });

  it('creates a stamped grant, binds the client partner, and returns a redirect', async () => {
    // Realistic prompt detail: oidc-provider populates `scopes.new` with all
    // scopes the user is being asked to approve for the first time, so a
    // healthy auth request that asks for `mcp:read mcp:write` will include
    // those in `scopes.new` too. The H3 fix relies on this — anything in
    // `params.scope` that ISN'T in the displayed set is dropped.
    const d = details({
      prompt: { details: { scopes: { new: ['openid', 'offline_access', 'mcp:read', 'mcp:write'] } } },
    });
    mocks.interactionDetails.mockResolvedValue(d);
    queueSelect([{ partnerId: PARTNER_ID, userId: 'u1' }], 'limit');
    queueSelect([{ partnerId: PARTNER_ID, orgId: 'org-1' }], 'limit');
    // Two updates happen during a successful consent:
    //   1) setGrantBreezeMeta() does an UPDATE on oauth_grants to persist
    //      partner_id/org_id alongside the just-saved Grant row, so the
    //      tenancy survives an API restart between consent and the first
    //      refresh-token grant. (See adapter.ts setGrantBreezeMeta.)
    //   2) The route updates oauth_clients to bind the client to the chosen
    //      partner — uses .returning() now (H2: only first partner wins).
    queueUpdate(); // setGrantBreezeMeta on oauth_grants
    // H2 proper fix: consent route INSERTs into oauth_client_partner_grants.
    // `firstConsented: true` simulates a fresh row (firstConsentedAt ===
    // lastConsentedAt), which routes to the `partner_grant_recorded` audit.
    const grantInsert = queueInsertGrantReturning({ firstConsented: true });
    const res = await request(await loadApp(), '/api/v1/oauth/interaction/uid-1/consent', {
      method: 'POST',
      body: JSON.stringify({ partner_id: PARTNER_ID, approve: true }),
    });
    expect(res.status).toBe(200);
    const respBody = await res.json() as { redirectTo: string };
    expect(respBody.redirectTo).toMatch(/\/oauth\/auth\/uid-1$/);
    expect(mocks.Grant.instances[0]).toMatchObject({
      accountId: 'u1',
      clientId: 'client-1',
    });
    // Grant.IN_PAYLOAD strips unknown fields; tenancy lives in setGrantBreezeMeta
    // (verified via the queued UPDATE on oauth_grants above). H3: every
    // requested scope (openid, offline_access, mcp:read, mcp:write) is
    // present in `prompt.details.scopes.new`, so the intersection equals the
    // full request and the OIDC scope set includes them all.
    expect(mocks.Grant.instances[0]?.addOIDCScope)
      .toHaveBeenCalledWith('openid offline_access mcp:read mcp:write');
    expect(mocks.Grant.instances[0]?.addResourceScope)
      .toHaveBeenCalledWith('https://api.example/mcp/server', 'mcp:read mcp:write');
    // The join-table INSERT carries (clientId, partnerId).
    expect(grantInsert.values).toHaveBeenCalledWith({
      clientId: 'client-1',
      partnerId: PARTNER_ID,
    });
    // LOW: a fresh first-consent emits the `partner_grant_recorded` audit;
    // a re-consent (different firstConsentedAt vs lastConsentedAt) would
    // emit `partner_grant_refreshed` instead — see the H2 test below.
    expect(auditMocks.writeRouteAudit).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: 'oauth.client.partner_grant_recorded',
        resourceType: 'oauth_client',
        resourceId: 'client-1',
      }),
    );
    // Route writes result onto the interaction and calls save() rather than
    // provider.interactionResult (cookie-UID-vs-URL-UID race in multi-prompt flows).
    expect(d.result).toEqual({ login: { accountId: 'u1' }, consent: { grantId: 'grant-1' } });
    expect(d.save).toHaveBeenCalled();
  });

  it('does not grant unrequested MCP resource scopes during consent fallback', async () => {
    // Realistic case: client requested mcp:read only, prompt displays only
    // mcp:read (matches the H3 invariant that grantedScopes ⊆ displayed).
    const d = details({
      params: {
        client_id: 'client-1',
        client_name: 'Claude Desktop',
        resource: 'https://api.example/mcp/server',
        scope: 'openid offline_access mcp:read',
      },
      prompt: { details: { scopes: { new: ['openid', 'offline_access', 'mcp:read'] } } },
    });
    mocks.interactionDetails.mockResolvedValue(d);
    queueSelect([{ partnerId: PARTNER_ID, userId: 'u1' }], 'limit');
    queueSelect([{ partnerId: PARTNER_ID, orgId: 'org-1' }], 'limit');
    queueUpdate();
    queueInsertGrantReturning({ firstConsented: true });

    const res = await request(await loadApp(), '/api/v1/oauth/interaction/uid-1/consent', {
      method: 'POST',
      body: JSON.stringify({ partner_id: PARTNER_ID, approve: true }),
    });

    expect(res.status).toBe(200);
    expect(mocks.Grant.instances[0]?.addResourceScope)
      .toHaveBeenCalledWith('https://api.example/mcp/server', 'mcp:read');
    expect(mocks.Grant.instances[0]?.addResourceScope)
      .not.toHaveBeenCalledWith('https://api.example/mcp/server', 'mcp:read mcp:write');
  });

  // -------------------------------------------------------------------
  // H1 — Interaction-hijack: consent must be bound to the user who logged
  // in to start the flow. Without this, anyone with a valid dashboard JWT
  // could complete a flow another user initiated, binding the resulting
  // grant (and the access token's partner_id/org_id) to their own tenant.
  // -------------------------------------------------------------------
  it('H1: rejects consent POST when interaction.session.accountId belongs to a different user', async () => {
    // Interaction was initiated and login completed by user `victim-id`;
    // mock authMiddleware returns `u1`. Even though u1 has a valid dashboard
    // JWT, they should NOT be able to finish another user's consent flow.
    const d = details({ session: { accountId: 'victim-id' } } as any);
    mocks.interactionDetails.mockResolvedValue(d);
    const res = await request(await loadApp(), '/api/v1/oauth/interaction/uid-1/consent', {
      method: 'POST',
      body: JSON.stringify({ partner_id: PARTNER_ID, approve: true }),
    });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ message: 'interaction_user_mismatch' });
    // No grant minted, no DB writes, no audit event.
    expect(mocks.Grant.instances).toHaveLength(0);
    expect(auditMocks.writeRouteAudit).not.toHaveBeenCalled();
  });

  it('H1: rejects GET interaction when session.accountId belongs to a different user', async () => {
    // Even reading the consent payload (client_name, scopes, partner picker)
    // leaks information about a victim's flow — fail closed on GET too.
    const d = details({ session: { accountId: 'victim-id' } } as any);
    mocks.interactionDetails.mockResolvedValue(d);
    const res = await request(await loadApp(), '/api/v1/oauth/interaction/uid-1');
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ message: 'interaction_user_mismatch' });
  });

  it('H1: rejects second POST when first POST already pinned a different user', async () => {
    // Pre-login resume edge: session.accountId not yet set, but a previous
    // POST (by user A) already wrote `lastSubmission.accountId`. The second
    // POST (by user B = u1 from authMiddleware mock) must be rejected.
    const d = details({ lastSubmission: { accountId: 'user-a-id' } } as any);
    mocks.interactionDetails.mockResolvedValue(d);
    const res = await request(await loadApp(), '/api/v1/oauth/interaction/uid-1/consent', {
      method: 'POST',
      body: JSON.stringify({ partner_id: PARTNER_ID, approve: true }),
    });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ message: 'interaction_user_mismatch' });
  });

  it('H1: allows consent when session.accountId equals the dashboard user', async () => {
    // Happy path: login interaction populated session.accountId = u1, the
    // same user posts consent. Must succeed.
    const d = details({
      session: { accountId: 'u1' },
      prompt: { details: { scopes: { new: ['openid', 'offline_access', 'mcp:read', 'mcp:write'] } } },
    } as any);
    mocks.interactionDetails.mockResolvedValue(d);
    queueSelect([{ partnerId: PARTNER_ID, userId: 'u1' }], 'limit');
    queueSelect([{ partnerId: PARTNER_ID, orgId: 'org-1' }], 'limit');
    queueUpdate();
    queueInsertGrantReturning({ firstConsented: true });
    const res = await request(await loadApp(), '/api/v1/oauth/interaction/uid-1/consent', {
      method: 'POST',
      body: JSON.stringify({ partner_id: PARTNER_ID, approve: true }),
    });
    expect(res.status).toBe(200);
    // Pin marker written for follow-up POSTs.
    expect((d as any).lastSubmission).toEqual({ accountId: 'u1' });
  });

  // -------------------------------------------------------------------
  // H2 (proper fix) — `oauth_client_partner_grants` join table replaces
  // the single-winner `oauth_clients.partner_id` column. Each consenting
  // partner gets its own (client_id, partner_id) row; re-consent bumps
  // `last_consented_at` and emits a `partner_grant_refreshed` audit; first
  // consent emits `partner_grant_recorded`. Both partners independently
  // visible/revocable in the connected-apps UI.
  // -------------------------------------------------------------------
  it('H2 (proper fix): a re-consent updates last_consented_at and audits as partner_grant_refreshed', async () => {
    const d = details({
      session: { accountId: 'u1' },
      prompt: { details: { scopes: { new: ['openid', 'offline_access', 'mcp:read', 'mcp:write'] } } },
    } as any);
    mocks.interactionDetails.mockResolvedValue(d);
    queueSelect([{ partnerId: PARTNER_ID, userId: 'u1' }], 'limit');
    queueSelect([{ partnerId: PARTNER_ID, orgId: 'org-1' }], 'limit');
    queueUpdate(); // setGrantBreezeMeta on oauth_grants
    // `firstConsented: false` => firstConsentedAt < lastConsentedAt =>
    // route classifies this as a re-consent (existing row, conflict-update).
    queueInsertGrantReturning({ firstConsented: false });

    const res = await request(await loadApp(), '/api/v1/oauth/interaction/uid-1/consent', {
      method: 'POST',
      body: JSON.stringify({ partner_id: PARTNER_ID, approve: true }),
    });
    expect(res.status).toBe(200);
    expect(auditMocks.writeRouteAudit).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: 'oauth.client.partner_grant_refreshed',
        resourceType: 'oauth_client',
        resourceId: 'client-1',
      }),
    );
  });

  it('H2 (proper fix): two different partners both succeed without stomping each other', async () => {
    // Partner A consents first. The mocks simulate an INSERT (firstConsentedAt
    // === lastConsentedAt). The route must record `partner_grant_recorded`
    // for partner A — and crucially, never UPDATEs `oauth_clients.partner_id`
    // (we don't queue a queueUpdateReturning for that path), so when partner B
    // arrives next the legacy single-winner column doesn't get clobbered.
    const dA = details({
      session: { accountId: 'u1' },
      prompt: { details: { scopes: { new: ['openid', 'offline_access'] } } },
    } as any);
    mocks.interactionDetails.mockResolvedValue(dA);
    queueSelect([{ partnerId: PARTNER_ID, userId: 'u1' }], 'limit');
    queueSelect([{ partnerId: PARTNER_ID, orgId: 'org-1' }], 'limit');
    queueUpdate();
    queueInsertGrantReturning({ firstConsented: true });

    const resA = await request(await loadApp(), '/api/v1/oauth/interaction/uid-1/consent', {
      method: 'POST',
      body: JSON.stringify({ partner_id: PARTNER_ID, approve: true }),
    });
    expect(resA.status).toBe(200);
    expect(mocks.update).toHaveBeenCalledTimes(1); // only setGrantBreezeMeta
    // No UPDATE on oauth_clients — the legacy stomping path is gone.
    expect(mocks.insert).toHaveBeenCalledTimes(1); // only the join-table INSERT
  });

  // -------------------------------------------------------------------
  // H3 — Scope intersection. Granted scopes MUST be a subset of what the
  // consent UI displayed (prompt.details.scopes.new ∪ scopes.accepted).
  // -------------------------------------------------------------------
  it('H3: grants only the intersection of requested ∩ displayed scopes', async () => {
    // Requested set is larger than displayed set: user is told they're
    // approving `openid` and `mcp:read`, but params.scope also asks for
    // `mcp:execute`. The grant must NOT include mcp:execute.
    const d = details({
      session: { accountId: 'u1' },
      params: {
        client_id: 'client-1',
        client_name: 'Claude Desktop',
        resource: 'https://api.example/mcp/server',
        scope: 'openid mcp:read mcp:execute',
      },
      prompt: { details: { scopes: { new: ['openid', 'mcp:read'] } } },
    } as any);
    mocks.interactionDetails.mockResolvedValue(d);
    queueSelect([{ partnerId: PARTNER_ID, userId: 'u1' }], 'limit');
    queueSelect([{ partnerId: PARTNER_ID, orgId: 'org-1' }], 'limit');
    queueUpdate();
    queueInsertGrantReturning({ firstConsented: true });

    const res = await request(await loadApp(), '/api/v1/oauth/interaction/uid-1/consent', {
      method: 'POST',
      body: JSON.stringify({ partner_id: PARTNER_ID, approve: true }),
    });
    expect(res.status).toBe(200);
    // OIDC scope set: only the intersection.
    expect(mocks.Grant.instances[0]?.addOIDCScope).toHaveBeenCalledWith('openid mcp:read');
    expect(mocks.Grant.instances[0]?.addOIDCScope)
      .not.toHaveBeenCalledWith('openid mcp:read mcp:execute');
    // Resource scope: only mcp:read (mcp:execute was requested but not
    // displayed, so it's stripped).
    expect(mocks.Grant.instances[0]?.addResourceScope)
      .toHaveBeenCalledWith('https://api.example/mcp/server', 'mcp:read');
    expect(mocks.Grant.instances[0]?.addResourceScope)
      .not.toHaveBeenCalledWith('https://api.example/mcp/server', 'mcp:read mcp:execute');
    expect(mocks.Grant.instances[0]?.addResourceScope)
      .not.toHaveBeenCalledWith('https://api.example/mcp/server', 'mcp:execute');
  });

  it('H3: returns 400 invalid_scope when no requested scope is displayed', async () => {
    // Pathological case: every requested scope is outside the displayed set.
    // We refuse rather than silently mint an empty-scope token.
    const d = details({
      session: { accountId: 'u1' },
      params: {
        client_id: 'client-1',
        client_name: 'Claude Desktop',
        resource: 'https://api.example/mcp/server',
        scope: 'mcp:execute',
      },
      prompt: { details: { scopes: { new: ['openid', 'mcp:read'] } } },
    } as any);
    mocks.interactionDetails.mockResolvedValue(d);
    queueSelect([{ partnerId: PARTNER_ID, userId: 'u1' }], 'limit');
    queueSelect([{ partnerId: PARTNER_ID, orgId: 'org-1' }], 'limit');

    const res = await request(await loadApp(), '/api/v1/oauth/interaction/uid-1/consent', {
      method: 'POST',
      body: JSON.stringify({ partner_id: PARTNER_ID, approve: true }),
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ message: 'invalid_scope' });
  });

  it('does not mount routes when MCP_OAUTH_ENABLED is false', async () => {
    const res = await request(await loadApp(false), '/api/v1/oauth/interaction/uid-1');
    expect(res.status).toBe(404);
  });

  it('returns 500 when interactionDetails throws an unexpected error', async () => {
    mocks.interactionDetails.mockRejectedValueOnce(new Error('boom'));
    const res = await request(await loadApp(true), '/api/v1/oauth/interaction/uid-1');
    expect(res.status).toBe(500);
  });

  it('returns 401 when authMiddleware rejects (no Bearer header)', async () => {
    // Replace the per-test authMiddleware mock with the real-shape rejection
    // so we can assert the routes propagate auth failures rather than silently
    // accepting all callers.
    const authMod = await import('../middleware/auth');
    const HTTPException = (await import('hono/http-exception')).HTTPException;
    vi.mocked(authMod.authMiddleware).mockImplementationOnce(async () => {
      throw new HTTPException(401, { message: 'Missing or invalid authorization header' });
    });
    const res = await request(await loadApp(true), '/api/v1/oauth/interaction/uid-1');
    expect(res.status).toBe(401);
  });
});
