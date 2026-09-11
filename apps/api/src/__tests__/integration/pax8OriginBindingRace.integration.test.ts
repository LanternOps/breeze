/**
 * Pax8 endpoint/client/cache origin binding across configuration changes.
 */
import './setup';
import { describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { getTestDb } from './setup';
import { withSystemDbAccessContext } from '../../db';
import { setupTestEnvironment } from './db-utils';
import {
  contractLines,
  contracts,
  pax8CompanyMappings,
  pax8ContractLineLinks,
  pax8Integrations,
  pax8ProductMappings,
  pax8SubscriptionSnapshots,
} from '../../db/schema';
import { encryptSecret } from '../../services/secretCrypto';
import {
  createPax8ClientForIntegration,
  syncPax8Integration,
} from '../../services/pax8SyncService';

const runDb = it.runIf(Boolean(process.env.DATABASE_URL));

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

async function insertCachedIntegration(partnerId: string) {
  const [row] = await getTestDb().insert(pax8Integrations).values({
    partnerId,
    name: 'Pax8 origin binding',
    clientIdEncrypted: encryptSecret('old-client')!,
    clientSecretEncrypted: encryptSecret('old-secret')!,
    accessTokenEncrypted: encryptSecret('old-access-token'),
    accessTokenExpiresAt: new Date(Date.now() + 60 * 60 * 1000),
    apiBaseUrl: 'https://old-api.example.test/v1',
    tokenUrl: 'https://old-token.example.test/oauth/token',
  }).returning();
  expect(row).toBeTruthy();
  return row!;
}

function providerPage(url: string, suffix: string) {
  if (url.includes('/companies')) {
    return json({ content: [{ id: `${suffix}-company`, name: `${suffix} company`, status: 'Active' }], last: true });
  }
  return json({
    content: [{
      id: `${suffix}-subscription`,
      companyId: `${suffix}-company`,
      productId: `${suffix}-product`,
      productName: `${suffix} product`,
      vendorName: 'Pax8 test vendor',
      quantity: 7,
      status: 'Active',
    }],
    last: true,
  });
}

function blockedProviderFetch(responder: (url: string) => Response) {
  let release!: () => void;
  const released = new Promise<void>((resolve) => { release = resolve; });
  let bothStarted!: () => void;
  const started = new Promise<void>((resolve) => { bothStarted = resolve; });
  let requestCount = 0;
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    expect((init?.headers as Record<string, string>).authorization).toBe('Bearer old-access-token');
    requestCount += 1;
    if (requestCount === 2) bothStarted();
    await released;
    return responder(String(input));
  }) as typeof fetch;
  return { fetchImpl, started, release };
}

describe('Pax8 credential receiver tuple races', () => {
  runDb('a cleared cache makes the test client mint before calling the replacement API', async () => {
    const env = await setupTestEnvironment({ scope: 'partner' });
    const row = await insertCachedIntegration(env.partner.id);
    await getTestDb().update(pax8Integrations).set({
      apiBaseUrl: 'https://new-api.example.test/v1',
      tokenUrl: 'https://new-token.example.test/oauth/token',
      clientIdEncrypted: encryptSecret('new-client')!,
      clientSecretEncrypted: encryptSecret('new-secret')!,
      accessTokenEncrypted: null,
      accessTokenExpiresAt: null,
    }).where(eq(pax8Integrations.id, row.id));

    const calls: Array<{ url: string; authorization?: string }> = [];
    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      const headers = init?.headers as Record<string, string> | undefined;
      calls.push({ url, authorization: headers?.authorization });
      if (url.startsWith('https://new-token.example.test/')) {
        return json({ access_token: 'new-access-token', expires_in: 3600 });
      }
      return json({ content: [], last: true });
    }) as typeof fetch;

    const { client } = await withSystemDbAccessContext(() =>
      createPax8ClientForIntegration(row.id, fetchImpl));
    await client.testConnection();

    expect(calls[0]?.url).toMatch(/^https:\/\/new-token\.example\.test\//);
    expect(calls[1]).toMatchObject({
      url: expect.stringMatching(/^https:\/\/new-api\.example\.test\//),
      authorization: 'Bearer new-access-token',
    });
    expect(calls.some((call) => call.authorization === 'Bearer old-access-token')).toBe(false);
  });

  runDb('an old successful response cannot persist any Phase-3 effects after reconfiguration', async () => {
    const env = await setupTestEnvironment({ scope: 'partner' });
    const row = await insertCachedIntegration(env.partner.id);
    const [company] = await getTestDb().insert(pax8CompanyMappings).values({
      integrationId: row.id,
      partnerId: env.partner.id,
      pax8CompanyId: 'existing-company',
      pax8CompanyName: 'existing company',
      orgId: env.organization.id,
    }).returning();
    const [snapshot] = await getTestDb().insert(pax8SubscriptionSnapshots).values({
      integrationId: row.id,
      partnerId: env.partner.id,
      pax8CompanyId: company!.pax8CompanyId,
      pax8SubscriptionId: 'existing-subscription',
      orgId: env.organization.id,
      productId: 'existing-product',
      productName: 'existing product',
      quantity: '3.00',
      quantityKnown: true,
    }).returning();
    const [contract] = await getTestDb().insert(contracts).values({
      partnerId: env.partner.id,
      orgId: env.organization.id,
      name: 'Pax8 race contract',
      intervalMonths: 1,
      startDate: '2026-09-01',
      currencyCode: 'USD',
    }).returning();
    const [line] = await getTestDb().insert(contractLines).values({
      contractId: contract!.id,
      orgId: env.organization.id,
      lineType: 'manual',
      description: 'Pax8 race seats',
      unitPrice: '1.00',
    }).returning();
    const originalObservedAt = new Date('2026-09-01T01:02:03.000Z');
    const [link] = await getTestDb().insert(pax8ContractLineLinks).values({
      integrationId: row.id,
      partnerId: env.partner.id,
      orgId: env.organization.id,
      subscriptionSnapshotId: snapshot!.id,
      contractLineId: line!.id,
      syncEnabled: true,
      lastObservedQuantity: '3.00',
      lastObservedAt: originalObservedAt,
    }).returning();

    const provider = blockedProviderFetch((url) => {
      if (url.includes('/companies')) {
        return json({ content: [{ id: 'stale-company', name: 'stale company' }], last: true });
      }
      return json({
        content: [
          { id: 'stale-subscription', companyId: 'stale-company', productId: 'stale-product', productName: 'stale product', quantity: 7 },
          { id: 'existing-subscription', companyId: 'existing-company', productId: 'existing-product', productName: 'stale overwrite', quantity: 99 },
        ],
        last: true,
      });
    });

    const staleSync = syncPax8Integration(row.id, provider.fetchImpl);
    await provider.started;
    const replacementSyncAt = new Date('2026-09-02T03:04:05.000Z');
    await getTestDb().update(pax8Integrations).set({
      apiBaseUrl: 'https://new-api.example.test/v1',
      tokenUrl: 'https://new-token.example.test/oauth/token',
      clientIdEncrypted: encryptSecret('new-client')!,
      clientSecretEncrypted: encryptSecret('new-secret')!,
      accessTokenEncrypted: null,
      accessTokenExpiresAt: null,
      lastSyncAt: replacementSyncAt,
      lastSyncStatus: 'configured',
      lastSyncError: 'replacement generation',
    }).where(eq(pax8Integrations.id, row.id));
    provider.release();
    await expect(staleSync).rejects.toThrow('configuration changed during sync');

    const [stored] = await getTestDb().select().from(pax8Integrations)
      .where(eq(pax8Integrations.id, row.id));
    expect(stored).toMatchObject({
      apiBaseUrl: 'https://new-api.example.test/v1',
      tokenUrl: 'https://new-token.example.test/oauth/token',
      accessTokenEncrypted: null,
      accessTokenExpiresAt: null,
      lastSyncStatus: 'configured',
      lastSyncError: 'replacement generation',
    });
    expect(stored?.lastSyncAt?.toISOString()).toBe(replacementSyncAt.toISOString());
    const staleCompanies = await getTestDb().select().from(pax8CompanyMappings).where(and(
      eq(pax8CompanyMappings.integrationId, row.id),
      eq(pax8CompanyMappings.pax8CompanyId, 'stale-company'),
    ));
    const staleSubscriptions = await getTestDb().select().from(pax8SubscriptionSnapshots).where(and(
      eq(pax8SubscriptionSnapshots.integrationId, row.id),
      eq(pax8SubscriptionSnapshots.pax8SubscriptionId, 'stale-subscription'),
    ));
    const staleProducts = await getTestDb().select().from(pax8ProductMappings).where(and(
      eq(pax8ProductMappings.integrationId, row.id),
      eq(pax8ProductMappings.pax8ProductId, 'stale-product'),
    ));
    expect({ staleCompanies, staleSubscriptions, staleProducts }).toEqual({
      staleCompanies: [], staleSubscriptions: [], staleProducts: [],
    });
    const [preservedSnapshot] = await getTestDb().select().from(pax8SubscriptionSnapshots)
      .where(eq(pax8SubscriptionSnapshots.id, snapshot!.id));
    const [preservedLink] = await getTestDb().select().from(pax8ContractLineLinks)
      .where(eq(pax8ContractLineLinks.id, link!.id));
    expect(preservedSnapshot).toMatchObject({ productName: 'existing product', quantity: '3.00' });
    expect(preservedLink).toMatchObject({ lastObservedQuantity: '3.00' });
    expect(preservedLink?.lastObservedAt?.toISOString()).toBe(originalObservedAt.toISOString());
  });

  runDb('an old provider failure cannot clobber replacement-generation sync status', async () => {
    const env = await setupTestEnvironment({ scope: 'partner' });
    const row = await insertCachedIntegration(env.partner.id);
    const provider = blockedProviderFetch(() => new Response('old provider failed', { status: 503 }));
    const staleSync = syncPax8Integration(row.id, provider.fetchImpl);
    await provider.started;
    const replacementSyncAt = new Date('2026-09-03T04:05:06.000Z');
    await getTestDb().update(pax8Integrations).set({
      apiBaseUrl: 'https://new-api.example.test/v1',
      tokenUrl: 'https://new-token.example.test/oauth/token',
      clientIdEncrypted: encryptSecret('new-client')!,
      clientSecretEncrypted: encryptSecret('new-secret')!,
      accessTokenEncrypted: null,
      accessTokenExpiresAt: null,
      lastSyncAt: replacementSyncAt,
      lastSyncStatus: 'configured',
      lastSyncError: 'replacement generation',
    }).where(eq(pax8Integrations.id, row.id));
    provider.release();
    await expect(staleSync).rejects.toThrow(/503/);

    const [stored] = await getTestDb().select().from(pax8Integrations)
      .where(eq(pax8Integrations.id, row.id));
    expect(stored).toMatchObject({
      lastSyncStatus: 'configured',
      lastSyncError: 'replacement generation',
    });
    expect(stored?.lastSyncAt?.toISOString()).toBe(replacementSyncAt.toISOString());
  });

  runDb('an unchanged receiver generation persists nonempty Phase-3 results normally', async () => {
    const env = await setupTestEnvironment({ scope: 'partner' });
    const row = await insertCachedIntegration(env.partner.id);
    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
      expect((init?.headers as Record<string, string>).authorization).toBe('Bearer old-access-token');
      return providerPage(String(input), 'current');
    }) as typeof fetch;

    await expect(syncPax8Integration(row.id, fetchImpl)).resolves.toMatchObject({
      companies: 1,
      subscriptions: 1,
      products: 1,
    });
    const [stored] = await getTestDb().select().from(pax8Integrations)
      .where(eq(pax8Integrations.id, row.id));
    const companies = await getTestDb().select().from(pax8CompanyMappings)
      .where(eq(pax8CompanyMappings.integrationId, row.id));
    const subscriptions = await getTestDb().select().from(pax8SubscriptionSnapshots)
      .where(eq(pax8SubscriptionSnapshots.integrationId, row.id));
    const products = await getTestDb().select().from(pax8ProductMappings)
      .where(eq(pax8ProductMappings.integrationId, row.id));
    expect(stored).toMatchObject({ lastSyncStatus: 'success', lastSyncError: null });
    expect(companies).toHaveLength(1);
    expect(subscriptions).toHaveLength(1);
    expect(products).toHaveLength(1);
  });
});
