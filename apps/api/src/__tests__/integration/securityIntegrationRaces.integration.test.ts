/**
 * #12691 — races between disconnect and the other writers of a SentinelOne or
 * Huntress integration, on real Postgres. Routes run as the unprivileged
 * `breeze_app` role through the real middleware; the competing transaction is
 * held open on a separate connection and released only once the request or
 * sync under test is seen waiting on its lock (pg_stat_activity), so every
 * interleaving is forced, not timed.
 *
 * The vendor clients are replaced with fakes: no network call is made, and a
 * fake can run a disconnect "while the vendor call is in flight".
 *
 * Run (needs `pnpm test-stack up`):
 *   cd apps/api && npx vitest run --config vitest.integration.config.ts \
 *     src/__tests__/integration/securityIntegrationRaces.integration.test.ts
 */
import './setup';
import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { eq, sql } from 'drizzle-orm';

const s1Fake = vi.hoisted(() => ({
  agents: [] as unknown[],
  onListThreats: null as null | (() => Promise<void>),
}));
const huntressFake = vi.hoisted(() => ({
  onListOrganizations: null as null | (() => Promise<void>),
}));

vi.mock('../../services/sentinelOne/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../services/sentinelOne/client')>();
  class FakeSentinelOneClient {
    async listAgents() { return { results: s1Fake.agents, truncated: false }; }
    async listSites() { return []; }
    async listThreats() {
      if (s1Fake.onListThreats) await s1Fake.onListThreats();
      return { results: [], truncated: false };
    }
  }
  return { ...actual, SentinelOneClient: FakeSentinelOneClient };
});

vi.mock('../../services/huntressClient', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../services/huntressClient')>();
  class FakeHuntressClient {
    async listOrganizations() {
      if (huntressFake.onListOrganizations) await huntressFake.onListOrganizations();
      return [];
    }
    async listAgents() { return []; }
    async listIncidents() { return []; }
  }
  return { ...actual, HuntressClient: FakeHuntressClient };
});

// The routes enqueue a sync after a connect; no worker runs here.
vi.mock('../../jobs/s1Sync', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../jobs/s1Sync')>();
  return { ...actual, scheduleS1Sync: vi.fn().mockResolvedValue('job-s1') };
});
vi.mock('../../jobs/huntressSync', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../jobs/huntressSync')>();
  return { ...actual, scheduleHuntressSync: vi.fn().mockResolvedValue('job-huntress') };
});

import { sentinelOneRoutes } from '../../routes/sentinelOne';
import { huntressRoutes } from '../../routes/huntress';
import { huntressIntegrations, s1Integrations, s1OrgMappings } from '../../db/schema';
import { encryptSecret, decryptSecret } from '../../services/secretCrypto';
import { processSyncIntegration as processS1SyncIntegration } from '../../jobs/s1Sync';
import { syncIntegrationById as syncHuntressIntegrationById } from '../../jobs/huntressSync';
import { createAccessToken } from '../../services/jwt';
import {
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

async function partnerAdminToken(partnerId: string): Promise<string> {
  const role = await createRole({ scope: 'partner', partnerId });
  await grantRolePermissions(role.id, [{ resource: '*', action: '*' }]);
  const user = await createUser({ partnerId, orgId: null, email: `pa-${randomUUID().slice(0, 8)}@example.test` });
  await assignUserToPartner(user.id, partnerId, role.id, 'all');
  return createAccessToken({
    sub: user.id, email: user.email, roleId: role.id, orgId: null, partnerId,
    scope: 'partner', mfa: true, aep: 1, mep: 1, sid: randomUUID(),
  });
}

function call(app: Hono, token: string, method: string, path: string, body?: unknown) {
  return app.request(path, {
    method,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

const S1_URL = 'https://usea1-test.sentinelone.net';

async function seedS1(opts: { active?: boolean; provisionalSite?: string } = {}) {
  const tdb = getTestDb() as any;
  const partner = await createPartner();
  const org = await createOrganization({ partnerId: partner.id });
  const [integration] = await tdb.insert(s1Integrations).values({
    partnerId: partner.id,
    name: 'S1 old',
    apiTokenEncrypted: encryptSecret('s1-token-old'),
    managementUrl: S1_URL,
    isActive: opts.active ?? true,
  }).returning();
  await tdb.insert(s1OrgMappings).values({
    integrationId: integration.id,
    partnerId: partner.id,
    s1SiteId: opts.provisionalSite ? `name:${opts.provisionalSite}` : 'site-1',
    s1SiteName: opts.provisionalSite ?? 'Site 1',
    orgId: org.id,
    registrationToken: encryptSecret('reg-token-old', { aad: 's1_org_mappings.registration_token' }),
    ...(opts.provisionalSite ? { metadata: { provisional: true } } : {}),
  });
  return { partner, org, integration };
}

async function seedHuntress(opts: { active?: boolean } = {}) {
  const tdb = getTestDb() as any;
  const partner = await createPartner();
  const [integration] = await tdb.insert(huntressIntegrations).values({
    partnerId: partner.id,
    name: 'Huntress old',
    apiKeyEncrypted: encryptSecret('hk-old'),
    accountId: 'acct-old',
    accountKeyEncrypted: encryptSecret('acct-key-old', { aad: 'huntress_integrations.account_key_encrypted' }),
    webhookSecretEncrypted: encryptSecret('webhook-secret-old'),
    isActive: opts.active ?? true,
  }).returning();
  return { partner, integration };
}

/**
 * Run `fn` in a transaction on the test (owner) connection and keep it open
 * until `release()` is called. `ready` resolves once `fn` has run, so its row
 * locks are held; `run()` executes one more statement inside it.
 */
function holdTransaction(fn: (tx: any) => Promise<void>) {
  let release!: () => void;
  const released = new Promise<void>((resolve) => { release = resolve; });
  let markReady!: (tx: any) => void;
  let failReady!: (err: unknown) => void;
  const readyTx = new Promise<any>((resolve, reject) => { markReady = resolve; failReady = reject; });
  const done = (getTestDb() as any).transaction(async (tx: any) => {
    try {
      await fn(tx);
    } catch (err) {
      failReady(err);
      throw err;
    }
    markReady(tx);
    await released;
  });
  done.catch(() => undefined);
  return {
    ready: readyTx.then(() => undefined),
    release,
    done: done as Promise<void>,
    run: async (statement: ReturnType<typeof sql>) => (await readyTx).execute(statement),
  };
}

/** Wait until `count` other backends are blocked on a row or tuple lock while running a statement on `table`. */
async function waitForLockWaiters(table: string, count = 1): Promise<void> {
  const deadline = Date.now() + 15_000;
  for (;;) {
    const rows = await (getTestDb() as any).execute(sql`
      SELECT count(*)::int AS n FROM pg_stat_activity
      WHERE datname = current_database()
        AND pid <> pg_backend_pid()
        AND wait_event_type = 'Lock'
        AND query ILIKE ${`%${table}%`}
    `);
    const n = Number((rows.rows ?? rows)[0]?.n ?? 0);
    if (n >= count) return;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${count} lock waiter(s) on ${table} (saw ${n})`);
    await new Promise((resolve) => setImmediate(resolve));
  }
}

const disconnectS1Sql = (id: string) => sql`
  UPDATE s1_integrations SET is_active = false, api_token_encrypted = NULL, updated_at = now() WHERE id = ${id}`;
const clearS1SiteTokensSql = (id: string) => sql`
  UPDATE s1_org_mappings SET registration_token = NULL, updated_at = now() WHERE integration_id = ${id}`;
const disconnectHuntressSql = (id: string) => sql`
  UPDATE huntress_integrations
     SET is_active = false, api_key_encrypted = NULL, account_key_encrypted = NULL,
         webhook_secret_encrypted = NULL, updated_at = now()
   WHERE id = ${id}`;

describe('an edit racing a disconnect never reactivates or repopulates the row (#12691)', () => {
  it('SentinelOne: the edit that read the row before the disconnect committed answers 409; the row stays disconnected', async () => {
    const app = buildApp();
    const { partner, integration } = await seedS1();
    const token = await partnerAdminToken(partner.id);

    const disconnect = holdTransaction(async (tx) => {
      await tx.execute(disconnectS1Sql(integration.id));
      await tx.execute(clearS1SiteTokensSql(integration.id));
    });
    await disconnect.ready;
    // The edit carries no token: it keeps the stored one.
    const edit = call(app, token, 'POST', '/s1/integration', { name: 'S1 renamed', managementUrl: S1_URL });
    await waitForLockWaiters('s1_integrations');
    disconnect.release();
    await disconnect.done;

    const res = await edit;
    expect(res.status).toBe(409);
    const [row] = await (getTestDb() as any).select().from(s1Integrations).where(eq(s1Integrations.id, integration.id));
    expect(row.isActive).toBe(false);
    expect(row.apiTokenEncrypted).toBeNull();
    expect(row.name).toBe('S1 old');
  });

  it('Huntress: the edit answers 409 and writes none of the old secrets back', async () => {
    const app = buildApp();
    const { partner, integration } = await seedHuntress();
    const token = await partnerAdminToken(partner.id);

    const disconnect = holdTransaction(async (tx) => { await tx.execute(disconnectHuntressSql(integration.id)); });
    await disconnect.ready;
    const edit = call(app, token, 'POST', '/huntress/integration', { name: 'Huntress renamed' });
    await waitForLockWaiters('huntress_integrations');
    disconnect.release();
    await disconnect.done;

    const res = await edit;
    expect(res.status).toBe(409);
    const [row] = await (getTestDb() as any).select().from(huntressIntegrations).where(eq(huntressIntegrations.id, integration.id));
    expect(row.isActive).toBe(false);
    expect(row.apiKeyEncrypted).toBeNull();
    expect(row.accountKeyEncrypted).toBeNull();
    expect(row.webhookSecretEncrypted).toBeNull();
    expect(row.name).toBe('Huntress old');
  });

  it('an edit that waits behind an edit still applies (control: the lock does not refuse ordinary edits)', async () => {
    const app = buildApp();
    const { partner, integration } = await seedHuntress();
    const token = await partnerAdminToken(partner.id);

    const other = holdTransaction(async (tx) => {
      await tx.execute(sql`UPDATE huntress_integrations SET name = 'Huntress other' WHERE id = ${integration.id}`);
    });
    await other.ready;
    const edit = call(app, token, 'POST', '/huntress/integration', { name: 'Huntress renamed' });
    await waitForLockWaiters('huntress_integrations');
    other.release();
    await other.done;

    expect((await edit).status).toBe(200);
    const [row] = await (getTestDb() as any).select().from(huntressIntegrations).where(eq(huntressIntegrations.id, integration.id));
    expect(row.isActive).toBe(true);
    expect(row.name).toBe('Huntress renamed');
    expect(decryptSecret(row.apiKeyEncrypted)).toBe('hk-old');
  });
});

describe('reconnect clears old SentinelOne site tokens (#12691)', () => {
  it('a row deactivated with its site tokens still stored comes back with none', async () => {
    const app = buildApp();
    // Deactivated the old way: inactive, but token and site tokens kept.
    const { partner, integration } = await seedS1({ active: false });
    const token = await partnerAdminToken(partner.id);

    const res = await call(app, token, 'POST', '/s1/integration', {
      name: 'S1 back', managementUrl: S1_URL, apiToken: 's1-token-new',
    });
    expect(res.status).toBe(201);
    expect((await res.json()).data.id).toBe(integration.id);

    const tdb = getTestDb() as any;
    const [row] = await tdb.select().from(s1Integrations).where(eq(s1Integrations.id, integration.id));
    expect(row.isActive).toBe(true);
    expect(decryptSecret(row.apiTokenEncrypted)).toBe('s1-token-new');
    const mappings = await tdb.select().from(s1OrgMappings).where(eq(s1OrgMappings.integrationId, integration.id));
    expect(mappings).toHaveLength(1);
    expect(mappings[0].registrationToken).toBeNull();
    expect(mappings[0].orgId).not.toBeNull();
  });
});

describe('concurrent connects answer 409, not 500 (#12691)', () => {
  it.each([
    ['SentinelOne', 's1_integrations', '/s1/integration', { name: 'S1 back', managementUrl: S1_URL, apiToken: 's1-token-new' }],
    ['Huntress', 'huntress_integrations', '/huntress/integration', { name: 'Huntress back', apiKey: 'hk-new' }],
  ] as const)('%s: two reconnects of the same disconnected row — one wins, the other gets 409', async (vendor, table, path, body) => {
    const app = buildApp();
    const seeded = vendor === 'SentinelOne' ? await seedS1({ active: false }) : await seedHuntress({ active: false });
    const token = await partnerAdminToken(seeded.partner.id);

    // Hold the row so both reconnects read it as disconnected and then queue on it.
    const gate = holdTransaction(async (tx) => {
      await tx.execute(sql`SELECT 1 FROM ${sql.raw(table)} WHERE id = ${seeded.integration.id} FOR UPDATE`);
    });
    await gate.ready;
    const first = call(app, token, 'POST', path, body);
    const second = call(app, token, 'POST', path, body);
    await waitForLockWaiters(table, 2);
    gate.release();
    await gate.done;

    const statuses = [(await first).status, (await second).status].sort();
    expect(statuses).toEqual([201, 409]);
    const rows = await (getTestDb() as any).execute(
      sql`SELECT count(*)::int AS n FROM ${sql.raw(table)} WHERE partner_id = ${seeded.partner.id} AND is_active`,
    );
    expect(Number((rows.rows ?? rows)[0].n)).toBe(1);
  });

  it.each([
    ['SentinelOne', 's1_integrations', '/s1/integration', { name: 'S1 new', managementUrl: S1_URL, apiToken: 's1-token-new' }],
    ['Huntress', 'huntress_integrations', '/huntress/integration', { name: 'Huntress new', apiKey: 'hk-new' }],
  ] as const)('%s: a first connect that loses the race on the active-row unique index gets 409', async (vendor, table, path, body) => {
    const app = buildApp();
    const partner = await createPartner();
    const token = await partnerAdminToken(partner.id);

    // Another connect has inserted the partner's active row but not committed yet.
    const otherConnect = holdTransaction(async (tx) => {
      if (vendor === 'SentinelOne') {
        await tx.insert(s1Integrations).values({
          partnerId: partner.id, name: 'S1 other', apiTokenEncrypted: encryptSecret('t'), managementUrl: S1_URL, isActive: true,
        });
      } else {
        await tx.insert(huntressIntegrations).values({
          partnerId: partner.id, name: 'Huntress other', apiKeyEncrypted: encryptSecret('k'), isActive: true,
        });
      }
    });
    await otherConnect.ready;
    const res = call(app, token, 'POST', path, body);
    await waitForLockWaiters(table);
    otherConnect.release();
    await otherConnect.done;

    expect((await res).status).toBe(409);
  });
});

describe('a sync racing a disconnect (#12691)', () => {
  it('SentinelOne: the sync takes the integration lock before writing any site mapping, so it cannot deadlock a disconnect', async () => {
    const { org, integration } = await seedS1({ provisionalSite: 'Branch' });
    s1Fake.agents = [{
      id: 'agent-1', uuid: null, computerName: 'pc-1', machineType: null, siteId: 'site-real', siteName: 'Branch',
      osName: null, infected: false, activeThreats: 0, isActive: true, policyName: null, lastSeen: null, updatedAt: null,
    }];
    s1Fake.onListThreats = null;

    // Disconnect order: integration row first, then its mappings.
    const disconnect = holdTransaction(async (tx) => {
      await tx.execute(disconnectS1Sql(integration.id));
    });
    await disconnect.ready;

    const sync = processS1SyncIntegration({
      type: 'sync-integration', integrationId: integration.id, syncAgents: true, syncThreats: false,
    });
    sync.catch(() => undefined);
    await waitForLockWaiters('s1_integrations');

    // The sync now waits for the integration row. The disconnect's second step
    // must not wait for the sync: on the old order the sync already held the
    // provisional mapping row here, and this statement closed a deadlock that
    // Postgres broke by aborting one side.
    let stepError: unknown = null;
    try {
      await disconnect.run(sql`SET LOCAL lock_timeout = '10s'`);
      await disconnect.run(clearS1SiteTokensSql(integration.id));
    } catch (err) {
      stepError = err;
    }
    disconnect.release();
    await disconnect.done.catch(() => undefined);

    expect(stepError).toBeNull();
    await expect(sync).resolves.toMatchObject({ integrationId: integration.id });

    const mappings = await (getTestDb() as any).select().from(s1OrgMappings).where(eq(s1OrgMappings.integrationId, integration.id));
    expect(mappings).toHaveLength(1);
    expect(mappings[0].s1SiteId).toBe('site-real');
    expect(mappings[0].orgId).toBe(org.id);
    expect(mappings[0].registrationToken).toBeNull();
  });

  it('SentinelOne: a sync already running when the disconnect commits does not stamp success on the row', async () => {
    const { integration } = await seedS1();
    s1Fake.agents = [];
    const tdb = getTestDb() as any;
    s1Fake.onListThreats = async () => {
      await tdb.execute(disconnectS1Sql(integration.id));
    };
    try {
      await processS1SyncIntegration({
        type: 'sync-integration', integrationId: integration.id, syncAgents: false, syncThreats: true,
      });
    } finally {
      s1Fake.onListThreats = null;
    }
    const [row] = await tdb.select().from(s1Integrations).where(eq(s1Integrations.id, integration.id));
    expect(row.isActive).toBe(false);
    expect(row.lastSyncStatus).not.toBe('success');
    expect(row.lastSyncAt).toBeNull();
  });

  it('Huntress: a sync already running when the disconnect commits does not stamp success on the row', async () => {
    const { integration } = await seedHuntress();
    const tdb = getTestDb() as any;
    huntressFake.onListOrganizations = async () => {
      await tdb.execute(disconnectHuntressSql(integration.id));
    };
    try {
      await syncHuntressIntegrationById(integration.id, 'manual');
    } finally {
      huntressFake.onListOrganizations = null;
    }
    const [row] = await tdb.select().from(huntressIntegrations).where(eq(huntressIntegrations.id, integration.id));
    expect(row.isActive).toBe(false);
    expect(row.lastSyncStatus).not.toBe('success');
    expect(row.lastSyncAt).toBeNull();
  });
});
