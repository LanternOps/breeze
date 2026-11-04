import { and, asc, eq, ilike, isNull, sql, type SQL } from 'drizzle-orm';
import {
  serviceLineRequiresPillar,
  SERVICE_LINE_REQUIRES_PILLAR_MESSAGE,
  type CreateServiceCatalogItemInput,
  type UpdateServiceCatalogInput,
  type UpdateServiceCatalogItemInput,
} from '@breeze/shared';
import { db } from '../db';
import { serviceCatalogItems, serviceCatalogs } from '../db/schema';

/**
 * Service catalog management (#8325, wave A1). The catalog is partner-level and
 * unique per partner (partial unique index service_catalogs_one_per_partner).
 * The partner id ALWAYS comes from the caller's auth context, never from input.
 * Every query also pins `org_id IS NULL` / `partner_id = $p` as app-layer
 * defence in depth; RLS remains the primary tenant boundary.
 */

export const DEFAULT_SERVICE_CATALOG_NAME = 'Service Catalog';

export type ServiceCatalogRow = typeof serviceCatalogs.$inferSelect;
export type ServiceCatalogItemRow = typeof serviceCatalogItems.$inferSelect;

/** Domain validation failure; routes map it to 400 VALIDATION_FAILED. */
export class ServiceCatalogError extends Error {
  constructor(message: string, readonly field?: string) {
    super(message);
    this.name = 'ServiceCatalogError';
  }
}

export async function getCatalog(partnerId: string): Promise<ServiceCatalogRow | null> {
  const rows = await db
    .select()
    .from(serviceCatalogs)
    .where(and(eq(serviceCatalogs.partnerId, partnerId), isNull(serviceCatalogs.orgId)))
    .limit(1);
  return rows[0] ?? null;
}

/**
 * Race-free get-or-create. INSERT ... ON CONFLICT DO NOTHING against the
 * partial unique index, then ALWAYS re-SELECT so concurrent callers converge on
 * the single winning row. `created` is true only for the call whose INSERT won.
 */
export async function getOrCreateCatalog(
  partnerId: string
): Promise<{ catalog: ServiceCatalogRow; created: boolean }> {
  const inserted = await db
    .insert(serviceCatalogs)
    .values({ partnerId, orgId: null, name: DEFAULT_SERVICE_CATALOG_NAME })
    .onConflictDoNothing({
      target: serviceCatalogs.partnerId,
      where: sql`${serviceCatalogs.partnerId} IS NOT NULL`,
    })
    .returning();
  if (inserted[0]) return { catalog: inserted[0], created: true };
  const existing = await getCatalog(partnerId);
  if (!existing) throw new Error('service catalog missing after get-or-create');
  return { catalog: existing, created: false };
}

export async function updateCatalog(
  partnerId: string,
  patch: UpdateServiceCatalogInput
): Promise<ServiceCatalogRow> {
  const { catalog } = await getOrCreateCatalog(partnerId);
  const [row] = await db
    .update(serviceCatalogs)
    .set({ ...patch, updatedAt: new Date() })
    .where(and(eq(serviceCatalogs.id, catalog.id), eq(serviceCatalogs.partnerId, partnerId)))
    .returning();
  if (!row) throw new Error('service catalog update returned no row');
  return row;
}

function itemScope(partnerId: string): SQL[] {
  return [eq(serviceCatalogItems.partnerId, partnerId), isNull(serviceCatalogItems.orgId)];
}

export async function listItems(
  partnerId: string,
  filters: { includeArchived: boolean; pillar?: string; q?: string }
): Promise<ServiceCatalogItemRow[]> {
  const conditions = itemScope(partnerId);
  if (!filters.includeArchived) conditions.push(eq(serviceCatalogItems.isActive, true));
  if (filters.pillar) conditions.push(eq(serviceCatalogItems.pillar, filters.pillar));
  if (filters.q) {
    const escaped = filters.q.replace(/[\\%_]/g, (ch) => `\\${ch}`);
    conditions.push(ilike(serviceCatalogItems.name, `%${escaped}%`));
  }
  return db
    .select()
    .from(serviceCatalogItems)
    .where(and(...conditions))
    .orderBy(
      sql`${serviceCatalogItems.pillar} ASC NULLS LAST`,
      sql`${serviceCatalogItems.serviceLine} ASC NULLS LAST`,
      asc(serviceCatalogItems.sortOrder),
      asc(serviceCatalogItems.name)
    );
}

export async function getItem(partnerId: string, id: string): Promise<ServiceCatalogItemRow | null> {
  const rows = await db
    .select()
    .from(serviceCatalogItems)
    .where(and(eq(serviceCatalogItems.id, id), ...itemScope(partnerId)))
    .limit(1);
  return rows[0] ?? null;
}

export async function createItem(
  partnerId: string,
  input: CreateServiceCatalogItemInput
): Promise<ServiceCatalogItemRow> {
  const { catalog } = await getOrCreateCatalog(partnerId);
  const [row] = await db
    .insert(serviceCatalogItems)
    .values({
      catalogId: catalog.id,
      partnerId,
      orgId: null,
      name: input.name,
      description: input.description ?? null,
      pillar: input.pillar ?? null,
      serviceLine: input.serviceLine ?? null,
      isActive: input.isActive,
      showInPortal: input.showInPortal,
      sortOrder: input.sortOrder,
    })
    .returning();
  if (!row) throw new Error('service catalog item insert returned no row');
  return row;
}

/**
 * Apply a partial update. The grouping rule is checked against the RESULTING
 * state (stored row + payload) so PATCH {pillar:null} cannot orphan a stored
 * service line. Returns null when the item is not in the caller's partner.
 */
export async function updateItem(
  partnerId: string,
  id: string,
  patch: UpdateServiceCatalogItemInput
): Promise<{ before: ServiceCatalogItemRow; after: ServiceCatalogItemRow } | null> {
  const before = await getItem(partnerId, id);
  if (!before) return null;
  const merged = {
    pillar: patch.pillar !== undefined ? patch.pillar : before.pillar,
    serviceLine: patch.serviceLine !== undefined ? patch.serviceLine : before.serviceLine,
  };
  if (!serviceLineRequiresPillar(merged)) {
    throw new ServiceCatalogError(SERVICE_LINE_REQUIRES_PILLAR_MESSAGE, 'serviceLine');
  }
  const [after] = await db
    .update(serviceCatalogItems)
    .set({ ...patch, updatedAt: new Date() })
    .where(and(eq(serviceCatalogItems.id, id), ...itemScope(partnerId)))
    .returning();
  if (!after) return null;
  return { before, after };
}

/** Soft-archive (is_active=false). Idempotent: `changed` is false when already archived. */
export async function archiveItem(
  partnerId: string,
  id: string
): Promise<{ item: ServiceCatalogItemRow; changed: boolean } | null> {
  const existing = await getItem(partnerId, id);
  if (!existing) return null;
  if (!existing.isActive) return { item: existing, changed: false };
  const [row] = await db
    .update(serviceCatalogItems)
    .set({ isActive: false, updatedAt: new Date() })
    .where(and(eq(serviceCatalogItems.id, id), ...itemScope(partnerId)))
    .returning();
  return row ? { item: row, changed: true } : null;
}
