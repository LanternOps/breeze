import { db } from '../../db';
import { alertTemplates, alertCorrelations, alerts } from '../../db/schema';
import { eq, and, or, isNull, desc, gte, sql, inArray } from 'drizzle-orm';
import { getPagination } from '../../utils/pagination';

export { getPagination } from '../../utils/pagination';

export function paginate<T>(items: T[], query: { page?: string; limit?: string }) {
  const { page, limit, offset } = getPagination(query);
  return {
    data: items.slice(offset, offset + limit),
    page,
    limit,
    total: items.length
  };
}

export function parseBoolean(value?: string) {
  if (value === 'true') return true;
  if (value === 'false') return false;
  return undefined;
}

export function resolveScopedOrgId(
  auth: {
    scope: 'system' | 'partner' | 'organization';
    orgId?: string | null;
    accessibleOrgIds?: string[] | null;
  }
) {
  if (auth.orgId) {
    return auth.orgId;
  }

  if (auth.scope === 'partner' && Array.isArray(auth.accessibleOrgIds) && auth.accessibleOrgIds.length === 1) {
    return auth.accessibleOrgIds[0] ?? null;
  }

  return null;
}

/**
 * Get all templates visible to an org: built-in (orgId IS NULL) + org's custom templates
 */
export async function getAllTemplates(orgId: string) {
  return db
    .select()
    .from(alertTemplates)
    .where(
      or(
        eq(alertTemplates.isBuiltIn, true),
        eq(alertTemplates.orgId, orgId)
      )
    )
    .orderBy(desc(alertTemplates.isBuiltIn), alertTemplates.name);
}

/**
 * Get a template by ID, checking org access
 */
export async function getTemplateById(templateId: string, orgId: string) {
  const [template] = await db
    .select()
    .from(alertTemplates)
    .where(
      and(
        eq(alertTemplates.id, templateId),
        or(
          eq(alertTemplates.isBuiltIn, true),
          eq(alertTemplates.orgId, orgId)
        )
      )
    )
    .limit(1);

  return template ?? null;
}

/**
 * Check if a template is built-in
 */
export async function isBuiltInTemplate(templateId: string): Promise<boolean> {
  const [template] = await db
    .select({ isBuiltIn: alertTemplates.isBuiltIn })
    .from(alertTemplates)
    .where(eq(alertTemplates.id, templateId))
    .limit(1);

  return template?.isBuiltIn === true;
}

/**
 * Get correlation links for an alert from the real DB
 */
export async function getCorrelationLinksForAlert(alertId: string) {
  return db
    .select()
    .from(alertCorrelations)
    .where(
      or(
        eq(alertCorrelations.parentAlertId, alertId),
        eq(alertCorrelations.childAlertId, alertId)
      )
    );
}

/**
 * Get related alerts via correlation links
 */
export async function getRelatedAlerts(alertId: string) {
  const links = await getCorrelationLinksForAlert(alertId);
  const relatedIds = new Set<string>();
  for (const link of links) {
    relatedIds.add(link.parentAlertId === alertId ? link.childAlertId : link.parentAlertId);
  }

  if (relatedIds.size === 0) return [];

  const ids = [...relatedIds];
  return db
    .select()
    .from(alerts)
    .where(inArray(alerts.id, ids));
}
