/**
 * Xero W03b against real Postgres: proves the customerImport + mapping
 * capability flip end to end — importing a contact links an org, the next
 * proposal load backfills a confirmed Customer mapping carrying the remote
 * sync token, and a create_new sync adopts an existing `breeze:<orgId>`
 * ContactNumber instead of creating a duplicate (GET then POST, no PUT).
 */
import './setup';
import {
  afterEach, beforeEach, describe, expect, it, vi,
} from 'vitest';
import { and, eq } from 'drizzle-orm';
import {
  db, withDbAccessContext, withSystemDbAccessContext, type DbAccessContext,
} from '../../db';
import {
  accountingEntityMappings, organizationExternalLinks, organizations,
} from '../../db/schema';
import { createPartner } from './db-utils';
import { upsertConnection } from '../../services/accounting/accountingConnectionService';
import { importAccountingCustomers } from '../../services/accounting/accountingCustomerImport';
import {
  listMappingProposals, saveMappingDecision, syncMappedEntity,
} from '../../services/accounting/accountingMappingService';

const runDb = it.runIf(!!process.env.DATABASE_URL);

const MINUTE = 60 * 1000;
const DAY = 24 * 60 * MINUTE;

function partnerCtx(partnerId: string, accessibleOrgIds: string[] = []): DbAccessContext {
  return {
    scope: 'partner',
    orgId: null,
    accessibleOrgIds,
    accessiblePartnerIds: [partnerId],
    userId: null,
  };
}

const asPartner = <T>(partnerId: string, fn: () => Promise<T>, accessibleOrgIds: string[] = []) => withDbAccessContext(partnerCtx(partnerId, accessibleOrgIds), fn);
const asSystem = <T>(fn: () => Promise<T>) => withSystemDbAccessContext(fn);
// `organizations` and `organization_external_links` are org-id-keyed (breeze_has_org_access(org_id)),
// so a partner-scoped read of either needs the org id(s) in `accessibleOrgIds` — partner axis alone
// is not enough for these two tables (unlike accounting_connections, which is partner-scoped directly).
const partnerRunner = (partnerId: string, accessibleOrgIds: string[] = []) => <T>(fn: () => Promise<T>) => asPartner(partnerId, fn, accessibleOrgIds);

async function seedXeroConnection(partnerId: string) {
  return asSystem(() => upsertConnection(db, partnerId, 'xero', {
    realmId: 'ten-A',
    providerConnectionRef: `conn-${partnerId}`,
    status: 'connected',
    environment: 'production',
    accessToken: 'at-valid',
    refreshToken: 'rt-valid',
    accessTokenExpiresAt: new Date(Date.now() + 30 * MINUTE),
    refreshTokenExpiresAt: new Date(Date.now() + 60 * DAY),
    homeCurrency: 'GBP',
  }));
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const contact = (id: string, name: string, extra: Record<string, unknown> = {}) => ({
  ContactID: id, Name: name, ContactStatus: 'ACTIVE', UpdatedDateUTC: '/Date(1790000000000+0000)/', ...extra,
});

let partnerId: string;
let connectionId: string;

// The integration harness truncates every table before EACH test
// (__tests__/integration/setup.ts), so seeding happens per test and no test
// depends on another's rows (quorum finding 14).
beforeEach(async () => {
  vi.restoreAllMocks();
  const partner = await createPartner();
  partnerId = partner.id;
  const conn = await seedXeroConnection(partnerId);
  connectionId = conn.id;
});

afterEach(() => {
  vi.restoreAllMocks();
});

async function importOne(contactId: string, name: string) {
  vi.spyOn(globalThis, 'fetch').mockImplementation(async () => json({ pagination: { pageCount: 1 }, Contacts: [contact(contactId, name)] }));
  const summary = await importAccountingCustomers({ partnerId, provider: 'xero', customerIds: [contactId] });
  vi.restoreAllMocks();
  return summary;
}

describe('Xero mapping and import against real Postgres (Xero W03)', () => {
  runDb('imports a contact as an org linked with system = "xero"', async () => {
    const summary = await importOne('xc-1', 'Imported Co');
    expect(summary.imported).toHaveLength(1);
    const links = await asSystem(() => db.select().from(organizationExternalLinks)
      .where(and(eq(organizationExternalLinks.partnerId, partnerId), eq(organizationExternalLinks.externalId, 'xc-1'))));
    expect(links).toEqual([expect.objectContaining({ system: 'xero', orgId: summary.imported[0]!.organizationId })]);
  });

  runDb('backfills a confirmed Customer mapping row for the imported org on the next proposal load', async () => {
    const importSummary = await importOne('xc-1', 'Imported Co'); // this test's own prerequisite
    const orgId = importSummary.imported[0]!.organizationId;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => json({ pagination: { pageCount: 1 }, Contacts: [contact('xc-1', 'Imported Co')] }));
    await listMappingProposals({ partnerId, provider: 'xero', entityType: 'org' }, partnerRunner(partnerId, [orgId]));
    const rows = await asSystem(() => db.select().from(accountingEntityMappings)
      .where(and(eq(accountingEntityMappings.integrationId, connectionId), eq(accountingEntityMappings.remoteEntityId, 'xc-1'))));
    expect(rows).toEqual([expect.objectContaining({
      remoteEntityType: 'Customer', linkStatus: 'confirmed', remoteSyncToken: new Date(1790000000000).toISOString(),
    })]);
  });

  runDb('create-new sync adopts an existing breeze: ContactNumber instead of creating (no PUT)', async () => {
    const [org] = await asSystem(() => db.insert(organizations)
      .values({
        partnerId, name: 'Adopt Me', slug: `adopt-me-${Date.now()}`, type: 'customer', currencyCode: 'GBP',
      }).returning());
    await saveMappingDecision({
      partnerId, provider: 'xero', breezeEntityType: 'org', breezeEntityId: org!.id, decision: 'create_new',
    }, partnerRunner(partnerId, [org!.id]));
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(json({ Contacts: [contact('xc-adopt', 'Adopt Me', { ContactNumber: `breeze:${org!.id}` })] }))
      .mockResolvedValueOnce(json({ Contacts: [contact('xc-adopt', 'Adopt Me')] }));
    await syncMappedEntity({
      partnerId, provider: 'xero', breezeEntityType: 'org', breezeEntityId: org!.id,
    }, partnerRunner(partnerId, [org!.id]));
    expect(fetchMock.mock.calls.map((c) => (c[1] as RequestInit).method)).toEqual(['GET', 'POST']);
    const [row] = await asSystem(() => db.select().from(accountingEntityMappings)
      .where(and(eq(accountingEntityMappings.integrationId, connectionId), eq(accountingEntityMappings.breezeEntityId, org!.id))));
    expect(row).toMatchObject({
      remoteEntityType: 'Customer', remoteEntityId: 'xc-adopt', linkStatus: 'confirmed', syncStatus: 'synced',
    });
  });
});
