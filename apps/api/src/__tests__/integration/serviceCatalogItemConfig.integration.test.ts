/**
 * service_catalog_items — item configuration columns (#8325).
 *
 * Migration: 2027-01-19-100000-service-catalog-item-config.sql.
 * Spec: docs/superpowers/specs/ticketing/2026-10-10-service-catalog-design.md §4.
 *
 * Covers only the fields accepted for this wave: pillar, service line, portal
 * visibility and sort order. Statements that must reach a constraint run under
 * SYSTEM scope, which short-circuits RLS.
 */
import './setup';
import { describe, expect, it } from 'vitest';
import { db, withDbAccessContext, type DbAccessContext } from '../../db';
import { serviceCatalogs, serviceCatalogItems } from '../../db/schema';
import { pgErrorCode } from '../../utils/pgErrors';
import { createOrganization, createPartner } from './db-utils';

const SYSTEM_CTX: DbAccessContext = {
  scope: 'system',
  orgId: null,
  accessibleOrgIds: null,
  accessiblePartnerIds: null,
  userId: null,
};

async function expectSqlState(fn: () => Promise<unknown>, code: string): Promise<void> {
  let raised: unknown;
  try {
    await fn();
  } catch (err) {
    raised = err;
  }
  expect(raised, `expected SQLSTATE ${code}, but the statement succeeded`).toBeDefined();
  expect(pgErrorCode(raised)).toBe(code);
}

const asSystem = <T>(fn: () => Promise<T>): Promise<T> => withDbAccessContext(SYSTEM_CTX, fn);
const rand = (): string => Math.random().toString(36).slice(2, 10);

async function seedCatalog(owner: { partnerId?: string | null; orgId?: string | null }): Promise<string> {
  const rows = await asSystem(() =>
    db
      .insert(serviceCatalogs)
      .values({ partnerId: owner.partnerId ?? null, orgId: owner.orgId ?? null, name: `Catalog ${rand()}` })
      .returning({ id: serviceCatalogs.id }),
  );
  return rows[0]!.id;
}

type ItemValues = Partial<typeof serviceCatalogItems.$inferInsert>;

async function insertItem(catalogId: string, owner: { partnerId?: string; orgId?: string }, extra: ItemValues = {}) {
  const rows = await asSystem(() =>
    db
      .insert(serviceCatalogItems)
      .values({
        catalogId,
        partnerId: owner.partnerId ?? null,
        orgId: owner.orgId ?? null,
        name: `Item ${rand()}`,
        ...extra,
      })
      .returning(),
  );
  return rows[0]!;
}

async function partnerSetup() {
  const partner = await createPartner();
  const catalogId = await seedCatalog({ partnerId: partner.id });
  return { partner, catalogId };
}

describe('service catalog item defaults and metadata (#8325)', () => {
  it('starts ungrouped, hidden from the portal and ordered at 0', async () => {
    const { partner, catalogId } = await partnerSetup();
    const item = await insertItem(catalogId, { partnerId: partner.id });
    expect(item.pillar).toBeNull();
    expect(item.serviceLine).toBeNull();
    expect(item.showInPortal).toBe(false);
    expect(item.sortOrder).toBe(0);
  });

  it('stores grouping, portal visibility and sort order', async () => {
    const { partner, catalogId } = await partnerSetup();
    const item = await insertItem(
      catalogId,
      { partnerId: partner.id },
      { pillar: 'Security', serviceLine: 'Endpoint', showInPortal: true, sortOrder: 5 },
    );
    expect(item).toMatchObject({
      pillar: 'Security',
      serviceLine: 'Endpoint',
      showInPortal: true,
      sortOrder: 5,
    });
  });

  it('accepts grouping on organization-owned items too', async () => {
    const partner = await createPartner();
    const org = await createOrganization({ partnerId: partner.id });
    const orgCatalogId = await seedCatalog({ orgId: org.id });
    const item = await insertItem(orgCatalogId, { orgId: org.id }, { pillar: 'Cloud', serviceLine: 'Backup' });
    expect(item).toMatchObject({ pillar: 'Cloud', serviceLine: 'Backup', partnerId: null, orgId: org.id });
  });
});

describe('service catalog item grouping CHECK (#8325)', () => {
  it('allows a pillar without a service line but not a service line without a pillar (23514)', async () => {
    const { partner, catalogId } = await partnerSetup();
    const owner = { partnerId: partner.id };
    await insertItem(catalogId, owner, { pillar: 'Cloud' });
    await insertItem(catalogId, owner, { pillar: 'Cloud', serviceLine: 'Backup' });
    await expectSqlState(() => insertItem(catalogId, owner, { serviceLine: 'Backup' }), '23514');
  });

  it('rejects blank pillar and service line (23514)', async () => {
    const { partner, catalogId } = await partnerSetup();
    const owner = { partnerId: partner.id };
    await expectSqlState(() => insertItem(catalogId, owner, { pillar: '   ' }), '23514');
    await expectSqlState(() => insertItem(catalogId, owner, { pillar: 'Cloud', serviceLine: '' }), '23514');
  });
});
