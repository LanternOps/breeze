/**
 * #12691 — SentinelOne and Huntress integrations can be disconnected, through
 * the REAL routes (authMiddleware → requireScope → requirePermission →
 * requireMfa → handler) on real Postgres as the unprivileged `breeze_app`
 * role, with minted tokens.
 *
 * Disconnect is soft: the integration row stays (synced history references
 * it), `is_active` goes false, and every stored secret on it is nulled.
 * Reconnecting the same provider reactivates that row, so history and the
 * site/org mappings stay attached and no unique index is violated.
 *
 * Run (needs `pnpm test-stack up`):
 *   cd apps/api && npx vitest run --config vitest.integration.config.ts \
 *     src/__tests__/integration/securityIntegrationDisconnect.integration.test.ts
 */
import './setup';
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { eq } from 'drizzle-orm';
import { sentinelOneRoutes } from '../../routes/sentinelOne';
import { huntressRoutes } from '../../routes/huntress';
import {
  huntressIncidents,
  huntressIntegrations,
  huntressOrgMappings,
  s1Integrations,
  s1OrgMappings,
  s1Threats,
} from '../../db/schema';
import { encryptSecret } from '../../services/secretCrypto';
import { buildHuntressWebhookSignature } from '../../services/huntressClient';
import { upsertDiscoveredSites } from '../../jobs/s1Sync';
import { db, withSystemDbAccessContext } from '../../db';
import {
  clearS1SiteRegistrationTokens,
  disconnectHuntressIntegration,
  disconnectS1Integration,
  writeOrActiveIndexConflict,
} from '../../services/securityIntegrationDisconnect';
import { PartnerWideWriteDeniedError } from '../../services/partnerWideAccess';
import { createAccessToken } from '../../services/jwt';
import {
  assignUserToOrganization,
  assignUserToPartner,
  createOrganization,
  createPartner,
  createRole,
  createUser,
  grantRolePermissions,
} from './db-utils';
import { getTestDb } from './setup';

function buildApp(): Hono {
  const app = new Hono();
  app.route('/s1', sentinelOneRoutes);
  app.route('/huntress', huntressRoutes);
  return app;
}

const ALL = [{ resource: '*', action: '*' }];

async function partnerAdminToken(
  partnerId: string,
  opts: {
    mfa?: boolean;
    orgAccess?: 'all' | 'selected';
    permissions?: Array<{ resource: string; action: string }>;
  } = {},
): Promise<string> {
  const role = await createRole({ scope: 'partner', partnerId });
  await grantRolePermissions(role.id, opts.permissions ?? ALL);
  const user = await createUser({ partnerId, orgId: null, email: `pa-${randomUUID().slice(0, 8)}@example.test` });
  await assignUserToPartner(user.id, partnerId, role.id, opts.orgAccess ?? 'all');
  return createAccessToken({
    sub: user.id, email: user.email, roleId: role.id, orgId: null, partnerId,
    scope: 'partner', mfa: opts.mfa ?? true, aep: 1, mep: 1, sid: randomUUID(),
  });
}

async function orgUserToken(partnerId: string, orgId: string): Promise<string> {
  const role = await createRole({ scope: 'organization', orgId, partnerId });
  await grantRolePermissions(role.id, ALL);
  const user = await createUser({ partnerId, orgId, email: `ou-${randomUUID().slice(0, 8)}@example.test` });
  await assignUserToOrganization(user.id, orgId, role.id);
  return createAccessToken({
    sub: user.id, email: user.email, roleId: role.id, orgId, partnerId,
    scope: 'organization', mfa: true, aep: 1, mep: 1, sid: randomUUID(),
  });
}

function call(app: Hono, token: string, method: string, path: string, body?: unknown) {
  return app.request(path, {
    method,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

async function seedS1Partner(label: string) {
  const tdb = getTestDb() as any;
  const partner = await createPartner();
  const org = await createOrganization({ partnerId: partner.id });
  const [integration] = await tdb.insert(s1Integrations).values({
    partnerId: partner.id,
    name: `S1 ${label}`,
    apiTokenEncrypted: encryptSecret(`s1-token-${label}`),
    managementUrl: 'https://usea1-test.sentinelone.net',
    isActive: true,
  }).returning();
  await tdb.insert(s1OrgMappings).values({
    integrationId: integration.id,
    partnerId: partner.id,
    s1SiteId: `site-${label}`,
    s1SiteName: `Site ${label}`,
    orgId: org.id,
    registrationToken: encryptSecret(`reg-token-${label}`, { aad: 's1_org_mappings.registration_token' }),
  });
  const [threat] = await tdb.insert(s1Threats).values({
    orgId: org.id,
    integrationId: integration.id,
    s1ThreatId: `threat-${label}`,
    threatName: 'EICAR',
    status: 'active',
    detectedAt: new Date(),
  }).returning();
  return { partner, org, integration, threat };
}

async function seedS1() {
  const a = await seedS1Partner('a');
  const partnerB = await createPartner();
  const orgB = await createOrganization({ partnerId: partnerB.id });
  return { partnerA: a.partner, orgA: a.org, partnerB, orgB, integration: a.integration, threat: a.threat };
}

async function seedHuntressPartner(label: string) {
  const tdb = getTestDb() as any;
  const partner = await createPartner();
  const org = await createOrganization({ partnerId: partner.id });
  const [integration] = await tdb.insert(huntressIntegrations).values({
    partnerId: partner.id,
    name: `Huntress ${label}`,
    apiKeyEncrypted: encryptSecret(`hk-${label}`),
    accountId: `acct-${label}`,
    accountKeyEncrypted: encryptSecret(`acct-key-${label}`, { aad: 'huntress_integrations.account_key_encrypted' }),
    webhookSecretEncrypted: encryptSecret(`webhook-secret-${label}`),
    isActive: true,
  }).returning();
  await tdb.insert(huntressOrgMappings).values({
    integrationId: integration.id,
    partnerId: partner.id,
    huntressOrgId: `h-org-${label}`,
    huntressOrgName: `Customer ${label}`,
    orgId: org.id,
  });
  const [incident] = await tdb.insert(huntressIncidents).values({
    orgId: org.id,
    integrationId: integration.id,
    huntressIncidentId: `inc-${label}`,
    title: 'Footholds found',
    status: 'open',
    reportedAt: new Date(),
  }).returning();
  return { partner, org, integration, incident };
}

async function seedHuntress() {
  const a = await seedHuntressPartner('a');
  const partnerB = await createPartner();
  return { partnerA: a.partner, orgA: a.org, partnerB, integration: a.integration, incident: a.incident };
}

function signedTestDelivery(app: Hono, integrationId: string, secret: string) {
  const body = JSON.stringify({ event_type: 'test.event' });
  const ts = String(Math.floor(Date.now() / 1000));
  return app.request(`/huntress/webhook?integrationId=${integrationId}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-huntress-timestamp': ts,
      'x-huntress-signature': buildHuntressWebhookSignature(secret, body, ts),
    },
    body,
  });
}

describe('SentinelOne disconnect (#12691)', () => {
  it('another partner cannot disconnect it: 404, and the row keeps its credential', async () => {
    const app = buildApp();
    const { partnerB, integration } = await seedS1();
    const tokenB = await partnerAdminToken(partnerB.id);

    const res = await call(app, tokenB, 'DELETE', '/s1/integration');
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'No connected SentinelOne integration' });

    const [row] = await (getTestDb() as any).select().from(s1Integrations).where(eq(s1Integrations.id, integration.id));
    expect(row.isActive).toBe(true);
    expect(row.apiTokenEncrypted).not.toBeNull();
  });

  it('a partner admin naming another partner is refused (403)', async () => {
    const app = buildApp();
    const { partnerA, partnerB } = await seedS1();
    const tokenB = await partnerAdminToken(partnerB.id);
    const res = await call(app, tokenB, 'DELETE', `/s1/integration?partnerId=${partnerA.id}`);
    expect(res.status).toBe(403);
  });

  it('an organization-scope user cannot disconnect the partner integration (403)', async () => {
    const app = buildApp();
    const { partnerA, orgA, integration } = await seedS1();
    const token = await orgUserToken(partnerA.id, orgA.id);
    const res = await call(app, token, 'DELETE', '/s1/integration');
    expect(res.status).toBe(403);
    const [row] = await (getTestDb() as any).select().from(s1Integrations).where(eq(s1Integrations.id, integration.id));
    expect(row.isActive).toBe(true);
  });

  it('disconnect deactivates the row, nulls the API token and site tokens, and keeps history readable and labelled', async () => {
    const app = buildApp();
    const { partnerA, orgA, integration, threat } = await seedS1();
    const token = await partnerAdminToken(partnerA.id);

    const res = await call(app, token, 'DELETE', '/s1/integration');
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ success: true, data: { id: integration.id, isActive: false } });

    const tdb = getTestDb() as any;
    const [row] = await tdb.select().from(s1Integrations).where(eq(s1Integrations.id, integration.id));
    expect(row.isActive).toBe(false);
    expect(row.apiTokenEncrypted).toBeNull();
    const mappings = await tdb.select().from(s1OrgMappings).where(eq(s1OrgMappings.integrationId, integration.id));
    expect(mappings).toHaveLength(1);
    expect(mappings[0].registrationToken).toBeNull();
    expect(mappings[0].orgId).toBe(orgA.id);
    const threats = await tdb.select().from(s1Threats).where(eq(s1Threats.integrationId, integration.id));
    expect(threats).toHaveLength(1);

    // No active integration any more; a second disconnect has nothing to act on.
    expect((await (await call(app, token, 'GET', '/s1/integration')).json()).data).toBeNull();
    expect((await call(app, token, 'DELETE', '/s1/integration')).status).toBe(404);

    // History stays readable to the partner and says where it came from.
    const list = await call(app, token, 'GET', '/s1/threats');
    expect(list.status).toBe(200);
    const listed = await list.json();
    expect(listed.data.map((t: { id: string }) => t.id)).toEqual([threat.id]);
    expect(listed.data[0].integrationDisconnected).toBe(true);
  });

  it('reconnecting reactivates the same row, so history and mappings stay attached', async () => {
    const app = buildApp();
    const { partnerA, orgA, integration, threat } = await seedS1();
    const token = await partnerAdminToken(partnerA.id);
    expect((await call(app, token, 'DELETE', '/s1/integration')).status).toBe(200);

    // A reconnect must bring a new token: the old one is gone.
    const noToken = await call(app, token, 'POST', '/s1/integration', {
      name: 'S1 A again', managementUrl: 'https://usea1-test.sentinelone.net',
    });
    expect(noToken.status).toBe(400);

    const res = await call(app, token, 'POST', '/s1/integration', {
      name: 'S1 A again', managementUrl: 'https://usea1-test.sentinelone.net', apiToken: 's1-token-new',
    });
    expect(res.status).toBe(201);
    expect((await res.json()).data.id).toBe(integration.id);

    const tdb = getTestDb() as any;
    const rows = await tdb.select().from(s1Integrations).where(eq(s1Integrations.partnerId, partnerA.id));
    expect(rows).toHaveLength(1);
    expect(rows[0].isActive).toBe(true);
    expect(rows[0].apiTokenEncrypted).not.toBeNull();
    const [mapping] = await tdb.select().from(s1OrgMappings).where(eq(s1OrgMappings.integrationId, integration.id));
    expect(mapping.orgId).toBe(orgA.id);
    // The old site token is not revived; the next sync fetches a fresh one.
    expect(mapping.registrationToken).toBeNull();

    const listed = await (await call(app, token, 'GET', '/s1/threats')).json();
    expect(listed.data.map((t: { id: string }) => t.id)).toEqual([threat.id]);
    expect(listed.data[0].integrationDisconnected).toBe(false);
  });
});

describe('Huntress disconnect (#12691)', () => {
  it('another partner cannot disconnect it: 404, and the row keeps its secrets', async () => {
    const app = buildApp();
    const { partnerB, integration } = await seedHuntress();
    const tokenB = await partnerAdminToken(partnerB.id);
    const res = await call(app, tokenB, 'DELETE', '/huntress/integration');
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'No connected Huntress integration' });
    const [row] = await (getTestDb() as any).select().from(huntressIntegrations).where(eq(huntressIntegrations.id, integration.id));
    expect(row.isActive).toBe(true);
    expect(row.apiKeyEncrypted).not.toBeNull();
    expect(row.webhookSecretEncrypted).not.toBeNull();
  });

  it('an organization-scope user cannot disconnect it (403)', async () => {
    const app = buildApp();
    const { partnerA, orgA } = await seedHuntress();
    const token = await orgUserToken(partnerA.id, orgA.id);
    expect((await call(app, token, 'DELETE', '/huntress/integration')).status).toBe(403);
  });

  it('disconnect nulls every stored secret, keeps history labelled, and the webhook then refuses deliveries', async () => {
    const app = buildApp();
    const { partnerA, integration, incident } = await seedHuntress();
    const token = await partnerAdminToken(partnerA.id);

    // Control: the same signed delivery is accepted while connected.
    const before = await signedTestDelivery(app, integration.id, 'webhook-secret-a');
    expect(before.status).toBe(200);

    const res = await call(app, token, 'DELETE', '/huntress/integration');
    expect(res.status).toBe(200);

    const tdb = getTestDb() as any;
    const [row] = await tdb.select().from(huntressIntegrations).where(eq(huntressIntegrations.id, integration.id));
    expect(row.isActive).toBe(false);
    expect(row.apiKeyEncrypted).toBeNull();
    expect(row.accountKeyEncrypted).toBeNull();
    expect(row.webhookSecretEncrypted).toBeNull();
    const incidents = await tdb.select().from(huntressIncidents).where(eq(huntressIncidents.integrationId, integration.id));
    expect(incidents).toHaveLength(1);

    const after = await signedTestDelivery(app, integration.id, 'webhook-secret-a');
    expect(after.status).toBe(401);

    const listed = await (await call(app, token, 'GET', '/huntress/incidents')).json();
    expect(listed.data.map((i: { id: string }) => i.id)).toEqual([incident.id]);
    expect(listed.data[0].integrationDisconnected).toBe(true);
  });

  it('reconnecting reactivates the same row without reviving the old webhook secret or account key', async () => {
    const app = buildApp();
    const { partnerA, integration } = await seedHuntress();
    const token = await partnerAdminToken(partnerA.id);
    expect((await call(app, token, 'DELETE', '/huntress/integration')).status).toBe(200);

    const res = await call(app, token, 'POST', '/huntress/integration', { name: 'Huntress A again', apiKey: 'hk-new' });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.id).toBe(integration.id);
    expect(body.hasWebhookSecret).toBe(false);
    expect(body.hasAccountKey).toBe(false);

    const rows = await (getTestDb() as any).select().from(huntressIntegrations).where(eq(huntressIntegrations.partnerId, partnerA.id));
    expect(rows).toHaveLength(1);
    expect(rows[0].isActive).toBe(true);
    expect(rows[0].webhookSecretEncrypted).toBeNull();
    expect(rows[0].accountKeyEncrypted).toBeNull();

    // Active again, but the old signing secret is gone: its deliveries stay refused.
    expect((await signedTestDelivery(app, integration.id, 'webhook-secret-a')).status).toBe(401);

    // A secret entered on the reconnected integration works.
    const withSecret = await call(app, token, 'POST', '/huntress/integration', { name: 'Huntress A again', webhookSecret: 'webhook-secret-new' });
    expect(withSecret.status).toBe(200);
    expect((await signedTestDelivery(app, integration.id, 'webhook-secret-new')).status).toBe(200);
    expect((await signedTestDelivery(app, integration.id, 'webhook-secret-a')).status).toBe(401);
  });
});

describe('disconnect blast radius and gates (#12691)', () => {
  it('disconnecting partner A leaves partner B integrations and secrets untouched', async () => {
    const app = buildApp();
    const s1A = await seedS1Partner('a');
    const s1B = await seedS1Partner('b');
    const hA = await seedHuntressPartner('ha');
    const hB = await seedHuntressPartner('hb');
    const tdb = getTestDb() as any;

    expect((await call(app, await partnerAdminToken(s1A.partner.id), 'DELETE', '/s1/integration')).status).toBe(200);
    expect((await call(app, await partnerAdminToken(hA.partner.id), 'DELETE', '/huntress/integration')).status).toBe(200);

    const [s1Row] = await tdb.select().from(s1Integrations).where(eq(s1Integrations.id, s1B.integration.id));
    expect(s1Row.isActive).toBe(true);
    expect(s1Row.apiTokenEncrypted).not.toBeNull();
    const [s1Mapping] = await tdb.select().from(s1OrgMappings).where(eq(s1OrgMappings.integrationId, s1B.integration.id));
    expect(s1Mapping.registrationToken).not.toBeNull();
    const [hRow] = await tdb.select().from(huntressIntegrations).where(eq(huntressIntegrations.id, hB.integration.id));
    expect(hRow.isActive).toBe(true);
    expect(hRow.apiKeyEncrypted).not.toBeNull();
    expect(hRow.accountKeyEncrypted).not.toBeNull();
    expect(hRow.webhookSecretEncrypted).not.toBeNull();
  });

  it('partner B never lists partner A disconnected history', async () => {
    const app = buildApp();
    const s1A = await seedS1Partner('a');
    const s1B = await seedS1Partner('b');
    const hA = await seedHuntressPartner('ha');
    const hB = await seedHuntressPartner('hb');
    expect((await call(app, await partnerAdminToken(s1A.partner.id), 'DELETE', '/s1/integration')).status).toBe(200);
    expect((await call(app, await partnerAdminToken(hA.partner.id), 'DELETE', '/huntress/integration')).status).toBe(200);

    const threats = await (await call(app, await partnerAdminToken(s1B.partner.id), 'GET', '/s1/threats')).json();
    expect(threats.data.map((t: { id: string }) => t.id)).toEqual([s1B.threat.id]);
    const incidents = await (await call(app, await partnerAdminToken(hB.partner.id), 'GET', '/huntress/incidents')).json();
    expect(incidents.data.map((i: { id: string }) => i.id)).toEqual([hB.incident.id]);
  });

  it('labels history for an organization-scope reader too', async () => {
    const app = buildApp();
    const s1 = await seedS1Partner('a');
    const h = await seedHuntressPartner('ha');
    const s1OrgToken = await orgUserToken(s1.partner.id, s1.org.id);
    const hOrgToken = await orgUserToken(h.partner.id, h.org.id);

    const before = await (await call(app, s1OrgToken, 'GET', '/s1/threats')).json();
    expect(before.data.map((t: any) => [t.id, t.integrationDisconnected])).toEqual([[s1.threat.id, false]]);

    expect((await call(app, await partnerAdminToken(s1.partner.id), 'DELETE', '/s1/integration')).status).toBe(200);
    expect((await call(app, await partnerAdminToken(h.partner.id), 'DELETE', '/huntress/integration')).status).toBe(200);

    const s1Res = await call(app, s1OrgToken, 'GET', '/s1/threats');
    expect(s1Res.status).toBe(200);
    expect((await s1Res.json()).data.map((t: any) => [t.id, t.integrationDisconnected])).toEqual([[s1.threat.id, true]]);
    const hRes = await call(app, hOrgToken, 'GET', '/huntress/incidents');
    expect(hRes.status).toBe(200);
    expect((await hRes.json()).data.map((i: any) => [i.id, i.integrationDisconnected])).toEqual([[h.incident.id, true]]);
  });

  it('after disconnect, manual sync and threat actions are refused cleanly (404, not 500)', async () => {
    const app = buildApp();
    const s1 = await seedS1Partner('a');
    const h = await seedHuntressPartner('ha');
    const s1Token = await partnerAdminToken(s1.partner.id);
    const hToken = await partnerAdminToken(h.partner.id);
    expect((await call(app, s1Token, 'DELETE', '/s1/integration')).status).toBe(200);
    expect((await call(app, hToken, 'DELETE', '/huntress/integration')).status).toBe(200);

    expect((await call(app, s1Token, 'POST', '/s1/sync', {})).status).toBe(404);
    expect((await call(app, hToken, 'POST', '/huntress/sync', {})).status).toBe(404);
    const action = await call(app, s1Token, 'POST', '/s1/threat-action', {
      orgId: s1.org.id, action: 'quarantine', threatIds: [s1.threat.s1ThreatId],
    });
    expect(action.status).toBe(404);
  });

  it('a sync that fetched site tokens before the disconnect cannot write them back', async () => {
    const app = buildApp();
    const s1 = await seedS1Partner('a');
    expect((await call(app, await partnerAdminToken(s1.partner.id), 'DELETE', '/s1/integration')).status).toBe(200);

    await withSystemDbAccessContext(() => upsertDiscoveredSites({
      integrationId: s1.integration.id,
      partnerId: s1.partner.id,
      sites: [
        { siteId: 'site-a', siteName: 'Site a', count: 1, registrationToken: 'late-token' },
        { siteId: 'site-new', siteName: 'New site', count: 1, registrationToken: 'late-token-2' },
      ],
    }));

    const mappings = await (getTestDb() as any).select().from(s1OrgMappings).where(eq(s1OrgMappings.integrationId, s1.integration.id));
    expect(mappings).toHaveLength(2);
    expect(mappings.map((m: { registrationToken: string | null }) => m.registrationToken)).toEqual([null, null]);
  });

  it.each([
    ['without MFA', { mfa: false }],
    ['with selected-org partner access', { orgAccess: 'selected' as const }],
    ['without organizations.write', { permissions: [{ resource: 'organizations', action: 'read' }, { resource: 'devices', action: 'read' }] }],
  ])('a partner user %s cannot disconnect either integration, and nothing changes', async (_label, opts) => {
    const app = buildApp();
    const s1 = await seedS1Partner('a');
    const tdb = getTestDb() as any;
    const [huntress] = await tdb.insert(huntressIntegrations).values({
      partnerId: s1.partner.id,
      name: 'Huntress same partner',
      apiKeyEncrypted: encryptSecret('hk-same'),
      webhookSecretEncrypted: encryptSecret('webhook-secret-same'),
      isActive: true,
    }).returning();
    const token = await partnerAdminToken(s1.partner.id, opts);

    expect((await call(app, token, 'DELETE', '/s1/integration')).status).toBe(403);
    expect((await call(app, token, 'DELETE', '/huntress/integration')).status).toBe(403);

    const [s1Row] = await tdb.select().from(s1Integrations).where(eq(s1Integrations.id, s1.integration.id));
    expect(s1Row.isActive).toBe(true);
    expect(s1Row.apiTokenEncrypted).not.toBeNull();
    const [hRow] = await tdb.select().from(huntressIntegrations).where(eq(huntressIntegrations.id, huntress.id));
    expect(hRow.isActive).toBe(true);
    expect(hRow.webhookSecretEncrypted).not.toBeNull();
  });

  it("connecting partner B creates its own row and never reactivates partner A's disconnected one", async () => {
    const app = buildApp();
    const { partnerA, partnerB, integration } = await seedS1();
    expect((await call(app, await partnerAdminToken(partnerA.id), 'DELETE', '/s1/integration')).status).toBe(200);

    const res = await call(app, await partnerAdminToken(partnerB.id), 'POST', '/s1/integration', {
      name: 'S1 B', managementUrl: 'https://usea1-test.sentinelone.net', apiToken: 's1-token-b',
    });
    expect(res.status).toBe(201);
    const created = (await res.json()).data;
    expect(created.id).not.toBe(integration.id);
    expect(created.partnerId).toBe(partnerB.id);

    const [rowA] = await (getTestDb() as any).select().from(s1Integrations).where(eq(s1Integrations.id, integration.id));
    expect(rowA.isActive).toBe(false);
    expect(rowA.apiTokenEncrypted).toBeNull();
  });
});

describe('the disconnect service refuses a caller without full partner access by itself (#12691)', () => {
  // Called directly, with no route in front and under system DB context, so
  // neither a route gate nor RLS is the fence: only the service's own
  // capability check stands between the caller and the partner's secrets.
  const selectedMember = { scope: 'partner', partnerOrgAccess: 'selected' } as const;
  const fullAdmin = { scope: 'partner', partnerOrgAccess: 'all' } as const;
  const asSystem = <T>(fn: () => Promise<T>) => withSystemDbAccessContext(fn);

  it('SentinelOne: a selected-access partner member is refused and the row keeps its token and site tokens', async () => {
    const { partnerA, integration } = await seedS1();
    const tdb = getTestDb() as any;

    await expect(asSystem(() => disconnectS1Integration(selectedMember, partnerA.id)))
      .rejects.toThrow(PartnerWideWriteDeniedError);
    await expect(asSystem(() => clearS1SiteRegistrationTokens(selectedMember, integration.id, partnerA.id)))
      .rejects.toThrow(PartnerWideWriteDeniedError);

    const [row] = await tdb.select().from(s1Integrations).where(eq(s1Integrations.id, integration.id));
    expect(row.isActive).toBe(true);
    expect(row.apiTokenEncrypted).not.toBeNull();
    const mappings = await tdb.select().from(s1OrgMappings).where(eq(s1OrgMappings.integrationId, integration.id));
    expect(mappings).toHaveLength(1);
    expect(mappings[0].registrationToken).not.toBeNull();
  });

  it('SentinelOne control: a full partner admin through the same call disconnects', async () => {
    const { partnerA, integration } = await seedS1();
    const tdb = getTestDb() as any;

    await expect(asSystem(() => disconnectS1Integration(fullAdmin, partnerA.id)))
      .resolves.toMatchObject({ id: integration.id });

    const [row] = await tdb.select().from(s1Integrations).where(eq(s1Integrations.id, integration.id));
    expect(row.isActive).toBe(false);
    expect(row.apiTokenEncrypted).toBeNull();
    const [mapping] = await tdb.select().from(s1OrgMappings).where(eq(s1OrgMappings.integrationId, integration.id));
    expect(mapping.registrationToken).toBeNull();
  });

  it('SentinelOne reconnect: a refused token clear rolls the reactivation back with it', async () => {
    // The connect route runs the reactivation and the token clear in one
    // savepoint (writeOrActiveIndexConflict). A refusal from the clear must
    // undo the reactivation, not leave a live row with its old site tokens.
    const { partnerA, integration } = await seedS1();
    const tdb = getTestDb() as any;
    await tdb.update(s1Integrations).set({ isActive: false }).where(eq(s1Integrations.id, integration.id));

    await expect(asSystem(async () => {
      try {
        await writeOrActiveIndexConflict('s1_integrations_partner_active_idx', async () => {
          await db.update(s1Integrations)
            .set({ isActive: true, apiTokenEncrypted: encryptSecret('replacement-token') })
            .where(eq(s1Integrations.id, integration.id));
          await clearS1SiteRegistrationTokens(selectedMember, integration.id, partnerA.id);
        });
        return 'saved';
      } catch (error) {
        if (error instanceof PartnerWideWriteDeniedError) return 'denied';
        throw error;
      }
    })).resolves.toBe('denied');

    const [row] = await tdb.select().from(s1Integrations).where(eq(s1Integrations.id, integration.id));
    expect(row.isActive).toBe(false);
    expect(row.apiTokenEncrypted).toEqual(integration.apiTokenEncrypted);
    const [mapping] = await tdb.select().from(s1OrgMappings).where(eq(s1OrgMappings.integrationId, integration.id));
    expect(mapping.registrationToken).not.toBeNull();
  });

  it('Huntress: a selected-access partner member is refused and the row keeps every secret', async () => {
    const { partnerA, integration } = await seedHuntress();

    await expect(asSystem(() => disconnectHuntressIntegration(selectedMember, partnerA.id)))
      .rejects.toThrow(PartnerWideWriteDeniedError);

    const [row] = await (getTestDb() as any).select().from(huntressIntegrations).where(eq(huntressIntegrations.id, integration.id));
    expect(row.isActive).toBe(true);
    expect(row.apiKeyEncrypted).not.toBeNull();
    expect(row.accountKeyEncrypted).not.toBeNull();
    expect(row.webhookSecretEncrypted).not.toBeNull();
  });

  it('Huntress control: a full partner admin through the same call disconnects', async () => {
    const { partnerA, integration } = await seedHuntress();

    await expect(asSystem(() => disconnectHuntressIntegration(fullAdmin, partnerA.id)))
      .resolves.toMatchObject({ id: integration.id });

    const [row] = await (getTestDb() as any).select().from(huntressIntegrations).where(eq(huntressIntegrations.id, integration.id));
    expect(row.isActive).toBe(false);
    expect(row.apiKeyEncrypted).toBeNull();
  });
});
