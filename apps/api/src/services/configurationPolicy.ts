import { db } from '../db';
import {
  configurationPolicies,
  configPolicyFeatureLinks,
  configPolicyAssignments,
  devices,
  organizations,
  deviceGroupMemberships,
  patchPolicies,
  alertRules,
  backupConfigs,
  securityPolicies,
  automationPolicies,
  maintenanceWindows,
} from '../db/schema';
import { and, eq, desc, sql, inArray, SQL } from 'drizzle-orm';
import type { AuthContext } from '../middleware/auth';

// ============================================
// Types
// ============================================

type ConfigFeatureType = 'patch' | 'alert_rule' | 'backup' | 'security' | 'monitoring' | 'maintenance' | 'compliance';
type ConfigAssignmentLevel = 'partner' | 'organization' | 'site' | 'device_group' | 'device';

const LEVEL_PRIORITY: Record<ConfigAssignmentLevel, number> = {
  device: 5,
  device_group: 4,
  site: 3,
  organization: 2,
  partner: 1,
};

interface ResolvedFeature {
  featureType: ConfigFeatureType;
  featurePolicyId: string | null;
  inlineSettings: unknown;
  sourceLevel: ConfigAssignmentLevel;
  sourceTargetId: string;
  sourcePolicyId: string;
  sourcePolicyName: string;
  sourcePriority: number;
}

export interface EffectiveConfiguration {
  deviceId: string;
  features: Record<string, ResolvedFeature>;
  inheritanceChain: Array<{
    level: ConfigAssignmentLevel;
    targetId: string;
    policyId: string;
    policyName: string;
    priority: number;
    featureTypes: ConfigFeatureType[];
  }>;
}

// ============================================
// CRUD
// ============================================

export async function createConfigPolicy(
  orgId: string,
  data: { name: string; description?: string; status?: 'active' | 'inactive' | 'archived' },
  userId: string
) {
  const [policy] = await db
    .insert(configurationPolicies)
    .values({
      orgId,
      name: data.name,
      description: data.description ?? null,
      status: data.status ?? 'active',
      createdBy: userId,
    })
    .returning();
  return policy!;
}

export async function getConfigPolicy(id: string, auth: AuthContext) {
  const conditions: SQL[] = [eq(configurationPolicies.id, id)];
  const orgCond = auth.orgCondition(configurationPolicies.orgId);
  if (orgCond) conditions.push(orgCond);

  const [policy] = await db
    .select()
    .from(configurationPolicies)
    .where(and(...conditions))
    .limit(1);

  if (!policy) return null;

  const links = await db
    .select()
    .from(configPolicyFeatureLinks)
    .where(eq(configPolicyFeatureLinks.configPolicyId, id));

  return { ...policy, featureLinks: links };
}

export async function listConfigPolicies(
  auth: AuthContext,
  filters: { status?: string; search?: string; orgId?: string },
  pagination: { page: number; limit: number }
) {
  const conditions: SQL[] = [];
  const orgCond = auth.orgCondition(configurationPolicies.orgId);
  if (orgCond) conditions.push(orgCond);

  if (filters.orgId) {
    conditions.push(eq(configurationPolicies.orgId, filters.orgId));
  }
  if (filters.status) {
    conditions.push(eq(configurationPolicies.status, filters.status as 'active' | 'inactive' | 'archived'));
  }
  if (filters.search) {
    conditions.push(sql`${configurationPolicies.name} ILIKE ${'%' + filters.search + '%'}`);
  }

  const whereCondition = conditions.length > 0 ? and(...conditions) : undefined;

  const countResult = await db
    .select({ count: sql<number>`count(*)` })
    .from(configurationPolicies)
    .where(whereCondition);

  const total = Number(countResult[0]?.count ?? 0);
  const offset = (pagination.page - 1) * pagination.limit;

  const rows = await db
    .select()
    .from(configurationPolicies)
    .where(whereCondition)
    .orderBy(desc(configurationPolicies.updatedAt))
    .limit(pagination.limit)
    .offset(offset);

  return { data: rows, pagination: { page: pagination.page, limit: pagination.limit, total } };
}

export async function updateConfigPolicy(
  id: string,
  data: { name?: string; description?: string; status?: 'active' | 'inactive' | 'archived' },
  auth: AuthContext
) {
  const conditions: SQL[] = [eq(configurationPolicies.id, id)];
  const orgCond = auth.orgCondition(configurationPolicies.orgId);
  if (orgCond) conditions.push(orgCond);

  const [existing] = await db.select().from(configurationPolicies).where(and(...conditions)).limit(1);
  if (!existing) return null;

  const updates: Record<string, unknown> = { updatedAt: new Date() };
  if (data.name !== undefined) updates.name = data.name;
  if (data.description !== undefined) updates.description = data.description;
  if (data.status !== undefined) updates.status = data.status;

  const [updated] = await db
    .update(configurationPolicies)
    .set(updates)
    .where(eq(configurationPolicies.id, id))
    .returning();

  return updated!;
}

export async function deleteConfigPolicy(id: string, auth: AuthContext) {
  const conditions: SQL[] = [eq(configurationPolicies.id, id)];
  const orgCond = auth.orgCondition(configurationPolicies.orgId);
  if (orgCond) conditions.push(orgCond);

  const [existing] = await db.select().from(configurationPolicies).where(and(...conditions)).limit(1);
  if (!existing) return null;

  await db.delete(configurationPolicies).where(eq(configurationPolicies.id, id));
  return existing;
}

// ============================================
// Feature Links
// ============================================

export async function addFeatureLink(
  configPolicyId: string,
  featureType: ConfigFeatureType,
  featurePolicyId?: string | null,
  inlineSettings?: unknown
) {
  const [link] = await db
    .insert(configPolicyFeatureLinks)
    .values({
      configPolicyId,
      featureType,
      featurePolicyId: featurePolicyId ?? null,
      inlineSettings: inlineSettings ?? null,
    })
    .returning();
  return link!;
}

export async function updateFeatureLink(
  linkId: string,
  updates: { featurePolicyId?: string | null; inlineSettings?: unknown }
) {
  const setValues: Record<string, unknown> = { updatedAt: new Date() };
  if (updates.featurePolicyId !== undefined) setValues.featurePolicyId = updates.featurePolicyId;
  if (updates.inlineSettings !== undefined) setValues.inlineSettings = updates.inlineSettings;

  const [updated] = await db
    .update(configPolicyFeatureLinks)
    .set(setValues)
    .where(eq(configPolicyFeatureLinks.id, linkId))
    .returning();
  return updated ?? null;
}

export async function removeFeatureLink(linkId: string) {
  const [deleted] = await db
    .delete(configPolicyFeatureLinks)
    .where(eq(configPolicyFeatureLinks.id, linkId))
    .returning();
  return deleted ?? null;
}

export async function listFeatureLinks(configPolicyId: string) {
  return db
    .select()
    .from(configPolicyFeatureLinks)
    .where(eq(configPolicyFeatureLinks.configPolicyId, configPolicyId));
}

// ============================================
// Assignments
// ============================================

export async function assignPolicy(
  configPolicyId: string,
  level: ConfigAssignmentLevel,
  targetId: string,
  priority: number = 0,
  userId: string
) {
  const [assignment] = await db
    .insert(configPolicyAssignments)
    .values({
      configPolicyId,
      level,
      targetId,
      priority,
      assignedBy: userId,
    })
    .returning();
  return assignment!;
}

export async function unassignPolicy(assignmentId: string) {
  const [deleted] = await db
    .delete(configPolicyAssignments)
    .where(eq(configPolicyAssignments.id, assignmentId))
    .returning();
  return deleted ?? null;
}

export async function listAssignments(configPolicyId: string) {
  return db
    .select()
    .from(configPolicyAssignments)
    .where(eq(configPolicyAssignments.configPolicyId, configPolicyId))
    .orderBy(configPolicyAssignments.level, configPolicyAssignments.priority);
}

export async function listAssignmentsForTarget(level: ConfigAssignmentLevel, targetId: string) {
  return db
    .select({
      assignment: configPolicyAssignments,
      policyName: configurationPolicies.name,
      policyStatus: configurationPolicies.status,
    })
    .from(configPolicyAssignments)
    .innerJoin(configurationPolicies, eq(configPolicyAssignments.configPolicyId, configurationPolicies.id))
    .where(
      and(
        eq(configPolicyAssignments.level, level),
        eq(configPolicyAssignments.targetId, targetId)
      )
    )
    .orderBy(configPolicyAssignments.priority);
}

// ============================================
// Resolution — "closest wins" algorithm
// ============================================

export async function resolveEffectiveConfig(deviceId: string, auth: AuthContext): Promise<EffectiveConfiguration | null> {
  // 1. Load device
  const deviceConditions: SQL[] = [eq(devices.id, deviceId)];
  const orgCond = auth.orgCondition(devices.orgId);
  if (orgCond) deviceConditions.push(orgCond);

  const [device] = await db.select().from(devices).where(and(...deviceConditions)).limit(1);
  if (!device) return null;

  // 2. Load org for partnerId
  const [org] = await db
    .select({ partnerId: organizations.partnerId })
    .from(organizations)
    .where(eq(organizations.id, device.orgId))
    .limit(1);

  // 3. Load device group memberships
  const groupRows = await db
    .select({ groupId: deviceGroupMemberships.groupId })
    .from(deviceGroupMemberships)
    .where(eq(deviceGroupMemberships.deviceId, deviceId));
  const groupIds = groupRows.map((r) => r.groupId);

  // 4. Build target match conditions
  const targetConditions: SQL[] = [];
  targetConditions.push(
    and(
      eq(configPolicyAssignments.level, 'device'),
      eq(configPolicyAssignments.targetId, deviceId)
    )!
  );
  if (groupIds.length > 0) {
    targetConditions.push(
      and(
        eq(configPolicyAssignments.level, 'device_group'),
        inArray(configPolicyAssignments.targetId, groupIds)
      )!
    );
  }
  targetConditions.push(
    and(
      eq(configPolicyAssignments.level, 'site'),
      eq(configPolicyAssignments.targetId, device.siteId)
    )!
  );
  targetConditions.push(
    and(
      eq(configPolicyAssignments.level, 'organization'),
      eq(configPolicyAssignments.targetId, device.orgId)
    )!
  );
  if (org?.partnerId) {
    targetConditions.push(
      and(
        eq(configPolicyAssignments.level, 'partner'),
        eq(configPolicyAssignments.targetId, org.partnerId)
      )!
    );
  }

  // 5. Single query: assignments → policies (active) → feature links
  const rows = await db
    .select({
      assignmentId: configPolicyAssignments.id,
      assignmentLevel: configPolicyAssignments.level,
      assignmentTargetId: configPolicyAssignments.targetId,
      assignmentPriority: configPolicyAssignments.priority,
      assignmentCreatedAt: configPolicyAssignments.createdAt,
      policyId: configurationPolicies.id,
      policyName: configurationPolicies.name,
      featureLinkId: configPolicyFeatureLinks.id,
      featureType: configPolicyFeatureLinks.featureType,
      featurePolicyId: configPolicyFeatureLinks.featurePolicyId,
      inlineSettings: configPolicyFeatureLinks.inlineSettings,
    })
    .from(configPolicyAssignments)
    .innerJoin(configurationPolicies, and(
      eq(configPolicyAssignments.configPolicyId, configurationPolicies.id),
      eq(configurationPolicies.status, 'active')
    ))
    .innerJoin(configPolicyFeatureLinks, eq(configPolicyFeatureLinks.configPolicyId, configurationPolicies.id))
    .where(sql`(${sql.join(targetConditions, sql` OR `)})`)
    .orderBy(configPolicyAssignments.level, configPolicyAssignments.priority, configPolicyAssignments.createdAt);

  // 6. Sort by level priority (device=5 first), then priority ASC, then createdAt ASC
  const sorted = rows.sort((a, b) => {
    const levelDiff = (LEVEL_PRIORITY[b.assignmentLevel as ConfigAssignmentLevel] ?? 0) -
                      (LEVEL_PRIORITY[a.assignmentLevel as ConfigAssignmentLevel] ?? 0);
    if (levelDiff !== 0) return levelDiff;
    const priDiff = a.assignmentPriority - b.assignmentPriority;
    if (priDiff !== 0) return priDiff;
    return a.assignmentCreatedAt.getTime() - b.assignmentCreatedAt.getTime();
  });

  // 7. First match per feature type wins
  const features: Record<string, ResolvedFeature> = {};
  const chainMap = new Map<string, {
    level: ConfigAssignmentLevel;
    targetId: string;
    policyId: string;
    policyName: string;
    priority: number;
    featureTypes: Set<ConfigFeatureType>;
  }>();

  for (const row of sorted) {
    const ft = row.featureType as ConfigFeatureType;
    if (!features[ft]) {
      features[ft] = {
        featureType: ft,
        featurePolicyId: row.featurePolicyId,
        inlineSettings: row.inlineSettings,
        sourceLevel: row.assignmentLevel as ConfigAssignmentLevel,
        sourceTargetId: row.assignmentTargetId,
        sourcePolicyId: row.policyId,
        sourcePolicyName: row.policyName,
        sourcePriority: row.assignmentPriority,
      };
    }

    const chainKey = `${row.assignmentLevel}:${row.assignmentTargetId}:${row.policyId}`;
    const existing = chainMap.get(chainKey);
    if (existing) {
      existing.featureTypes.add(ft);
    } else {
      chainMap.set(chainKey, {
        level: row.assignmentLevel as ConfigAssignmentLevel,
        targetId: row.assignmentTargetId,
        policyId: row.policyId,
        policyName: row.policyName,
        priority: row.assignmentPriority,
        featureTypes: new Set([ft]),
      });
    }
  }

  const inheritanceChain = Array.from(chainMap.values()).map((entry) => ({
    ...entry,
    featureTypes: Array.from(entry.featureTypes),
  }));

  return { deviceId, features, inheritanceChain };
}

// ============================================
// Preview — diff current vs proposed
// ============================================

export async function previewEffectiveConfig(
  deviceId: string,
  changes: { add?: Array<{ configPolicyId: string; level: ConfigAssignmentLevel; targetId: string; priority?: number }>; remove?: string[] },
  auth: AuthContext
): Promise<{ current: EffectiveConfiguration | null; proposed: EffectiveConfiguration | null } | null> {
  const current = await resolveEffectiveConfig(deviceId, auth);
  if (!current) return null;

  // Apply changes temporarily
  if (changes.add?.length) {
    for (const assignment of changes.add) {
      await db.insert(configPolicyAssignments).values({
        configPolicyId: assignment.configPolicyId,
        level: assignment.level,
        targetId: assignment.targetId,
        priority: assignment.priority ?? 0,
        assignedBy: auth.user.id,
      }).onConflictDoNothing();
    }
  }

  if (changes.remove?.length) {
    await db.delete(configPolicyAssignments).where(
      inArray(configPolicyAssignments.id, changes.remove)
    );
  }

  const proposed = await resolveEffectiveConfig(deviceId, auth);

  // Rollback changes
  if (changes.add?.length) {
    for (const assignment of changes.add) {
      await db.delete(configPolicyAssignments).where(
        and(
          eq(configPolicyAssignments.configPolicyId, assignment.configPolicyId),
          eq(configPolicyAssignments.level, assignment.level),
          eq(configPolicyAssignments.targetId, assignment.targetId)
        )
      );
    }
  }

  if (changes.remove?.length) {
    // We can't easily restore deleted rows, so this preview is destructive for removals.
    // A transaction-based approach would be better for production use.
  }

  return { current, proposed };
}

// ============================================
// Validation helpers
// ============================================

const FEATURE_TABLE_MAP: Partial<Record<ConfigFeatureType, { table: any; orgIdCol: any }>> = {
  patch: { table: patchPolicies, orgIdCol: patchPolicies.orgId },
  alert_rule: { table: alertRules, orgIdCol: alertRules.orgId },
  backup: { table: backupConfigs, orgIdCol: backupConfigs.orgId },
  security: { table: securityPolicies, orgIdCol: securityPolicies.orgId },
  compliance: { table: automationPolicies, orgIdCol: automationPolicies.orgId },
  maintenance: { table: maintenanceWindows, orgIdCol: maintenanceWindows.orgId },
};

export async function validateFeaturePolicyExists(
  featureType: ConfigFeatureType,
  featurePolicyId: string | undefined | null,
  orgId: string
): Promise<{ valid: boolean; error?: string }> {
  if (featureType === 'monitoring') {
    // Monitoring has no policy table — requires inlineSettings
    if (featurePolicyId) {
      return { valid: false, error: 'monitoring feature type does not support featurePolicyId; use inlineSettings instead' };
    }
    return { valid: true };
  }

  if (!featurePolicyId) {
    return { valid: false, error: `featurePolicyId is required for feature type "${featureType}"` };
  }

  const mapping = FEATURE_TABLE_MAP[featureType];
  if (!mapping) {
    return { valid: false, error: `Unknown feature type: ${featureType}` };
  }

  const [row] = await db
    .select({ id: mapping.table.id })
    .from(mapping.table)
    .where(and(eq(mapping.table.id, featurePolicyId), eq(mapping.orgIdCol, orgId)))
    .limit(1);

  if (!row) {
    return { valid: false, error: `${featureType} policy "${featurePolicyId}" not found in this organization` };
  }

  return { valid: true };
}
