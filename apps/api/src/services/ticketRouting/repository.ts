/**
 * Ticket routing rules (#8883 W5) — data access. Every function runs on the
 * CALLER's connection (the ambient DB context), so RLS decides what each
 * statement can see or target; service.ts adds every app-layer gate (writer
 * scope, the partner-wide capability check, canAccessOrg, references).
 */
import { and, asc, eq, inArray, isNull, max, or, sql, type SQL } from 'drizzle-orm';
import { db } from '../../db';
import { organizations, ticketRoutingRuleOrgLinks, ticketRoutingRules } from '../../db/schema';

export type RuleRow = typeof ticketRoutingRules.$inferSelect;
export type RuleInsert = typeof ticketRoutingRules.$inferInsert;
export type Owner = { orgId: string | null; partnerId: string | null };

export async function findRule(id: string, opts: { forUpdate?: boolean } = {}): Promise<RuleRow | null> {
  const q = db.select().from(ticketRoutingRules).where(eq(ticketRoutingRules.id, id)).limit(1);
  const rows = opts.forUpdate ? await q.for('update') : await q;
  return rows[0] ?? null;
}

export async function findRules(ids: string[], opts: { forUpdate?: boolean } = {}): Promise<RuleRow[]> {
  if (ids.length === 0) return [];
  const q = db.select().from(ticketRoutingRules).where(inArray(ticketRoutingRules.id, ids)).orderBy(asc(ticketRoutingRules.id));
  return opts.forUpdate ? q.for('update') : q;
}

export async function findOrg(orgId: string): Promise<{ id: string; partnerId: string } | null> {
  const rows = await db
    .select({ id: organizations.id, partnerId: organizations.partnerId })
    .from(organizations)
    .where(and(eq(organizations.id, orgId), isNull(organizations.deletedAt)))
    .limit(1);
  return rows[0] ?? null;
}

/** The ids among `orgIds` that are live orgs of `partnerId`. */
export async function orgIdsOfPartner(orgIds: string[], partnerId: string): Promise<string[]> {
  if (orgIds.length === 0) return [];
  const rows = await db
    .select({ id: organizations.id })
    .from(organizations)
    .where(and(inArray(organizations.id, orgIds), eq(organizations.partnerId, partnerId), isNull(organizations.deletedAt)));
  return rows.map((r) => r.id);
}

/**
 * Rules for a list read: partner-wide rules of `partnerId` (when set) plus
 * org-owned rules of `orgIds` ('all' = every org row RLS shows). Ordered org
 * rules first, then partner-wide, each by (position, id) — evaluation order.
 */
export async function listRuleRows(filter: { orgIds: string[] | 'all' | null; partnerId: string | null }): Promise<RuleRow[]> {
  const branches: SQL[] = [];
  if (filter.partnerId) branches.push(and(isNull(ticketRoutingRules.orgId), eq(ticketRoutingRules.partnerId, filter.partnerId))!);
  if (filter.orgIds === 'all') branches.push(sql`${ticketRoutingRules.orgId} IS NOT NULL`);
  else if (filter.orgIds && filter.orgIds.length > 0) branches.push(inArray(ticketRoutingRules.orgId, filter.orgIds));
  if (branches.length === 0) return [];
  return db
    .select()
    .from(ticketRoutingRules)
    .where(or(...branches))
    .orderBy(sql`(${ticketRoutingRules.orgId} IS NULL)`, asc(ticketRoutingRules.position), asc(ticketRoutingRules.id));
}

/** Link rows the caller can see for these rules (an org reader sees only its own org's link). */
export async function linksFor(ruleIds: string[]): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>();
  if (ruleIds.length === 0) return out;
  const rows = await db
    .select({ ruleId: ticketRoutingRuleOrgLinks.ruleId, orgId: ticketRoutingRuleOrgLinks.orgId })
    .from(ticketRoutingRuleOrgLinks)
    .where(inArray(ticketRoutingRuleOrgLinks.ruleId, ruleIds))
    .orderBy(asc(ticketRoutingRuleOrgLinks.orgId));
  for (const r of rows) out.set(r.ruleId, [...(out.get(r.ruleId) ?? []), r.orgId]);
  return out;
}

/** The next position at the end of one owner's list. */
export async function nextPosition(owner: Owner): Promise<number> {
  const where = owner.orgId
    ? eq(ticketRoutingRules.orgId, owner.orgId)
    : and(isNull(ticketRoutingRules.orgId), eq(ticketRoutingRules.partnerId, owner.partnerId!));
  const [row] = await db.select({ max: max(ticketRoutingRules.position) }).from(ticketRoutingRules).where(where);
  return row?.max == null ? 0 : row.max + 1;
}

export async function insertRule(values: RuleInsert): Promise<RuleRow> {
  const [row] = await db.insert(ticketRoutingRules).values(values).returning();
  if (!row) throw new Error('ticket routing rule insert returned no row');
  return row;
}

export async function updateRule(id: string, set: Partial<RuleInsert>): Promise<RuleRow> {
  const [row] = await db.update(ticketRoutingRules).set({ ...set, updatedAt: new Date() }).where(eq(ticketRoutingRules.id, id)).returning();
  if (!row) throw new Error('ticket routing rule update matched no row');
  return row;
}

export async function deleteRule(id: string): Promise<boolean> {
  const rows = await db.delete(ticketRoutingRules).where(eq(ticketRoutingRules.id, id)).returning({ id: ticketRoutingRules.id });
  return rows.length > 0;
}

/** Replace a rule's org allowlist (the caller has set org_scoped to match). */
export async function replaceLinks(ruleId: string, orgIds: string[]): Promise<void> {
  await db.delete(ticketRoutingRuleOrgLinks).where(eq(ticketRoutingRuleOrgLinks.ruleId, ruleId));
  if (orgIds.length > 0) {
    await db.insert(ticketRoutingRuleOrgLinks).values(orgIds.map((orgId) => ({ ruleId, orgId })));
  }
}

/** positions 0..n-1 in the given order. */
export async function setPositions(ids: string[]): Promise<number> {
  let updated = 0;
  for (const [position, id] of ids.entries()) {
    const rows = await db.update(ticketRoutingRules).set({ position, updatedAt: new Date() }).where(eq(ticketRoutingRules.id, id)).returning({ id: ticketRoutingRules.id });
    updated += rows.length;
  }
  return updated;
}
