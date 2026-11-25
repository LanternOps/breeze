/**
 * W02 (#12429): the stored MCP tool list mode through the real routes on real
 * Postgres — whose rows a read sees and an edit writes. Mocked-Drizzle unit
 * tests cannot see a predicate; every case here reads the rows back.
 *
 * oidc-provider itself is stubbed at `getProvider` (interaction lookup and the
 * Grant model only); its Grant.save goes through the REAL adapter, so the row
 * the consent route then updates is the one production writes.
 */
import './setup';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomUUID, createHash } from 'node:crypto';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { and, eq } from 'drizzle-orm';

const interaction = vi.hoisted(() => ({ details: null as any }));
vi.mock('../../oauth/provider', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../oauth/provider')>();
  class Grant {
    constructor(private readonly args: { accountId: string; clientId: string }) {}
    addOIDCScope() {}
    addResourceScope() {}
    async save() {
      const { BreezeOidcAdapter } = await import('../../oauth/adapter');
      const id = `grant-${crypto.randomUUID()}`;
      await new BreezeOidcAdapter('Grant').upsert(id, { ...this.args }, 3600);
      return id;
    }
  }
  return { ...actual, getProvider: vi.fn(async () => ({ Grant, Interaction: { find: vi.fn(async () => interaction.details) } })) };
});

import { apiKeys, auditLogs, oauthClientPartnerGrants, oauthClients, oauthGrants, servicePrincipals } from '../../db/schema';
import { withSystemDbAccessContext } from '../../db';
import { BreezeOidcAdapter, getGrantBreezeMetaAsync, setGrantBreezeMeta } from '../../oauth/adapter';
import { apiKeyAuthMiddleware } from '../../middleware/apiKeyAuth';
import { lifecycleRoutes } from '../../routes/lifecycle';
import { connectedAppsRoutes } from '../../routes/connectedApps';
import { oauthInteractionRoutes } from '../../routes/oauthInteraction';
import { apiKeyRoutes } from '../../routes/apiKeys';
import { createAccessToken } from '../../services/jwt';
import { rotateServicePrincipalKey } from '../../services/servicePrincipals';
import { assignUserToPartner, createIntegrationTestClient, createPartner, createRole, createUser, userEpochs, type IntegrationTestClient } from './db-utils';
import { getTestDb } from './setup';

type Mode = 'full' | 'progressive' | null;
const HOUR = 3600_000;

function app() {
  const a = new Hono();
  a.route('/', lifecycleRoutes);
  a.route('/settings/connected-apps', connectedAppsRoutes);
  a.route('/oauth', oauthInteractionRoutes);
  a.route('/api-keys', apiKeyRoutes);
  a.onError((err, c) => (err instanceof HTTPException ? c.json({ message: err.message }, err.status) : c.json({ message: String(err) }, 500)));
  return a;
}

async function newClient(name = 'App') {
  const id = `client-${randomUUID()}`;
  await getTestDb().insert(oauthClients).values({ id, metadata: { client_name: name } } as never);
  return id;
}

async function newGrant(o: {
  user: string; client: string; partner: string | null; mode: Mode;
  revoked?: boolean; expired?: boolean; createdAt?: Date; id?: string;
}) {
  const id = o.id ?? `grant-${randomUUID()}`;
  await getTestDb().insert(oauthGrants).values({
    id,
    accountId: o.user,
    clientId: o.client,
    partnerId: o.partner,
    payload: {},
    expiresAt: new Date(Date.now() + (o.expired ? -HOUR : HOUR)),
    revokedAt: o.revoked ? new Date() : null,
    createdAt: o.createdAt ?? new Date(),
    mcpToolListMode: o.mode,
  });
  return id;
}

const modeOf = async (grantId: string) =>
  (await getTestDb().select({ m: oauthGrants.mcpToolListMode }).from(oauthGrants).where(eq(oauthGrants.id, grantId)))[0]?.m;

let owner: IntegrationTestClient;
let ownerId: string;
let partnerA: string;
let partnerB: string;

beforeEach(async () => {
  owner = await createIntegrationTestClient(app(), { scope: 'partner' });
  ownerId = owner.env.user.id;
  partnerA = owner.env.partner.id;
  const b = await createPartner();
  partnerB = b.id;
  const roleB = await createRole({ scope: 'partner', partnerId: b.id });
  await assignUserToPartner(ownerId, b.id, roleB.id, 'all');
});
afterEach(() => vi.unstubAllEnvs());

describe("the owner's connections (/me/oauth-clients)", () => {
  const modes = async () => {
    const body = await (await owner.get('/me/oauth-clients')).json() as any;
    return { body, of: (clientId: string) => body.clients.find((c: any) => c.clientId === clientId)?.toolListMode };
  };
  const patchMode = (clientId: string, body: unknown) => owner.patch(`/me/oauth-clients/${encodeURIComponent(clientId)}/mcp-tool-list-mode`, body);

  it('GET reports uniform, mixed and none from active connections only', async () => {
    const [uniform, inherits, mixed, sameEffective, ended] = await Promise.all([newClient(), newClient(), newClient(), newClient(), newClient()]);
    await newGrant({ user: ownerId, client: uniform, partner: partnerA, mode: 'progressive' });
    await newGrant({ user: ownerId, client: uniform, partner: partnerB, mode: 'progressive' });
    await newGrant({ user: ownerId, client: uniform, partner: partnerA, mode: 'full', revoked: true });
    await newGrant({ user: ownerId, client: uniform, partner: partnerA, mode: 'full', expired: true });
    await newGrant({ user: ownerId, client: inherits, partner: partnerA, mode: null });
    await newGrant({ user: ownerId, client: mixed, partner: partnerA, mode: 'progressive' });
    await newGrant({ user: ownerId, client: mixed, partner: partnerB, mode: 'full' });
    // Stored values differ, effective ones agree (default full): still mixed.
    await newGrant({ user: ownerId, client: sameEffective, partner: partnerA, mode: 'full' });
    await newGrant({ user: ownerId, client: sameEffective, partner: partnerB, mode: null });
    await newGrant({ user: ownerId, client: ended, partner: partnerA, mode: 'progressive', revoked: true });
    // Another user's connection to the same client is not part of any of it.
    const other = await createUser({ partnerId: partnerA, email: `o-${randomUUID()}@example.test` });
    await newGrant({ user: other.id, client: uniform, partner: partnerA, mode: 'full' });

    const { body, of } = await modes();
    expect(body.mcpToolListDefault).toBe('full');
    expect(of(uniform)).toEqual({ kind: 'uniform', stored: 'progressive', effective: { mode: 'progressive', source: 'credential' }, grantCount: 2 });
    expect(of(inherits)).toEqual({ kind: 'uniform', stored: null, effective: { mode: 'full', source: 'deployment_default' }, grantCount: 1 });
    expect(of(mixed)).toEqual({ kind: 'mixed', grantCount: 2 });
    expect(of(sameEffective)).toEqual({ kind: 'mixed', grantCount: 2 });
    expect(of(ended)).toEqual({ kind: 'none', grantCount: 0 });
  });

  it('PATCH writes only this user\'s active connections to that client, across both partners', async () => {
    const [client, otherClient] = await Promise.all([newClient(), newClient()]);
    const other = await createUser({ partnerId: partnerA, email: `o-${randomUUID()}@example.test` });
    const mine = [
      await newGrant({ user: ownerId, client, partner: partnerA, mode: 'full' }),
      await newGrant({ user: ownerId, client, partner: partnerB, mode: null }),
    ];
    const untouched = {
      otherUser: await newGrant({ user: other.id, client, partner: partnerA, mode: 'full' }),
      otherClient: await newGrant({ user: ownerId, client: otherClient, partner: partnerA, mode: 'full' }),
      expired: await newGrant({ user: ownerId, client, partner: partnerA, mode: 'full', expired: true }),
      revoked: await newGrant({ user: ownerId, client, partner: partnerA, mode: 'full', revoked: true }),
    };

    const res = await patchMode(client, { mcp_tool_list_mode: 'progressive' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ updated: 2 });
    for (const id of mine) expect(await modeOf(id)).toBe('progressive');
    for (const id of Object.values(untouched)) expect(await modeOf(id)).toBe('full');

    const { of } = await modes();
    expect(of(client)).toMatchObject({ kind: 'uniform', stored: 'progressive', grantCount: 2 });

    // Clearing is null, not a mode.
    expect((await patchMode(client, { mcp_tool_list_mode: null })).status).toBe(200);
    for (const id of mine) expect(await modeOf(id)).toBeNull();
    expect(await modeOf(untouched.otherUser)).toBe('full');

    await vi.waitFor(async () => {
      const rows = await getTestDb().select({ details: auditLogs.details }).from(auditLogs)
        .where(and(eq(auditLogs.action, 'oauth.client.mcp_tool_list_mode_update'), eq(auditLogs.actorId, ownerId)));
      expect(rows.map((r) => (r.details as any).mcpToolListMode).sort()).toEqual([null, 'progressive']);
      for (const r of rows) expect((r.details as any).grantCount).toBe(2);
    }, { timeout: 5000 });
  });

  it('refuses a bad value (400), a client with no active connection (404) and another user\'s client (404)', async () => {
    const [client, ended, foreign] = await Promise.all([newClient(), newClient(), newClient()]);
    const other = await createUser({ partnerId: partnerA, email: `o-${randomUUID()}@example.test` });
    const id = await newGrant({ user: ownerId, client, partner: partnerA, mode: 'full' });
    await newGrant({ user: ownerId, client: ended, partner: partnerA, mode: 'full', expired: true });
    const foreignGrant = await newGrant({ user: other.id, client: foreign, partner: partnerA, mode: 'full' });

    for (const bad of [{ mcp_tool_list_mode: 'Progressive' }, {}]) expect((await patchMode(client, bad)).status).toBe(400);
    expect((await patchMode(ended, { mcp_tool_list_mode: 'progressive' })).status).toBe(404);
    expect((await patchMode(foreign, { mcp_tool_list_mode: 'progressive' })).status).toBe(404);
    expect(await modeOf(id)).toBe('full');
    expect(await modeOf(foreignGrant)).toBe('full');
  });

  it('a machine principal gets 403 and writes nothing, even for its owner\'s own connection', async () => {
    const client = await newClient();
    const id = await newGrant({ user: ownerId, client, partner: partnerA, mode: 'full' });
    for (const principal of [
      { kind: 'api_key', apiKeyId: randomUUID() },
      { kind: 'api_key', apiKeyId: randomUUID(), partnerServicePrincipalId: randomUUID() },
      { kind: 'oauth_grant', grantId: id },
    ]) {
      const machine = new Hono();
      // authMiddleware keeps a context that is already set, so this is how a
      // non-session principal would arrive.
      machine.use('*', async (c, next) => {
        c.set('auth', { principal, scope: 'partner', partnerId: partnerA, orgId: null, token: {}, user: { id: ownerId, email: 'x@example.test', name: 'X' } } as never);
        await next();
      });
      machine.route('/', lifecycleRoutes);
      const res = await machine.request(`/me/oauth-clients/${client}/mcp-tool-list-mode`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ mcp_tool_list_mode: 'progressive' }),
      });
      expect(res.status).toBe(403);
    }
    expect(await modeOf(id)).toBe('full');
    // No credential at all is refused by the session middleware.
    expect((await app().request(`/me/oauth-clients/${client}/mcp-tool-list-mode`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json', 'X-API-Key': 'brz_x' }, body: JSON.stringify({ mcp_tool_list_mode: 'progressive' }),
    })).status).toBe(401);
  });
});

describe("the partner's read-only summary (/settings/connected-apps)", () => {
  it('covers every user of THIS partner (none of them the caller), active connections only', async () => {
    const clients = {
      progressive: await newClient(), inherits: await newClient(), mixed: await newClient(),
      otherPartnerDisagrees: await newClient(), ended: await newClient(),
    };
    const db = getTestDb();
    for (const clientId of Object.values(clients)) await db.insert(oauthClientPartnerGrants).values({ clientId, partnerId: partnerA });
    const [u1, u2] = [
      await createUser({ partnerId: partnerA, email: `u1-${randomUUID()}@example.test` }),
      await createUser({ partnerId: partnerA, email: `u2-${randomUUID()}@example.test` }),
    ];
    await newGrant({ user: u1.id, client: clients.progressive, partner: partnerA, mode: 'progressive' });
    await newGrant({ user: u2.id, client: clients.progressive, partner: partnerA, mode: 'progressive' });
    await newGrant({ user: u2.id, client: clients.progressive, partner: partnerA, mode: 'full', revoked: true });
    await newGrant({ user: u1.id, client: clients.inherits, partner: partnerA, mode: null });
    await newGrant({ user: u1.id, client: clients.mixed, partner: partnerA, mode: 'full' });
    await newGrant({ user: u2.id, client: clients.mixed, partner: partnerA, mode: null });
    await newGrant({ user: u1.id, client: clients.otherPartnerDisagrees, partner: partnerA, mode: 'full' });
    await newGrant({ user: u2.id, client: clients.otherPartnerDisagrees, partner: partnerB, mode: 'progressive' });
    await newGrant({ user: u1.id, client: clients.ended, partner: partnerA, mode: 'full', expired: true });

    const res = await owner.get('/settings/connected-apps');
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    const of = (id: string) => body.clients.find((c: any) => c.client_id === id)?.mcp_tool_list_mode;
    expect(of(clients.progressive)).toBe('progressive');
    expect(of(clients.inherits)).toBe('default');
    expect(of(clients.mixed)).toBe('mixed');
    expect(of(clients.otherPartnerDisagrees)).toBe('full');
    expect(of(clients.ended)).toBeNull();
  });
});

describe('consent (/oauth/interaction)', () => {
  const uid = 'uid-mode';
  function startInteraction(clientId: string) {
    interaction.details = {
      uid,
      exp: Math.floor(Date.now() / 1000) + 600,
      params: { client_id: clientId, scope: 'openid offline_access mcp:read', redirect_uri: 'https://app.example/cb' },
      prompt: { details: {} },
      save: vi.fn(async () => undefined),
    };
  }

  it('GET: each partner carries the mode of the owner\'s newest active connection there', async () => {
    vi.stubEnv('MCP_TOOL_LIST_DEFAULT', 'progressive');
    const client = await newClient();
    const otherClient = await newClient();
    const other = await createUser({ partnerId: partnerA, email: `o-${randomUUID()}@example.test` });
    const at = (minutesAgo: number) => new Date(Date.now() - minutesAgo * 60_000);
    // Partner A: an older progressive, a newer full; newer still but revoked / expired / foreign rows never count.
    await newGrant({ user: ownerId, client, partner: partnerA, mode: 'progressive', createdAt: at(60) });
    await newGrant({ user: ownerId, client, partner: partnerA, mode: 'full', createdAt: at(30) });
    await newGrant({ user: ownerId, client, partner: partnerA, mode: 'progressive', createdAt: at(5), revoked: true });
    await newGrant({ user: ownerId, client, partner: partnerA, mode: 'progressive', createdAt: at(4), expired: true });
    await newGrant({ user: other.id, client, partner: partnerA, mode: 'progressive', createdAt: at(3) });
    await newGrant({ user: ownerId, client: otherClient, partner: partnerA, mode: 'progressive', createdAt: at(2) });
    // Partner B: two rows of one instant; the id breaks the tie.
    const tie = at(10);
    await newGrant({ user: ownerId, client, partner: partnerB, mode: 'full', createdAt: tie, id: `grant-a-${randomUUID()}` });
    await newGrant({ user: ownerId, client, partner: partnerB, mode: 'progressive', createdAt: tie, id: `grant-b-${randomUUID()}` });
    const c = await createPartner();
    const roleC = await createRole({ scope: 'partner', partnerId: c.id });
    await assignUserToPartner(ownerId, c.id, roleC.id, 'all');

    startInteraction(client);
    const res = await owner.get(`/oauth/interaction/${uid}`);
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.mcp_tool_list_default).toBe('progressive');
    const of = (id: string) => {
      const p = body.partners.find((x: any) => x.partnerId === id);
      return [p.prior_mcp_tool_list_mode, p.effective_mcp_tool_list_mode];
    };
    expect(of(partnerA)).toEqual(['full', { mode: 'full', source: 'credential' }]);
    expect(of(partnerB)).toEqual(['progressive', { mode: 'progressive', source: 'credential' }]);
    expect(of(c.id)).toEqual([null, { mode: 'progressive', source: 'deployment_default' }]);
  });

  it.each(['full', 'progressive', null] as const)('POST: the new grant row carries %s; the prior connection keeps its own', async (mode) => {
    const client = await newClient();
    const prior = await newGrant({ user: ownerId, client, partner: partnerA, mode: 'full' });
    startInteraction(client);
    const res = await owner.post(`/oauth/interaction/${uid}/consent`, { partner_id: partnerA, approve: true, mcp_tool_list_mode: mode });
    expect(res.status).toBe(200);
    const rows = await getTestDb().select({ id: oauthGrants.id, m: oauthGrants.mcpToolListMode, p: oauthGrants.partnerId })
      .from(oauthGrants).where(and(eq(oauthGrants.accountId, ownerId), eq(oauthGrants.clientId, client)));
    expect(rows.find((r) => r.id === prior)?.m).toBe('full');
    expect(rows.filter((r) => r.id !== prior)).toEqual([{ id: expect.any(String), m: mode, p: partnerA }]);
  });

  it('POST without a mode stores null (inherit); a bad mode creates no grant', async () => {
    const client = await newClient();
    startInteraction(client);
    expect((await owner.post(`/oauth/interaction/${uid}/consent`, { partner_id: partnerA, approve: true, mcp_tool_list_mode: 'Full' })).status).toBe(400);
    const rows = () => getTestDb().select({ m: oauthGrants.mcpToolListMode }).from(oauthGrants).where(eq(oauthGrants.clientId, client));
    expect(await rows()).toEqual([]);
    expect((await owner.post(`/oauth/interaction/${uid}/consent`, { partner_id: partnerA, approve: true })).status).toBe(200);
    expect(await rows()).toEqual([{ m: null }]);
  });

  it('setGrantBreezeMeta → getGrantBreezeMetaAsync round-trips the mode, and a grant upsert preserves it', async () => {
    const client = await newClient();
    const id = `grant-${randomUUID()}`;
    const payload = { accountId: ownerId, clientId: client };
    const adapter = new BreezeOidcAdapter('Grant');
    await adapter.upsert(id, payload, 3600);
    const meta = { partner_id: partnerA, org_id: null, mcp_domains: null, mcp_tool_list_mode: 'progressive' as const };
    await setGrantBreezeMeta(id, meta);
    expect(await getGrantBreezeMetaAsync(id)).toEqual(meta);
    await adapter.upsert(id, { ...payload, extended: true }, 7200);
    expect(await getGrantBreezeMetaAsync(id)).toEqual(meta);
  });
});

describe('API keys', () => {
  const body = (orgId: string, extra: Record<string, unknown> = {}) => ({ orgId, name: 'K', scopes: ['ai:read'], ...extra });
  const stored = async (id: string) => (await getTestDb().select({ m: apiKeys.mcpToolListMode }).from(apiKeys).where(eq(apiKeys.id, id)))[0]?.m;

  /** The API-key routes require MFA; the shared fixture token has none. */
  async function keyAdmin(rolePermissions?: Array<{ resource: string; action: string }>) {
    const client = await createIntegrationTestClient(app(), { scope: 'organization', ...(rolePermissions ? { rolePermissions } : {}) });
    const { env } = client;
    const token = await createAccessToken({
      sub: env.user.id, email: env.user.email, roleId: env.role.id, orgId: env.organization.id, partnerId: env.partner.id,
      scope: 'organization', mfa: true, aep: 1, mep: 1, sid: randomUUID(),
    });
    const send = async (method: string, path: string, json?: unknown) => {
      const res = await app().request(path, {
        method, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: json === undefined ? undefined : JSON.stringify(json),
      });
      return { status: res.status, body: await res.json() as any };
    };
    return { env, send, withoutMfa: client };
  }

  it('create, edit, rotate: the row carries exactly what was set, and rotation keeps it', async () => {
    const admin = await keyAdmin();
    const orgId = admin.env.organization.id;
    const plain = await admin.send('POST', '/api-keys', body(orgId));
    expect(plain.status, JSON.stringify(plain.body)).toBe(201);
    expect(await stored(plain.body.id)).toBeNull();
    const created = await admin.send('POST', '/api-keys', body(orgId, { mcpToolListMode: 'progressive' }));
    const id = created.body.id;
    expect(await stored(id)).toBe('progressive');

    expect((await admin.send('POST', `/api-keys/${id}/rotate`)).status).toBe(200);
    expect(await stored(id)).toBe('progressive');

    expect((await admin.send('PATCH', `/api-keys/${id}`, { mcpToolListMode: 'full' })).status).toBe(200);
    expect(await stored(id)).toBe('full');
    expect(await stored(plain.body.id)).toBeNull();
    const cleared = await admin.send('PATCH', `/api-keys/${id}`, { mcpToolListMode: null });
    expect(cleared.body).toMatchObject({ mcpToolListMode: null, mcpToolListModeEffective: { mode: 'full', source: 'deployment_default' } });
    expect(await stored(id)).toBeNull();
    expect((await admin.send('PATCH', `/api-keys/${id}`, { mcpToolListMode: 'Full' })).status).toBe(400);

    const listed = (await admin.send('GET', '/api-keys')).body;
    expect(listed.mcpToolListDefault).toBe('full');
    expect(listed.data.find((k: any) => k.id === id)).toMatchObject({ mcpToolListMode: null, mcpToolListModeEffective: { mode: 'full', source: 'deployment_default' } });
  });

  it('editing it needs what editing the key needs: permission, MFA and the key\'s org', async () => {
    const admin = await keyAdmin();
    const created = await admin.send('POST', '/api-keys', body(admin.env.organization.id, { mcpToolListMode: 'full' }));
    const path = `/api-keys/${created.body.id}`;

    const reader = await keyAdmin([{ resource: 'organizations', action: 'read' }]);
    const readerKey = randomUUID();
    await getTestDb().insert(apiKeys).values({
      id: readerKey, orgId: reader.env.organization.id, name: 'r', keyHash: readerKey, keyPrefix: 'brz_r', createdBy: reader.env.user.id, mcpToolListMode: 'full',
    });
    const denied = await reader.send('PATCH', `/api-keys/${readerKey}`, { mcpToolListMode: 'progressive' });
    expect(denied.status).toBe(403);
    expect(denied.body.code).not.toBe('MFA_REQUIRED');
    expect(await stored(readerKey)).toBe('full');

    const noMfa = await admin.withoutMfa.patch(path, { mcpToolListMode: 'progressive' });
    expect(noMfa.status).toBe(403);
    expect(await noMfa.json()).toMatchObject({ code: 'MFA_REQUIRED' });

    const stranger = await keyAdmin();
    expect([403, 404]).toContain((await stranger.send('PATCH', path, { mcpToolListMode: 'progressive' })).status);
    expect(await stored(created.body.id)).toBe('full');
  });

  it('each key authenticates with its own stored mode', async () => {
    const admin = await createIntegrationTestClient(app(), { scope: 'organization' });
    const epochs = await userEpochs(admin.env.user.id);
    const contextModeOf = async (mode: Mode) => {
      const raw = `brz_${randomUUID().replaceAll('-', '')}`;
      await getTestDb().insert(apiKeys).values({
        orgId: admin.env.organization.id, name: 'k', keyHash: createHash('sha256').update(raw).digest('hex'), keyPrefix: raw.slice(0, 12),
        scopes: [], createdBy: admin.env.user.id, mcpToolListMode: mode,
        creatorAuthEpoch: epochs.authEpoch, creatorMfaEpoch: epochs.mfaEpoch, creatorCredentialEpoch: epochs.credentialEpoch,
      });
      const probe = new Hono();
      probe.get('/', apiKeyAuthMiddleware, (c) => c.json({ mode: c.get('apiKey').mcpToolListMode }));
      probe.onError((err, c) => c.json({ message: err.message }, 500));
      return ((await (await probe.request('/', { headers: { 'X-API-Key': raw } })).json()) as any).mode;
    };
    expect(await contextModeOf('progressive')).toBe('progressive');
    expect(await contextModeOf('full')).toBe('full');
    expect(await contextModeOf(null)).toBeNull();
  });

  it('service principal rotation: the newest active key\'s mode, id breaking a tie', async () => {
    const admin = await createIntegrationTestClient(app(), { scope: 'organization' });
    const db = getTestDb();
    const [principal] = await db.insert(servicePrincipals).values({
      orgId: admin.env.organization.id, name: 'sp', status: 'active', scopes: ['ai:read'], createdBy: admin.env.user.id,
    }).returning();
    const now = new Date();
    const key = (id: string, o: { mode: Mode; status?: 'active' | 'revoked'; createdAt: Date }) => db.insert(apiKeys).values({
      id, orgId: admin.env.organization.id, name: 'k', keyHash: id, keyPrefix: 'brz_k', createdBy: admin.env.user.id,
      principalType: 'service', principalId: principal!.id, mcpToolListMode: o.mode, status: o.status ?? 'active', createdAt: o.createdAt,
    });
    await key('00000000-0000-4000-8000-000000000001', { mode: 'full', createdAt: now });
    await key('00000000-0000-4000-8000-000000000002', { mode: 'progressive', createdAt: now });
    await key('00000000-0000-4000-8000-000000000003', { mode: 'full', status: 'revoked', createdAt: new Date(now.getTime() + 1000) });
    const first = await withSystemDbAccessContext(() => rotateServicePrincipalKey(principal!.id, admin.env.user.id));
    expect(await stored(first.apiKeyId)).toBe('progressive');
  });
});
