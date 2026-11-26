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

async function partnerAdminToken(partnerId: string): Promise<string> {
  const role = await createRole({ scope: 'partner', partnerId });
  await grantRolePermissions(role.id, ALL);
  const user = await createUser({ partnerId, orgId: null, email: `pa-${randomUUID().slice(0, 8)}@example.test` });
  await assignUserToPartner(user.id, partnerId, role.id, 'all');
  return createAccessToken({
    sub: user.id, email: user.email, roleId: role.id, orgId: null, partnerId,
    scope: 'partner', mfa: true, aep: 1, mep: 1, sid: randomUUID(),
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

async function seedS1() {
  const tdb = getTestDb() as any;
  const partnerA = await createPartner();
  const orgA = await createOrganization({ partnerId: partnerA.id });
  const partnerB = await createPartner();
  const orgB = await createOrganization({ partnerId: partnerB.id });
  const [integration] = await tdb.insert(s1Integrations).values({
    partnerId: partnerA.id,
    name: 'S1 A',
    apiTokenEncrypted: encryptSecret('s1-token-a'),
    managementUrl: 'https://usea1-test.sentinelone.net',
    isActive: true,
  }).returning();
  await tdb.insert(s1OrgMappings).values({
    integrationId: integration.id,
    partnerId: partnerA.id,
    s1SiteId: 'site-a',
    s1SiteName: 'Site A',
    orgId: orgA.id,
    registrationToken: encryptSecret('reg-token-a', { aad: 's1_org_mappings.registration_token' }),
  });
  const [threat] = await tdb.insert(s1Threats).values({
    orgId: orgA.id,
    integrationId: integration.id,
    s1ThreatId: 'threat-a',
    threatName: 'EICAR',
    status: 'active',
    detectedAt: new Date(),
  }).returning();
  return { partnerA, orgA, partnerB, orgB, integration, threat };
}

async function seedHuntress() {
  const tdb = getTestDb() as any;
  const partnerA = await createPartner();
  const orgA = await createOrganization({ partnerId: partnerA.id });
  const partnerB = await createPartner();
  const [integration] = await tdb.insert(huntressIntegrations).values({
    partnerId: partnerA.id,
    name: 'Huntress A',
    apiKeyEncrypted: encryptSecret('hk-a'),
    accountId: 'acct-a',
    accountKeyEncrypted: encryptSecret('acct-key-a', { aad: 'huntress_integrations.account_key_encrypted' }),
    webhookSecretEncrypted: encryptSecret('webhook-secret-a'),
    isActive: true,
  }).returning();
  await tdb.insert(huntressOrgMappings).values({
    integrationId: integration.id,
    partnerId: partnerA.id,
    huntressOrgId: 'h-org-a',
    huntressOrgName: 'Customer A',
    orgId: orgA.id,
  });
  const [incident] = await tdb.insert(huntressIncidents).values({
    orgId: orgA.id,
    integrationId: integration.id,
    huntressIncidentId: 'inc-a',
    title: 'Footholds found',
    status: 'open',
    reportedAt: new Date(),
  }).returning();
  return { partnerA, orgA, partnerB, integration, incident };
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
  });
});
