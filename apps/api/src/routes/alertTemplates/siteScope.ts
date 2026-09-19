import { and, eq, inArray } from 'drizzle-orm';
import { db } from '../../db';
import { alertRules, deviceGroups, devices, sites } from '../../db/schema';
import { siteAccessCheck, type AuthContext } from '../../middleware/auth';

type TargetType = 'all' | 'org' | 'site' | 'device' | 'group';

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

export function legacyRuleTarget(targets: unknown, orgId: string): {
  targetType: TargetType;
  targetId: string;
} {
  const value = record(targets);
  const deviceIds = Array.isArray(value.deviceIds) ? value.deviceIds : [];
  const siteIds = Array.isArray(value.siteIds) ? value.siteIds : [];
  if (typeof deviceIds[0] === 'string' && deviceIds[0]) {
    return { targetType: 'device', targetId: deviceIds[0] };
  }
  if (typeof siteIds[0] === 'string' && siteIds[0]) {
    return { targetType: 'site', targetId: siteIds[0] };
  }
  if (value.scope === 'organization') return { targetType: 'org', targetId: orgId };
  return { targetType: 'all', targetId: orgId };
}

export function persistedRuleTargets(rule: {
  targetType: string;
  targetId: string;
  overrideSettings?: unknown;
}): { targetType: string; targetIds: string[] } {
  const overrides = record(rule.overrideSettings);
  const storedTargets = record(overrides.targets);
  const targetType = typeof storedTargets.type === 'string' ? storedTargets.type : rule.targetType;
  const ids = new Set<string>();
  if (targetType !== 'all' && targetType !== 'org' && rule.targetId) ids.add(rule.targetId);
  if (Array.isArray(storedTargets.ids)) {
    for (const id of storedTargets.ids) if (typeof id === 'string' && id) ids.add(id);
  }
  if (Array.isArray(overrides.targetIds)) {
    for (const id of overrides.targetIds) if (typeof id === 'string' && id) ids.add(id);
  }
  return { targetType, targetIds: [...ids] };
}

export async function canAccessAlertRuleTargets(
  auth: Pick<AuthContext, 'allowedSiteIds'>,
  orgId: string,
  targetType: string,
  targetIds: string[],
  validateOwnership = true,
): Promise<boolean> {
  const restricted = auth.allowedSiteIds !== undefined;
  if (!restricted && !validateOwnership) return true;
  if (targetType === 'all' || targetType === 'org') return !restricted;

  const ids = [...new Set(targetIds.filter(Boolean))];
  if (ids.length === 0) return false;
  let rows: Array<{ id: string; orgId: string; siteId?: string | null }>;
  if (targetType === 'site') {
    rows = await db.select({ id: sites.id, orgId: sites.orgId })
      .from(sites).where(and(inArray(sites.id, ids), eq(sites.orgId, orgId)));
  } else if (targetType === 'device') {
    rows = await db.select({ id: devices.id, orgId: devices.orgId, siteId: devices.siteId })
      .from(devices).where(and(inArray(devices.id, ids), eq(devices.orgId, orgId)));
  } else if (targetType === 'group') {
    rows = await db.select({ id: deviceGroups.id, orgId: deviceGroups.orgId, siteId: deviceGroups.siteId })
      .from(deviceGroups).where(and(inArray(deviceGroups.id, ids), eq(deviceGroups.orgId, orgId)));
  } else {
    return false;
  }
  if (rows.length !== ids.length || rows.some((row) => row.orgId !== orgId)) return false;
  if (!restricted) return true;
  const canAccessSite = siteAccessCheck(auth.allowedSiteIds);
  return rows.every((row) => canAccessSite(targetType === 'site' ? row.id : row.siteId));
}

/** Every rule consuming a mutable template must remain inside the editor's grant. */
export async function canAccessTemplateDependents(
  auth: Pick<AuthContext, 'allowedSiteIds'>,
  templateId: string,
  orgId: string,
): Promise<boolean> {
  if (auth.allowedSiteIds === undefined) return true;
  const rules = await db.select({
    targetType: alertRules.targetType,
    targetId: alertRules.targetId,
    overrideSettings: alertRules.overrideSettings,
  }).from(alertRules).where(and(eq(alertRules.templateId, templateId), eq(alertRules.orgId, orgId)));
  for (const rule of rules) {
    const target = persistedRuleTargets(rule);
    if (!await canAccessAlertRuleTargets(auth, orgId, target.targetType, target.targetIds, true)) return false;
  }
  return true;
}
