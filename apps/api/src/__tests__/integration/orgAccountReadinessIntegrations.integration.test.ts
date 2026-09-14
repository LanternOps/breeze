/**
 * W03 account-board integration matrix (spec Testing: "W03 adds the
 * mapping/connector matrix"). One partner P is seeded with every source in
 * every state across four orgs; a foreign partner Q proves nothing of Q's leaks
 * into P's response. Requests go through the real route with a partner-scope
 * token, so every read runs as breeze_app under forced RLS.
 */
import './setup';
import { randomUUID } from 'crypto';
import { and, eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  accountingConnections,
  accountingEntityMappings,
  backupConfigs,
  contracts,
  dnsFilterIntegrations,
  huntressIntegrations,
  huntressOrgMappings,
  m365Connections,
  organizationExternalLinks,
  pax8CompanyMappings,
  pax8Integrations,
  psaConnections,
  s1Integrations,
  s1OrgMappings,
} from '../../db/schema';
import { createAccessToken } from '../../services/jwt';
import { PERMISSIONS } from '../../services/permissions';
import { orgAccountReadinessRoutes } from '../../routes/orgAccountReadiness';
import {
  assignUserToPartner,
  createIntegrationTestClient,
  createOrganization,
  createPartner,
  createRole,
  createUser,
  grantRolePermissions,
} from './db-utils';
import { getTestDb } from './setup';

const runDb = describe.runIf(!!process.env.DATABASE_URL);

const FULL_GRANTS = [
  PERMISSIONS.ORGS_READ,
  PERMISSIONS.CONNECTED_APPS_READ,
  PERMISSIONS.ACCOUNTING_READ,
  PERMISSIONS.BILLING_MANAGE,
  PERMISSIONS.CONTRACTS_READ,
  PERMISSIONS.BACKUP_READ,
];

function buildApp(): Hono {
  const app = new Hono();
  app.route('/api/v1/orgs', orgAccountReadinessRoutes);
  return app;
}

interface Badge { system: string; state: string; reason?: string; label?: string }
interface ReadinessBody {
  capabilities: Record<string, boolean>;
  connectors?: Array<{ system: string; state: string; provider?: string }>;
  orgs: Array<{
    orgId: string;
    integrations?: Badge[];
    account: { activeContracts?: number };
    setup: { backupApplicable?: boolean; backupConfigured?: boolean };
  }>;
}

/** A second partner-scope token for the SAME partner with a narrower role. */
async function tokenFor(partnerId: string, grants: Array<{ resource: string; action: string }>): Promise<string> {
  const user = await createUser({ partnerId, orgId: null });
  const role = await createRole({ scope: 'partner', partnerId });
  await grantRolePermissions(role.id, grants);
  await assignUserToPartner(user.id, partnerId, role.id, 'all');
  return createAccessToken({
    sub: user.id, email: user.email, roleId: role.id, orgId: null, partnerId,
    scope: 'partner', mfa: false, aep: 1, mep: 1, sid: randomUUID(),
  });
}

runDb('GET /orgs/account-readiness — W03 integrations, contracts, backup', () => {
  const app = buildApp();
  let client: Awaited<ReturnType<typeof createIntegrationTestClient>>;
  let partnerId: string;
  let linked: string;   // everything linked and healthy
  let pending: string;  // every pending shape
  let broken: string;   // every error shape
  let bare: string;     // nothing at all (the client's own org)
  let foreignPartnerId: string;
  let foreignOrg: string;

  async function fetchBoard(token: string, orgIds: string[]): Promise<ReadinessBody> {
    const res = await app.request(`/api/v1/orgs/account-readiness?orgIds=${orgIds.join(',')}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(200);
    return (await res.json()) as ReadinessBody;
  }

  function badges(body: ReadinessBody, orgId: string): Badge[] {
    const row = body.orgs.find((o) => o.orgId === orgId);
    if (!row) throw new Error(`org ${orgId} missing from response`);
    return row.integrations ?? [];
  }

  // NOTE (deviation from the plan's literal `beforeAll`): setup.ts registers a
  // root-level `beforeEach(cleanupDatabase)` (TRUNCATE CASCADE on partners/
  // organizations/users/… — see setup.ts CLEANUP_TABLES) that runs before
  // EVERY test in every file that imports './setup'. Hook execution order
  // (root beforeEach runs immediately before each test, AFTER any nested
  // describe's one-time beforeAll has already fired) means a nested `beforeAll`
  // here would seed once and then have that seed wiped by the root beforeEach
  // before test 1 even ran — every `it()` below saw an empty DB (401s / FK
  // violations on the plan's literal code). Reseeding in a nested `beforeEach`
  // is this repo's established pattern for per-test-isolated fixtures (e.g.
  // agentIntentConstraints.integration.test.ts) and runs AFTER the root
  // truncate, so each test gets a fresh copy of the same dataset.
  beforeEach(async () => {
    client = await createIntegrationTestClient(app, { scope: 'partner', rolePermissions: FULL_GRANTS });
    partnerId = client.env.partner.id;
    bare = client.env.organization.id;
    linked = (await createOrganization({ partnerId, name: 'Linked Co' })).id;
    pending = (await createOrganization({ partnerId, name: 'Pending Co' })).id;
    broken = (await createOrganization({ partnerId, name: 'Broken Co' })).id;

    const db = getTestDb();

    // --- Accounting: one connected QuickBooks realm; confirmed+synced, suggested, unlinked, sync error
    const [qbo] = await db.insert(accountingConnections)
      .values({ partnerId, provider: 'quickbooks', environment: 'sandbox', status: 'connected' })
      .returning({ id: accountingConnections.id });
    if (!qbo) throw new Error('failed to seed accounting connection');
    await db.insert(accountingEntityMappings).values([
      { integrationId: qbo.id, partnerId, breezeEntityType: 'org', breezeEntityId: linked, remoteEntityType: 'Customer', remoteEntityId: 'cust-linked', linkStatus: 'confirmed', syncStatus: 'synced' },
      { integrationId: qbo.id, partnerId, breezeEntityType: 'org', breezeEntityId: pending, remoteEntityType: 'Customer', remoteEntityId: 'cust-pending', linkStatus: 'suggested', syncStatus: 'pending' },
      { integrationId: qbo.id, partnerId, breezeEntityType: 'org', breezeEntityId: broken, remoteEntityType: 'Customer', remoteEntityId: 'cust-broken', linkStatus: 'confirmed', syncStatus: 'error', lastError: 'QBO 400' },
      { integrationId: qbo.id, partnerId, breezeEntityType: 'org', breezeEntityId: bare, remoteEntityType: 'Customer', remoteEntityId: 'cust-bare', linkStatus: 'unlinked', syncStatus: 'pending' },
    ]);

    // --- PSA: partner-level ConnectWise enabled + link on `linked`; org-level disabled Jira on `broken`; a Datto identity link on `linked`
    await db.insert(psaConnections).values([
      { partnerId, orgId: null, provider: 'connectwise', name: 'CW', credentials: {}, enabled: true },
      { partnerId: null, orgId: broken, provider: 'jira', name: 'Jira', credentials: {}, enabled: false },
    ]);
    await db.insert(organizationExternalLinks).values([
      { orgId: linked, partnerId, system: 'connectwise', externalId: 'cw-1' },
      { orgId: linked, partnerId, system: 'datto_rmm', externalId: 'datto-1' },
    ]);

    // --- Pax8: an INACTIVE integration mapping `pending` (must be ignored) and the ACTIVE one mapping `linked`
    const [pax8Old] = await db.insert(pax8Integrations)
      .values({ partnerId, name: 'Pax8 old', clientIdEncrypted: 'x', clientSecretEncrypted: 'y', tokenUrl: 'https://login.pax8.com/oauth/token', isActive: false, lastSyncStatus: 'success' })
      .returning({ id: pax8Integrations.id });
    const [pax8Live] = await db.insert(pax8Integrations)
      .values({ partnerId, name: 'Pax8', clientIdEncrypted: 'x', clientSecretEncrypted: 'y', tokenUrl: 'https://login.pax8.com/oauth/token', isActive: true, lastSyncStatus: 'success' })
      .returning({ id: pax8Integrations.id });
    if (!pax8Old || !pax8Live) throw new Error('failed to seed pax8 integrations');
    await db.insert(pax8CompanyMappings).values([
      { integrationId: pax8Old.id, partnerId, pax8CompanyId: 'c-old', pax8CompanyName: 'Old', orgId: pending, ignored: false },
      { integrationId: pax8Live.id, partnerId, pax8CompanyId: 'c-live', pax8CompanyName: 'Live', orgId: linked, ignored: false },
      { integrationId: pax8Live.id, partnerId, pax8CompanyId: 'c-ignored', pax8CompanyName: 'Ignored', orgId: broken, ignored: true },
    ]);

    // --- Microsoft 365: two profiles on `linked` (active + degraded → worst wins), consent pending on `pending`, a revoked row on `bare`
    // m365_connections_credential_location_check (2026-08-06-f-m365-comms-delegated.sql): a non-legacy-direct
    // profile with client_secret NULL must prove a credential either via vault_ref+credential_version, or via the
    // delegated pending-consent/verifying branch. These rows use application-certificate auth (not delegated), so
    // they take the vault_ref branch — plan's literal m365Base lacked these and fails the CHECK.
    const m365Base = {
      clientId: 'client-1',
      authMode: 'application-certificate' as const,
      credentialDomain: 'customer-graph-read' as const,
      vaultRef: 'vault://m365/test',
      credentialVersion: '1',
      // m365_connections_manifest_version_check: any non-legacy-direct profile needs >= 1 (column defaults to 0).
      permissionManifestVersion: 1,
    };
    await db.insert(m365Connections).values([
      // m365_connections_graph_read_consent_check requires consent_attempt_id
      // for profile 'customer-graph-read'; m365_connections_profile_binding_check
      // requires credential_domain = 'customer-graph-actions' for that profile.
      { ...m365Base, orgId: linked, profile: 'customer-graph-read', status: 'active', consentAttemptId: randomUUID() },
      { ...m365Base, orgId: linked, profile: 'customer-graph-actions', credentialDomain: 'customer-graph-actions', status: 'degraded' },
      { ...m365Base, orgId: pending, profile: 'customer-graph-read', status: 'pending-consent', consentAttemptId: randomUUID() },
      { ...m365Base, orgId: bare, profile: 'customer-graph-read', status: 'revoked', consentAttemptId: randomUUID(), revokedAt: new Date() },
    ]);

    // --- DNS filter: never synced on `pending`, success on `linked`, error on `broken`, inactive on `bare`
    await db.insert(dnsFilterIntegrations).values([
      { orgId: pending, provider: 'pihole', name: 'PH', isActive: true, lastSyncStatus: null },
      { orgId: linked, provider: 'pihole', name: 'PH', isActive: true, lastSyncStatus: 'success' },
      { orgId: broken, provider: 'pihole', name: 'PH', isActive: true, lastSyncStatus: 'error', lastSyncError: 'timeout' },
      { orgId: bare, provider: 'pihole', name: 'PH', isActive: false, lastSyncStatus: null },
    ]);

    // --- Huntress: the partner's only integration is INACTIVE → connector disabled, mapping connector_error
    const [huntress] = await db.insert(huntressIntegrations)
      .values({ partnerId, name: 'Huntress', apiKeyEncrypted: 'k', isActive: false, lastSyncStatus: 'success' })
      .returning({ id: huntressIntegrations.id });
    if (!huntress) throw new Error('failed to seed huntress integration');
    await db.insert(huntressOrgMappings).values({ integrationId: huntress.id, partnerId, huntressOrgId: 'h-1', orgId: broken });

    // --- SentinelOne: active, synced → linked on `linked`; never synced would be pending (covered by unit tests)
    const [s1] = await db.insert(s1Integrations)
      .values({ partnerId, name: 'S1', apiTokenEncrypted: 't', managementUrl: 'https://example.sentinelone.net', isActive: true, lastSyncStatus: 'success' })
      .returning({ id: s1Integrations.id });
    if (!s1) throw new Error('failed to seed sentinelone integration');
    await db.insert(s1OrgMappings).values({ integrationId: s1.id, partnerId, s1SiteId: 's-1', orgId: linked });

    // --- Contracts: evergreen active on `linked`; expired active on `pending`; paused on `broken`
    await db.insert(contracts).values([
      { partnerId, orgId: linked, name: 'MSA', status: 'active', intervalMonths: 1, startDate: '2026-01-01', endDate: null, currencyCode: 'USD' },
      { partnerId, orgId: pending, name: 'Old MSA', status: 'active', intervalMonths: 1, startDate: '2025-01-01', endDate: '2025-12-31', currencyCode: 'USD' },
      { partnerId, orgId: broken, name: 'Paused', status: 'paused', intervalMonths: 1, startDate: '2026-01-01', endDate: null, currencyCode: 'USD' },
    ]);

    // --- Backup: one active config on `linked` makes backup applicable partner-wide
    await db.insert(backupConfigs).values({ orgId: linked, name: 'Local', type: 'file', provider: 'local', providerConfig: {}, isActive: true });

    // --- Foreign partner Q with its own connector, mapping, Pax8 and Huntress
    const q = await createPartner({ name: 'Foreign Partner' });
    foreignPartnerId = q.id;
    foreignOrg = (await createOrganization({ partnerId: q.id, name: 'Foreign Co' })).id;
    const [qConn] = await db.insert(accountingConnections)
      .values({ partnerId: q.id, provider: 'xero', environment: 'sandbox', status: 'reauth_required' })
      .returning({ id: accountingConnections.id });
    if (!qConn) throw new Error('failed to seed foreign accounting connection');
    await db.insert(accountingEntityMappings).values({
      integrationId: qConn.id, partnerId: q.id, breezeEntityType: 'org', breezeEntityId: foreignOrg,
      remoteEntityType: 'Customer', remoteEntityId: 'xero-1', linkStatus: 'confirmed', syncStatus: 'synced',
    });
    await db.insert(pax8Integrations).values({ partnerId: q.id, name: 'Q Pax8', clientIdEncrypted: 'x', clientSecretEncrypted: 'y', tokenUrl: 'https://login.pax8.com/oauth/token', isActive: true, lastSyncStatus: 'failed' });
  });

  it('reports every connector of the partner once, and none of the foreign partner', async () => {
    const body = await fetchBoard(client.token, [linked, pending, broken, bare]);
    expect(body.capabilities).toMatchObject({ integrations: true, contracts: true, backup: true });
    expect(body.connectors).toEqual(
      expect.arrayContaining([
        { system: 'quickbooks', state: 'connected' },
        { system: 'psa', state: 'connected', provider: 'connectwise' },
        { system: 'pax8', state: 'connected' },
        { system: 'huntress', state: 'disabled' },
        { system: 'sentinelone', state: 'connected' },
      ]),
    );
    expect(body.connectors).toHaveLength(5);
    expect(body.connectors!.some((c) => c.system === 'xero')).toBe(false);
  });

  it('linked org: confirmed+synced, PSA via link, Pax8 under the active integration, M365 worst-state, DNS success, S1 synced, Datto identity', async () => {
    const body = await fetchBoard(client.token, [linked]);
    expect(badges(body, linked)).toEqual([
      { system: 'quickbooks', state: 'linked' },
      { system: 'psa', state: 'linked' },
      { system: 'pax8', state: 'linked' },
      { system: 'm365', state: 'error', reason: 'degraded' },
      { system: 'dns_filter', state: 'linked' },
      { system: 'sentinelone', state: 'linked' },
      { system: 'external', state: 'identity', label: 'datto_rmm' },
    ]);
  });

  it('pending org: suggested match, consent pending, DNS never synced; the inactive Pax8 integration is ignored', async () => {
    const body = await fetchBoard(client.token, [pending]);
    expect(badges(body, pending)).toEqual([
      { system: 'quickbooks', state: 'pending', reason: 'suggested_match' },
      { system: 'm365', state: 'pending', reason: 'consent_pending' },
      { system: 'dns_filter', state: 'pending', reason: 'never_synced' },
    ]);
  });

  it('broken org: accounting sync error, disabled org-level PSA, DNS error, Huntress under an inactive parent; ignored Pax8 mapping absent', async () => {
    const body = await fetchBoard(client.token, [broken]);
    expect(badges(body, broken)).toEqual([
      { system: 'quickbooks', state: 'error', reason: 'sync_error' },
      { system: 'psa', state: 'error', reason: 'disabled' },
      { system: 'dns_filter', state: 'error', reason: 'sync_error' },
      { system: 'huntress', state: 'error', reason: 'connector_error' },
    ]);
  });

  it('bare org: an unlinked mapping, a revoked M365 row and an inactive DNS integration produce no badges', async () => {
    const body = await fetchBoard(client.token, [bare]);
    expect(badges(body, bare)).toEqual([]);
  });

  it('the foreign partner\'s org is dropped from P\'s response entirely (accepted-id resolution), and Q sees only its own mapping', async () => {
    const body = await fetchBoard(client.token, [linked, foreignOrg]);
    expect(body.orgs.map((o) => o.orgId)).toEqual([linked]);

    const qToken = await tokenFor(foreignPartnerId, FULL_GRANTS);
    const qBody = await fetchBoard(qToken, [foreignOrg]);
    expect(qBody.connectors).toEqual(expect.arrayContaining([{ system: 'xero', state: 'reauth_required' }, { system: 'pax8', state: 'error' }]));
    expect(badges(qBody, foreignOrg)).toEqual([{ system: 'xero', state: 'linked' }]);
  });

  it('Pax8 sync failure flips the connector to error and every mapped org to sync_failed', async () => {
    await getTestDb()
      .update(pax8Integrations)
      .set({ lastSyncStatus: 'failed' })
      .where(and(eq(pax8Integrations.partnerId, partnerId), eq(pax8Integrations.isActive, true)));
    const body = await fetchBoard(client.token, [linked]);
    expect(body.connectors).toEqual(expect.arrayContaining([{ system: 'pax8', state: 'error' }]));
    expect(badges(body, linked)).toEqual(expect.arrayContaining([{ system: 'pax8', state: 'error', reason: 'sync_failed' }]));
  });

  it('active contracts: evergreen counts, an ended term does not, paused does not', async () => {
    const body = await fetchBoard(client.token, [linked, pending, broken]);
    const byOrg = new Map(body.orgs.map((o) => [o.orgId, o.account.activeContracts]));
    expect(byOrg.get(linked)).toBe(1);
    expect(byOrg.get(pending)).toBe(0);
    expect(byOrg.get(broken)).toBe(0);
  });

  it('backup: applicable partner-wide because one org has an active config; only that org is configured', async () => {
    const body = await fetchBoard(client.token, [linked, bare]);
    const rows = new Map(body.orgs.map((o) => [o.orgId, o.setup]));
    expect(rows.get(linked)).toMatchObject({ backupApplicable: true, backupConfigured: true });
    expect(rows.get(bare)).toMatchObject({ backupApplicable: true, backupConfigured: false });
  });

  it('a caller without connected_apps:read gets no connectors and no integrations; without accounting:read no QuickBooks; without billing:manage no Pax8', async () => {
    const noApps = await fetchBoard(await tokenFor(partnerId, [PERMISSIONS.ORGS_READ, PERMISSIONS.CONTRACTS_READ, PERMISSIONS.BACKUP_READ]), [linked]);
    expect(noApps.capabilities.integrations).toBe(false);
    expect(noApps).not.toHaveProperty('connectors');
    expect(noApps.orgs[0]).not.toHaveProperty('integrations');
    expect(noApps.capabilities.contracts).toBe(true);
    expect(noApps.capabilities.backup).toBe(true);

    const appsOnly = await fetchBoard(await tokenFor(partnerId, [PERMISSIONS.ORGS_READ, PERMISSIONS.CONNECTED_APPS_READ]), [linked]);
    expect(appsOnly.capabilities).toMatchObject({ integrations: true, contracts: false, backup: false });
    expect(appsOnly.connectors!.map((c) => c.system).sort()).toEqual(['huntress', 'psa', 'sentinelone']);
    expect(badges(appsOnly, linked).map((b) => b.system)).toEqual(['psa', 'm365', 'dns_filter', 'sentinelone', 'external']);
    expect(appsOnly.orgs[0]!.account).not.toHaveProperty('activeContracts');
    expect(appsOnly.orgs[0]!.setup).not.toHaveProperty('backupApplicable');
  });
});
