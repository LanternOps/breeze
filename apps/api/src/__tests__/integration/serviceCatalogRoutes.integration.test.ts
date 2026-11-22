/**
 * Service catalog management service (#8325, wave A1) against real Postgres,
 * running as the unprivileged app role under a partner-scoped RLS context.
 * Cross-partner forge coverage already lives in serviceCatalogsRls and
 * serviceCatalogItemConfig; this suite covers the service behaviour on top.
 */
import './setup';
import { describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { db, withDbAccessContext, type DbAccessContext } from '../../db';
import { serviceCatalogs, serviceCatalogItems } from '../../db/schema';
import {
  archiveItem,
  createItem,
  getCatalog,
  getItem,
  getOrCreateCatalog,
  listItems,
  ServiceCatalogError,
  updateItem,
} from '../../services/serviceCatalogService';
import { pgErrorCode } from '../../utils/pgErrors';
import { createPartner } from './db-utils';

const SYSTEM_CTX: DbAccessContext = {
  scope: 'system',
  orgId: null,
  accessibleOrgIds: null,
  accessiblePartnerIds: null,
  userId: null,
};

const partnerCtx = (partnerId: string): DbAccessContext => ({
  scope: 'partner',
  orgId: null,
  accessibleOrgIds: [],
  accessiblePartnerIds: [partnerId],
  userId: null,
  currentPartnerId: partnerId,
});

const asPartner = <T>(partnerId: string, fn: () => Promise<T>) => withDbAccessContext(partnerCtx(partnerId), fn);
const asSystem = <T>(fn: () => Promise<T>) => withDbAccessContext(SYSTEM_CTX, fn);
const catalogRows = (partnerId: string) =>
  asSystem(() => db.select().from(serviceCatalogs).where(eq(serviceCatalogs.partnerId, partnerId)));

describe('getOrCreateCatalog', () => {
  it('concurrent first calls leave exactly one catalog row', async () => {
    const partner = await createPartner();
    const results = await Promise.all(
      Array.from({ length: 8 }, () => asPartner(partner.id, () => getOrCreateCatalog(partner.id))),
    );
    expect(await catalogRows(partner.id)).toHaveLength(1);
    expect(new Set(results.map((r) => r.catalog.id)).size).toBe(1);
    expect(results.filter((r) => r.created)).toHaveLength(1);
  });

  it('is idempotent and getCatalog never creates', async () => {
    const partner = await createPartner();
    expect(await asPartner(partner.id, () => getCatalog(partner.id))).toBeNull();
    expect(await catalogRows(partner.id)).toHaveLength(0);
    const first = await asPartner(partner.id, () => getOrCreateCatalog(partner.id));
    const second = await asPartner(partner.id, () => getOrCreateCatalog(partner.id));
    expect(second.created).toBe(false);
    expect(second.catalog.id).toBe(first.catalog.id);
  });
});

describe('items under RLS as the app role', () => {
  it('creates, lists and isolates items per partner', async () => {
    const a = await createPartner();
    const b = await createPartner();
    const itemA = await asPartner(a.id, () => createItem(a.id, { name: 'A item', isActive: true, showInPortal: false, sortOrder: 0 }));
    expect(itemA.partnerId).toBe(a.id);
    expect(itemA.orgId).toBeNull();
    expect(await asPartner(a.id, () => listItems(a.id, { includeArchived: false }))).toHaveLength(1);
    expect(await asPartner(b.id, () => listItems(b.id, { includeArchived: true }))).toHaveLength(0);
    expect(await asPartner(b.id, () => getItem(b.id, itemA.id))).toBeNull();
    expect(await asPartner(b.id, () => updateItem(b.id, itemA.id, { name: 'hijack' }))).toBeNull();
    expect(await asPartner(b.id, () => archiveItem(b.id, itemA.id))).toBeNull();
    const [row] = await asSystem(() => db.select().from(serviceCatalogItems).where(eq(serviceCatalogItems.id, itemA.id)));
    expect(row!.name).toBe('A item');
    expect(row!.isActive).toBe(true);
  });

  it('rejects a PATCH whose resulting state orphans the service line', async () => {
    const p = await createPartner();
    const item = await asPartner(p.id, () =>
      createItem(p.id, { name: 'Grouped', pillar: 'Security', serviceLine: 'Endpoint', isActive: true, showInPortal: false, sortOrder: 0 }),
    );
    await expect(asPartner(p.id, () => updateItem(p.id, item.id, { pillar: null }))).rejects.toBeInstanceOf(ServiceCatalogError);
    const ok = await asPartner(p.id, () => updateItem(p.id, item.id, { pillar: null, serviceLine: null }));
    expect(ok!.after.pillar).toBeNull();
    expect(ok!.after.serviceLine).toBeNull();
  });

  it('database CHECK rejects a blank grouping label (23514)', async () => {
    const p = await createPartner();
    const { catalog } = await asPartner(p.id, () => getOrCreateCatalog(p.id));
    let raised: unknown;
    try {
      await asSystem(() =>
        db.insert(serviceCatalogItems).values({ catalogId: catalog.id, partnerId: p.id, name: 'x', pillar: '   ' }),
      );
    } catch (err) {
      raised = err;
    }
    expect(pgErrorCode(raised)).toBe('23514');
  });

  it('archive keeps the row, is idempotent, and archived items are hidden by default', async () => {
    const p = await createPartner();
    const item = await asPartner(p.id, () => createItem(p.id, { name: 'Old', isActive: true, showInPortal: false, sortOrder: 0 }));
    const first = await asPartner(p.id, () => archiveItem(p.id, item.id));
    expect(first).toMatchObject({ changed: true });
    expect(first!.item.isActive).toBe(false);
    const second = await asPartner(p.id, () => archiveItem(p.id, item.id));
    expect(second).toMatchObject({ changed: false });
    expect(await asPartner(p.id, () => listItems(p.id, { includeArchived: false }))).toHaveLength(0);
    expect(await asPartner(p.id, () => listItems(p.id, { includeArchived: true }))).toHaveLength(1);
    const restored = await asPartner(p.id, () => updateItem(p.id, item.id, { isActive: true }));
    expect(restored!.after.isActive).toBe(true);
  });

  it('orders by pillar, service line, sort order, name with ungrouped last', async () => {
    const p = await createPartner();
    const mk = (name: string, extra: Record<string, unknown> = {}) =>
      asPartner(p.id, () => createItem(p.id, { name, isActive: true, showInPortal: false, sortOrder: 0, ...extra } as never));
    await mk('z-ungrouped');
    await mk('b', { pillar: 'Alpha', sortOrder: 2 });
    await mk('a', { pillar: 'Alpha', sortOrder: 2 });
    await mk('first', { pillar: 'Alpha', sortOrder: 1 });
    const names = (await asPartner(p.id, () => listItems(p.id, { includeArchived: false }))).map((i) => i.name);
    expect(names).toEqual(['first', 'a', 'b', 'z-ungrouped']);
  });

  it('escapes LIKE wildcards in the name search', async () => {
    const p = await createPartner();
    await asPartner(p.id, () => createItem(p.id, { name: '100% uptime', isActive: true, showInPortal: false, sortOrder: 0 }));
    await asPartner(p.id, () => createItem(p.id, { name: 'Other', isActive: true, showInPortal: false, sortOrder: 0 }));
    expect(await asPartner(p.id, () => listItems(p.id, { includeArchived: false, q: '%' }))).toHaveLength(1);
  });
});
