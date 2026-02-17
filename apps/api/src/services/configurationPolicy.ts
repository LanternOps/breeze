import { db } from '../db';
import {
  configurationPolicies,
  configPolicyFeatureLinks,
  configPolicyAssignments,
  configPolicyAlertRules,
  configPolicyAutomations,
  configPolicyComplianceRules,
  configPolicyPatchSettings,
  configPolicyMaintenanceSettings,
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
import { and, eq, desc, sql, inArray, asc, SQL } from 'drizzle-orm';
import type { AuthContext } from '../middleware/auth';

// ============================================
// Types
// ============================================

type ConfigFeatureType = 'patch' | 'alert_rule' | 'backup' | 'security' | 'monitoring' | 'maintenance' | 'compliance' | 'automation';
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

type DbExecutor = typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0];

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
  if (!policy) throw new Error('Failed to create configuration policy');
  return policy;
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
    // Escape LIKE special characters to prevent pattern injection
    const escaped = filters.search.replace(/[%_\\]/g, '\\$&');
    conditions.push(sql`${configurationPolicies.name} ILIKE ${'%' + escaped + '%'}`);
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
    .where(and(...conditions))
    .returning();

  if (!updated) return null;
  return updated;
}

export async function deleteConfigPolicy(id: string, auth: AuthContext) {
  const conditions: SQL[] = [eq(configurationPolicies.id, id)];
  const orgCond = auth.orgCondition(configurationPolicies.orgId);
  if (orgCond) conditions.push(orgCond);

  const [deleted] = await db
    .delete(configurationPolicies)
    .where(and(...conditions))
    .returning();
  return deleted ?? null;
}

// ============================================
// Decompose / Assemble — normalized per-feature tables
// ============================================

/**
 * Decompose inlineSettings JSONB into normalized per-feature table rows.
 * Should be called inside a transaction after the feature link row is inserted/updated.
 */
async function decomposeInlineSettings(
  linkId: string,
  featureType: ConfigFeatureType,
  settings: unknown,
  tx: Parameters<Parameters<typeof db.transaction>[0]>[0]
): Promise<void> {
  if (!settings || typeof settings !== 'object') return;

  const s = settings as Record<string, unknown>;

  switch (featureType) {
    case 'alert_rule': {
      const items = Array.isArray(s.items) ? s.items : [];
      if (items.length > 0) {
        const VALID_SEVERITIES = ['critical', 'high', 'medium', 'low', 'info'] as const;
        type AlertSeverity = (typeof VALID_SEVERITIES)[number];
        await tx.insert(configPolicyAlertRules).values(
          items.map((item: Record<string, unknown>, idx: number) => ({
            featureLinkId: linkId,
            name: String(item.name ?? `Rule ${idx + 1}`),
            severity: (VALID_SEVERITIES.includes(item.severity as AlertSeverity) ? item.severity : 'medium') as AlertSeverity,
            conditions: item.conditions ?? {},
            cooldownMinutes: typeof item.cooldownMinutes === 'number' ? item.cooldownMinutes : 5,
            autoResolve: typeof item.autoResolve === 'boolean' ? item.autoResolve : false,
            autoResolveConditions: item.autoResolveConditions ?? null,
            titleTemplate: typeof item.titleTemplate === 'string' ? item.titleTemplate : '{{ruleName}} triggered on {{deviceName}}',
            messageTemplate: typeof item.messageTemplate === 'string' ? item.messageTemplate : '{{ruleName}} condition met',
            sortOrder: typeof item.sortOrder === 'number' ? item.sortOrder : idx,
          }))
        );
      }
      break;
    }

    case 'automation': {
      const items = Array.isArray(s.items) ? s.items : [];
      if (items.length > 0) {
        const VALID_ON_FAILURE = ['stop', 'continue', 'notify'] as const;
        type OnFailure = (typeof VALID_ON_FAILURE)[number];
        await tx.insert(configPolicyAutomations).values(
          items.map((item: Record<string, unknown>, idx: number) => ({
            featureLinkId: linkId,
            name: String(item.name ?? `Automation ${idx + 1}`),
            enabled: typeof item.enabled === 'boolean' ? item.enabled : true,
            triggerType: String(item.triggerType ?? 'schedule'),
            cronExpression: typeof item.cronExpression === 'string' ? item.cronExpression : null,
            timezone: typeof item.timezone === 'string' && item.timezone.length > 0 ? item.timezone : 'UTC',
            eventType: typeof item.eventType === 'string' ? item.eventType : null,
            actions: item.actions ?? [],
            onFailure: (VALID_ON_FAILURE.includes(item.onFailure as OnFailure) ? item.onFailure : 'stop') as OnFailure,
            sortOrder: typeof item.sortOrder === 'number' ? item.sortOrder : idx,
          }))
        );
      }
      break;
    }

    case 'compliance': {
      const items = Array.isArray(s.items) ? s.items : [];
      if (items.length > 0) {
        const VALID_ENFORCEMENT = ['monitor', 'warn', 'enforce'] as const;
        type Enforcement = (typeof VALID_ENFORCEMENT)[number];
        await tx.insert(configPolicyComplianceRules).values(
          items.map((item: Record<string, unknown>, idx: number) => ({
            featureLinkId: linkId,
            name: String(item.name ?? `Compliance Rule ${idx + 1}`),
            rules: item.rules ?? {},
            enforcementLevel: (VALID_ENFORCEMENT.includes(item.enforcementLevel as Enforcement) ? item.enforcementLevel : 'monitor') as Enforcement,
            checkIntervalMinutes: typeof item.checkIntervalMinutes === 'number' ? item.checkIntervalMinutes : 60,
            remediationScriptId: typeof item.remediationScriptId === 'string' ? item.remediationScriptId : null,
            sortOrder: typeof item.sortOrder === 'number' ? item.sortOrder : idx,
          }))
        );
      }
      break;
    }

    case 'patch': {
      await tx.insert(configPolicyPatchSettings).values({
        featureLinkId: linkId,
        sources: Array.isArray(s.sources) ? s.sources as string[] : ['os'],
        autoApprove: typeof s.autoApprove === 'boolean' ? s.autoApprove : false,
        autoApproveSeverities: Array.isArray(s.autoApproveSeverities) ? s.autoApproveSeverities as string[] : [],
        scheduleFrequency: typeof s.scheduleFrequency === 'string' ? s.scheduleFrequency : 'weekly',
        scheduleTime: typeof s.scheduleTime === 'string' ? s.scheduleTime : '02:00',
        scheduleDayOfWeek: typeof s.scheduleDayOfWeek === 'string' ? s.scheduleDayOfWeek : 'sun',
        scheduleDayOfMonth: typeof s.scheduleDayOfMonth === 'number' ? s.scheduleDayOfMonth : 1,
        rebootPolicy: typeof s.rebootPolicy === 'string' ? s.rebootPolicy : 'if_required',
      });
      break;
    }

    case 'maintenance': {
      await tx.insert(configPolicyMaintenanceSettings).values({
        featureLinkId: linkId,
        recurrence: typeof s.recurrence === 'string' ? s.recurrence : 'weekly',
        durationHours: typeof s.durationHours === 'number' ? s.durationHours : 2,
        timezone: typeof s.timezone === 'string' ? s.timezone : 'UTC',
        windowStart: typeof s.windowStart === 'string' ? s.windowStart : null,
        suppressAlerts: typeof s.suppressAlerts === 'boolean' ? s.suppressAlerts : true,
        suppressPatching: typeof s.suppressPatching === 'boolean' ? s.suppressPatching : false,
        suppressAutomations: typeof s.suppressAutomations === 'boolean' ? s.suppressAutomations : false,
        suppressScripts: typeof s.suppressScripts === 'boolean' ? s.suppressScripts : false,
        notifyBeforeMinutes: typeof s.notifyBeforeMinutes === 'number' ? s.notifyBeforeMinutes : 15,
        notifyOnStart: typeof s.notifyOnStart === 'boolean' ? s.notifyOnStart : true,
        notifyOnEnd: typeof s.notifyOnEnd === 'boolean' ? s.notifyOnEnd : true,
      });
      break;
    }

    default:
      // monitoring, backup, security — no normalized tables yet
      break;
  }
}

/**
 * Delete existing normalized rows for a feature link.
 * Used before re-decomposing on update.
 */
async function deleteNormalizedRows(
  linkId: string,
  featureType: ConfigFeatureType,
  tx: Parameters<Parameters<typeof db.transaction>[0]>[0]
): Promise<void> {
  switch (featureType) {
    case 'alert_rule':
      await tx.delete(configPolicyAlertRules).where(eq(configPolicyAlertRules.featureLinkId, linkId));
      break;
    case 'automation':
      await tx.delete(configPolicyAutomations).where(eq(configPolicyAutomations.featureLinkId, linkId));
      break;
    case 'compliance':
      await tx.delete(configPolicyComplianceRules).where(eq(configPolicyComplianceRules.featureLinkId, linkId));
      break;
    case 'patch':
      await tx.delete(configPolicyPatchSettings).where(eq(configPolicyPatchSettings.featureLinkId, linkId));
      break;
    case 'maintenance':
      await tx.delete(configPolicyMaintenanceSettings).where(eq(configPolicyMaintenanceSettings.featureLinkId, linkId));
      break;
    default:
      break;
  }
}

/**
 * Assemble inlineSettings from normalized per-feature table rows.
 * Returns the reconstructed settings object, or null if the feature type
 * has no normalized table or no rows exist.
 */
async function assembleInlineSettings(
  featureType: ConfigFeatureType,
  linkId: string
): Promise<unknown | null> {
  switch (featureType) {
    case 'alert_rule': {
      const rows = await db
        .select()
        .from(configPolicyAlertRules)
        .where(eq(configPolicyAlertRules.featureLinkId, linkId))
        .orderBy(asc(configPolicyAlertRules.sortOrder));
      if (rows.length === 0) return null;
      return {
        items: rows.map((r) => ({
          name: r.name,
          severity: r.severity,
          conditions: r.conditions,
          cooldownMinutes: r.cooldownMinutes,
          autoResolve: r.autoResolve,
          autoResolveConditions: r.autoResolveConditions,
          titleTemplate: r.titleTemplate,
          messageTemplate: r.messageTemplate,
          sortOrder: r.sortOrder,
        })),
      };
    }

    case 'automation': {
      const rows = await db
        .select()
        .from(configPolicyAutomations)
        .where(eq(configPolicyAutomations.featureLinkId, linkId))
        .orderBy(asc(configPolicyAutomations.sortOrder));
      if (rows.length === 0) return null;
      return {
        items: rows.map((r) => ({
          name: r.name,
          enabled: r.enabled,
          triggerType: r.triggerType,
          cronExpression: r.cronExpression,
          timezone: r.timezone,
          eventType: r.eventType,
          actions: r.actions,
          onFailure: r.onFailure,
          sortOrder: r.sortOrder,
        })),
      };
    }

    case 'compliance': {
      const rows = await db
        .select()
        .from(configPolicyComplianceRules)
        .where(eq(configPolicyComplianceRules.featureLinkId, linkId))
        .orderBy(asc(configPolicyComplianceRules.sortOrder));
      if (rows.length === 0) return null;
      return {
        items: rows.map((r) => ({
          name: r.name,
          rules: r.rules,
          enforcementLevel: r.enforcementLevel,
          checkIntervalMinutes: r.checkIntervalMinutes,
          remediationScriptId: r.remediationScriptId,
          sortOrder: r.sortOrder,
        })),
      };
    }

    case 'patch': {
      const [row] = await db
        .select()
        .from(configPolicyPatchSettings)
        .where(eq(configPolicyPatchSettings.featureLinkId, linkId))
        .limit(1);
      if (!row) return null;
      return {
        sources: row.sources,
        autoApprove: row.autoApprove,
        autoApproveSeverities: row.autoApproveSeverities ?? [],
        scheduleFrequency: row.scheduleFrequency,
        scheduleTime: row.scheduleTime,
        scheduleDayOfWeek: row.scheduleDayOfWeek,
        scheduleDayOfMonth: row.scheduleDayOfMonth,
        rebootPolicy: row.rebootPolicy,
      };
    }

    case 'maintenance': {
      const [row] = await db
        .select()
        .from(configPolicyMaintenanceSettings)
        .where(eq(configPolicyMaintenanceSettings.featureLinkId, linkId))
        .limit(1);
      if (!row) return null;
      return {
        recurrence: row.recurrence,
        durationHours: row.durationHours,
        timezone: row.timezone,
        windowStart: row.windowStart,
        suppressAlerts: row.suppressAlerts,
        suppressPatching: row.suppressPatching,
        suppressAutomations: row.suppressAutomations,
        suppressScripts: row.suppressScripts,
        notifyBeforeMinutes: row.notifyBeforeMinutes,
        notifyOnStart: row.notifyOnStart,
        notifyOnEnd: row.notifyOnEnd,
      };
    }

    default:
      return null;
  }
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
  return db.transaction(async (tx) => {
    const [link] = await tx
      .insert(configPolicyFeatureLinks)
      .values({
        configPolicyId,
        featureType,
        featurePolicyId: featurePolicyId ?? null,
        inlineSettings: inlineSettings ?? null,
      })
      .returning();

    if (!link) throw new Error('Failed to create feature link');

    // Decompose inlineSettings into normalized per-feature table
    if (inlineSettings) {
      await decomposeInlineSettings(link.id, featureType, inlineSettings, tx);
    }

    return link;
  });
}

export async function updateFeatureLink(
  linkId: string,
  updates: { featurePolicyId?: string | null; inlineSettings?: unknown },
  configPolicyId?: string
) {
  return db.transaction(async (tx) => {
    // Fetch current link to get featureType, scoped to configPolicyId when provided
    const conditions = [eq(configPolicyFeatureLinks.id, linkId)];
    if (configPolicyId) {
      conditions.push(eq(configPolicyFeatureLinks.configPolicyId, configPolicyId));
    }
    const [existing] = await tx
      .select()
      .from(configPolicyFeatureLinks)
      .where(and(...conditions))
      .limit(1);
    if (!existing) return null;

    const setValues: Record<string, unknown> = { updatedAt: new Date() };
    if (updates.featurePolicyId !== undefined) setValues.featurePolicyId = updates.featurePolicyId;
    if (updates.inlineSettings !== undefined) setValues.inlineSettings = updates.inlineSettings;

    const [updated] = await tx
      .update(configPolicyFeatureLinks)
      .set(setValues)
      .where(eq(configPolicyFeatureLinks.id, linkId))
      .returning();

    // If inlineSettings changed, replace normalized rows (delete + re-insert)
    if (updates.inlineSettings !== undefined) {
      const featureType = existing.featureType as ConfigFeatureType;
      await deleteNormalizedRows(linkId, featureType, tx);
      if (updates.inlineSettings) {
        await decomposeInlineSettings(linkId, featureType, updates.inlineSettings, tx);
      }
    }

    return updated ?? null;
  });
}

export async function removeFeatureLink(linkId: string, configPolicyId: string) {
  const [deleted] = await db
    .delete(configPolicyFeatureLinks)
    .where(
      and(
        eq(configPolicyFeatureLinks.id, linkId),
        eq(configPolicyFeatureLinks.configPolicyId, configPolicyId)
      )
    )
    .returning();
  return deleted ?? null;
}

export async function listFeatureLinks(configPolicyId: string) {
  const links = await db
    .select()
    .from(configPolicyFeatureLinks)
    .where(eq(configPolicyFeatureLinks.configPolicyId, configPolicyId));

  // Assemble inlineSettings from normalized tables for each link
  const enriched = await Promise.all(
    links.map(async (link) => {
      const featureType = link.featureType as ConfigFeatureType;
      const assembled = await assembleInlineSettings(featureType, link.id);
      return {
        ...link,
        // Prefer assembled normalized data; fall back to stored JSONB
        inlineSettings: assembled ?? link.inlineSettings,
      };
    })
  );

  return enriched;
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
  if (!assignment) throw new Error('Failed to create policy assignment');
  return assignment;
}

export async function unassignPolicy(assignmentId: string, configPolicyId: string) {
  const [deleted] = await db
    .delete(configPolicyAssignments)
    .where(
      and(
        eq(configPolicyAssignments.id, assignmentId),
        eq(configPolicyAssignments.configPolicyId, configPolicyId)
      )
    )
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
      policyOrgId: configurationPolicies.orgId,
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

async function resolveEffectiveConfigWithExecutor(
  executor: DbExecutor,
  deviceId: string,
  auth: AuthContext
): Promise<EffectiveConfiguration | null> {
  // 1. Load device
  const deviceConditions: SQL[] = [eq(devices.id, deviceId)];
  const orgCond = auth.orgCondition(devices.orgId);
  if (orgCond) deviceConditions.push(orgCond);

  const [device] = await executor.select().from(devices).where(and(...deviceConditions)).limit(1);
  if (!device) return null;

  // 2. Load org for partnerId
  const [org] = await executor
    .select({ partnerId: organizations.partnerId })
    .from(organizations)
    .where(eq(organizations.id, device.orgId))
    .limit(1);

  // 3. Load device group memberships
  const groupRows = await executor
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
  const rows = await executor
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

export async function resolveEffectiveConfig(deviceId: string, auth: AuthContext): Promise<EffectiveConfiguration | null> {
  return resolveEffectiveConfigWithExecutor(db, deviceId, auth);
}

// ============================================
// Preview — diff current vs proposed
// ============================================

export async function previewEffectiveConfig(
  deviceId: string,
  changes: { add?: Array<{ configPolicyId: string; level: ConfigAssignmentLevel; targetId: string; priority?: number }>; remove?: string[] },
  auth: AuthContext
): Promise<{ current: EffectiveConfiguration | null; proposed: EffectiveConfiguration | null } | null> {
  // Resolve current config outside the transaction (read-only)
  const current = await resolveEffectiveConfig(deviceId, auth);
  if (!current) return null;

  // Use a transaction with forced rollback so changes are never committed.
  // This is safe for both adds and removes — the DB state is always restored.
  class PreviewRollback extends Error {}

  let proposed: EffectiveConfiguration | null = null;
  try {
    await db.transaction(async (tx) => {
      // Apply proposed additions
      if (changes.add?.length) {
        for (const assignment of changes.add) {
          await tx.insert(configPolicyAssignments).values({
            configPolicyId: assignment.configPolicyId,
            level: assignment.level,
            targetId: assignment.targetId,
            priority: assignment.priority ?? 0,
            assignedBy: auth.user.id,
          }).onConflictDoNothing();
        }
      }

      // Apply proposed removals
      if (changes.remove?.length) {
        await tx.delete(configPolicyAssignments).where(
          inArray(configPolicyAssignments.id, changes.remove)
        );
      }

      // Resolve the proposed config within the transaction's view
      proposed = await resolveEffectiveConfigWithExecutor(tx, deviceId, auth);

      // Force rollback — no changes are persisted
      throw new PreviewRollback();
    });
  } catch (err) {
    if (!(err instanceof PreviewRollback)) throw err;
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
    return { valid: true }; // inline-only is allowed; schema ensures inlineSettings is present
  }

  // Check if it's a reference to another Configuration Policy (whole-policy linking)
  const [configPolicy] = await db
    .select({ id: configurationPolicies.id })
    .from(configurationPolicies)
    .where(and(eq(configurationPolicies.id, featurePolicyId), eq(configurationPolicies.orgId, orgId)))
    .limit(1);

  if (configPolicy) {
    return { valid: true };
  }

  // Fall through to per-feature-type policy validation
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
    return { valid: false, error: `Policy "${featurePolicyId}" not found in this organization` };
  }

  return { valid: true };
}
