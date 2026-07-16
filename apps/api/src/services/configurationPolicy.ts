import { db, runOutsideDbContext, withSystemDbAccessContext } from '../db';
import {
  configurationPolicies,
  configPolicyFeatureLinks,
  configPolicyAssignments,
  configPolicyAlertRules,
  configPolicyAutomations,
  configPolicyComplianceRules,
  configPolicyPatchSettings,
  configPolicyMaintenanceSettings,
  configPolicyEventLogSettings,
  configPolicySensitiveDataSettings,
  configPolicyMonitoringSettings,
  configPolicyMonitoringWatches,
  configPolicyRemoteAccessSettings,
  configPolicyBackupSettings,
  configPolicyOnedriveSettings,
  configPolicyOnedriveLibraries,
  devices,
  deviceGroups,
  organizations,
  deviceGroupMemberships,
  sites,
  patchPolicies,
  alertRules,
  backupConfigs,
  backupProfiles,
  securityPolicies,
  automationPolicies,
  maintenanceWindows,
  softwarePolicies,
  sensitiveDataPolicies,
  peripheralPolicies,
} from '../db/schema';
import { and, eq, desc, or, sql, inArray, asc, getTableColumns, SQL } from 'drizzle-orm';
import { canManagePartnerWidePolicies, PartnerWideWriteDeniedError } from './partnerWideAccess';
import { z } from 'zod';
import {
  backupExcludePatternsSchema,
  configFeatureInlineSettingsSchema,
  eventLogInlineSettingsSchema,
  monitoringInlineSettingsSchema,
  onedriveHelperInlineSettingsSchema,
  remoteAccessInlineSettingsSchema as remoteAccessCapabilitySettingsSchema,
} from '@breeze/shared/validators';
import type { AuthContext } from '../middleware/auth';
import { normalizePatchInlineSettings, tryNormalizePatchInlineSettings } from './configPolicyPatching';
import { resolvePartnerIdForOrg } from '../routes/patches/helpers';
import { getPolicyBaselineDefaults } from './policyBaselineDefaults';

// ============================================
// Inline settings schemas
// ============================================

// Remote access session consent/notification enums — shared between the
// consent-subset schema (decompose path, defaults applied) and the write-path
// schema (route validation, plain optionals) below.
const sessionPromptModeSchema = z.enum(['off', 'notify', 'consent']);
const consentUnavailableBehaviorSchema = z.enum(['proceed', 'block']);
const technicianIdentityLevelSchema = z.enum(['name_email', 'name', 'generic']);

// Remote access session consent/notification settings (#1694) — the SUBSET of
// the `remote_access` inlineSettings blob that decomposes into the normalized
// config_policy_remote_access_settings row. All fields default so {} is valid.
// Deliberately NOT strict: the same blob also carries the agent-facing
// capability fields (webrtcDesktop, vncRelay, clipboard*, proxy, limits — see
// remoteAccessInlineSettingsSchema in @breeze/shared/validators), which this
// pick must ignore rather than reject (#2320).
export const remoteAccessConsentSettingsSchema = z.object({
  sessionPromptMode: sessionPromptModeSchema.default('notify'),
  consentUnavailableBehavior: consentUnavailableBehaviorSchema.default('proceed'),
  notifyOnSessionEnd: z.boolean().default(true),
  showActiveIndicator: z.boolean().default(true),
  technicianIdentityLevel: technicianIdentityLevelSchema.default('name_email'),
});

// Write-path validation for the WHOLE remote_access inlineSettings blob: the
// capability fields the RemoteAccessTab edits (shared validator — the same
// shape resolveRemoteAccessForDevice parses on the agent path) plus the
// consent fields above, all optional. #1694 replaced this with the
// consent-only .strict() schema, which rejected every capability-shape payload
// ("Unrecognized keys: webrtcDesktop, ...") and made the Remote Access tab
// unsavable (#2320). Non-strict on purpose: pre-existing rows can carry stale
// keys that the tab round-trips back on save — strip them, don't reject.
// Exported so routes can import the same schema (single source of truth).
export const remoteAccessInlineSettingsSchema = remoteAccessCapabilitySettingsSchema.extend({
  sessionPromptMode: sessionPromptModeSchema.optional(),
  consentUnavailableBehavior: consentUnavailableBehaviorSchema.optional(),
  notifyOnSessionEnd: z.boolean().optional(),
  showActiveIndicator: z.boolean().optional(),
  technicianIdentityLevel: technicianIdentityLevelSchema.optional(),
});

// Exported so the route can import the same schema (single source of truth).
// uacInterceptionEnabled defaults to false on the read side (parsePamSettings)
// — capture is opt-in, so {} is well-formed and means "no capture". Non-boolean
// values are rejected to prevent a silent-inversion bug where "false" (string)
// is coerced back to the default on read-back.
// .strict() matches the posture of patch/backup: unknown keys are rejected.
export const pamInlineSettingsSchema = z
  .object({
    uacInterceptionEnabled: z.boolean().optional(),
  })
  .strict();

// Vulnerability scanning is a single opt-in toggle (BE-16 correlation gating).
// `enabled` defaults to false so an absent/empty settings object means "off" —
// the per-device gate (resolveVulnerabilityEnabledForDevice) and the daily
// correlation job both treat no-policy / enabled:false as disabled. .strict()
// rejects unknown keys, matching pam/patch posture.
export const vulnerabilityInlineSettingsSchema = z
  .object({
    enabled: z.boolean().default(false),
  })
  .strict();

// ============================================
// Types
// ============================================

// CONFIG_FEATURE_TYPES / ConfigFeatureType live in a leaf module to avoid a
// configurationPolicy ⇄ policyBaselineDefaults import cycle (and to keep route/
// helper test suites from transitively crash-loading this service). Re-exported
// here so existing importers that read them from configurationPolicy still work.
import { CONFIG_FEATURE_TYPES, type ConfigFeatureType } from './configFeatureTypes';
export { CONFIG_FEATURE_TYPES };
export type { ConfigFeatureType };
export type ConfigAssignmentLevel = 'partner' | 'organization' | 'site' | 'device_group' | 'device';

// Discriminated union so a valid result can't carry a stray error string and
// an invalid result can't omit one — every `return` in validateAssignmentTarget
// below conforms.
export type AssignmentTargetValidation = { valid: true } | { valid: false; error: string };

const LEVEL_PRIORITY: Record<ConfigAssignmentLevel, number> = {
  device: 5,
  device_group: 4,
  site: 3,
  organization: 2,
  partner: 1,
};

const BREEZE_DEFAULTS_SENTINEL = 'breeze-defaults';

interface ResolvedFeature {
  featureType: ConfigFeatureType;
  featurePolicyId: string | null;
  inlineSettings: unknown;
  sourceLevel: ConfigAssignmentLevel | 'default';
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
    level: ConfigAssignmentLevel | 'default';
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

/**
 * Access condition for a configuration_policies row, honoring both ownership
 * axes (#1724). A caller may reach a row that is owned by an org they can
 * access (the original shape) OR owned by their own partner (partner-wide /
 * all-orgs policies, org_id NULL). System scope returns undefined (no filter).
 *
 * This app-layer condition keeps partner-owned policies visible to
 * partner-scoped reads that filter by `auth.orgCondition` (which would
 * otherwise exclude org_id IS NULL rows). RLS is STRICTER, not identical:
 * breeze_has_partner_access only passes for partner-scope callers, so
 * org-scope tokens (which also carry a partnerId) never see partner-wide
 * rows — see configurationPoliciesPartnerRls.integration.test.ts. The branch
 * is therefore gated on partner scope so app and DB agree.
 */
export function policyAccessCondition(auth: AuthContext): SQL | undefined {
  const orgCond = auth.orgCondition(configurationPolicies.orgId);
  // System scope: no filter on either axis.
  if (!orgCond) return undefined;
  if (auth.scope === 'partner' && auth.partnerId) {
    return and(
      sql`(${orgCond} OR (${configurationPolicies.orgId} IS NULL AND ${configurationPolicies.partnerId} = ${auth.partnerId}))`
    );
  }
  return orgCond;
}

// The partner-wide capability gate lives in the dependency-free leaf module
// services/partnerWideAccess.ts (so routes/workers/AI tools can import it
// without this service's schema graph). Re-exported here for back-compat:
// HTTP routes gate with it directly, and updateConfigPolicy/deleteConfigPolicy
// enforce it via PartnerWideWriteDeniedError so non-route callers (AI tools)
// are covered too.
export {
  canManagePartnerWidePolicies,
  PARTNER_WIDE_WRITE_DENIED_MESSAGE,
  PartnerWideWriteDeniedError,
} from './partnerWideAccess';

export async function createConfigPolicy(
  owner: { orgId: string; partnerId?: null } | { orgId?: null; partnerId: string },
  data: { name: string; description?: string; status?: 'active' | 'inactive' | 'archived' },
  userId: string
) {
  const [policy] = await db
    .insert(configurationPolicies)
    .values({
      orgId: owner.orgId ?? null,
      partnerId: owner.partnerId ?? null,
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
  const accessCond = policyAccessCondition(auth);
  if (accessCond) conditions.push(accessCond);

  // orgName lets the UI label org-owned policies with their owning org
  // (partner-wide rows have orgId NULL, so orgName comes back NULL too).
  const [policy] = await db
    .select({ ...getTableColumns(configurationPolicies), orgName: organizations.name })
    .from(configurationPolicies)
    .leftJoin(organizations, eq(configurationPolicies.orgId, organizations.id))
    .where(and(...conditions))
    .limit(1);

  if (!policy) return null;

  const featureLinks = await listFeatureLinks(id);

  return { ...policy, featureLinks };
}

export async function listConfigPolicies(
  auth: AuthContext,
  filters: { status?: string; search?: string; orgId?: string },
  pagination: { page: number; limit: number }
) {
  const conditions: SQL[] = [];
  const accessCond = policyAccessCondition(auth);
  if (accessCond) conditions.push(accessCond);

  if (filters.orgId) {
    // Include the partner-wide policies (org_id NULL) that govern the filtered
    // org alongside its org-owned ones — a partner-wide policy applies to EVERY
    // org under its partner, so an org-filtered list that hid them would
    // misrepresent which policies actually apply (and the UI has no separate
    // surface for them). The NULL branch is scoped to THE FILTERED ORG'S OWN
    // partner, not merely the caller's visibility: for a system-scope caller
    // policyAccessCondition is no filter at all, and a bare `OR org_id IS NULL`
    // would return every partner's partner-wide policies platform-wide. If the
    // org row is missing (or RLS-invisible to the caller), fall back to the
    // plain org filter — fail-closed, never fail-open. (#1724 follow-up)
    const [orgRow] = await db
      .select({ partnerId: organizations.partnerId })
      .from(organizations)
      .where(eq(organizations.id, filters.orgId))
      .limit(1);
    const orgPartnerId = orgRow?.partnerId ?? null;
    conditions.push(
      orgPartnerId
        ? sql`(${configurationPolicies.orgId} = ${filters.orgId} OR (${configurationPolicies.orgId} IS NULL AND ${configurationPolicies.partnerId} = ${orgPartnerId}))`
        : eq(configurationPolicies.orgId, filters.orgId)
    );
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
    .select({ ...getTableColumns(configurationPolicies), orgName: organizations.name })
    .from(configurationPolicies)
    .leftJoin(organizations, eq(configurationPolicies.orgId, organizations.id))
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
  const accessCond = policyAccessCondition(auth);
  if (accessCond) conditions.push(accessCond);

  const [existing] = await db.select().from(configurationPolicies).where(and(...conditions)).limit(1);
  if (!existing) return null;

  // Partner-wide policies are READABLE by any member of the partner but
  // administrable only with orgAccess='all' — same blast-radius rationale as
  // the create-time guard. Enforced here (not just in routes) so every caller,
  // including AI tool handlers, hits the same gate.
  if (existing.orgId === null && !canManagePartnerWidePolicies(auth)) {
    throw new PartnerWideWriteDeniedError();
  }

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
  const accessCond = policyAccessCondition(auth);
  if (accessCond) conditions.push(accessCond);

  // Pre-fetch to apply the partner-wide administration gate (see
  // updateConfigPolicy) before the destructive statement.
  const [existing] = await db
    .select({ orgId: configurationPolicies.orgId })
    .from(configurationPolicies)
    .where(and(...conditions))
    .limit(1);
  if (!existing) return null;
  if (existing.orgId === null && !canManagePartnerWidePolicies(auth)) {
    throw new PartnerWideWriteDeniedError();
  }

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
          items.map((item: Record<string, unknown>, idx: number) => {
            // Extract remediationScriptId from per-rule remediation for backward compat
            let scriptId: string | null = null;
            if (typeof item.remediationScriptId === 'string') {
              scriptId = item.remediationScriptId;
            } else if (Array.isArray(item.rules)) {
              const firstScript = (item.rules as Record<string, unknown>[]).find(
                (r) => (r.remediation as Record<string, unknown>)?.type === 'script'
              );
              if (firstScript) {
                const rem = firstScript.remediation as Record<string, unknown>;
                if (typeof rem?.scriptId === 'string') scriptId = rem.scriptId;
              }
            }
            return {
              featureLinkId: linkId,
              name: String(item.name ?? `Compliance Rule ${idx + 1}`),
              rules: item.rules ?? {},
              enforcementLevel: (VALID_ENFORCEMENT.includes(item.enforcementLevel as Enforcement) ? item.enforcementLevel : 'monitor') as Enforcement,
              checkIntervalMinutes: typeof item.checkIntervalMinutes === 'number' ? item.checkIntervalMinutes : 60,
              remediationScriptId: scriptId,
              sortOrder: typeof item.sortOrder === 'number' ? item.sortOrder : idx,
            };
          })
        );
      }
      break;
    }

    case 'patch': {
      const parsed = normalizePatchInlineSettings(s);
      await tx.insert(configPolicyPatchSettings).values({
        featureLinkId: linkId,
        sources: parsed.sources,
        autoApprove: parsed.autoApprove,
        autoApproveSeverities: parsed.autoApproveSeverities,
        scheduleFrequency: parsed.scheduleFrequency,
        scheduleTime: parsed.scheduleTime,
        scheduleDayOfWeek: parsed.scheduleDayOfWeek,
        scheduleDayOfMonth: parsed.scheduleDayOfMonth,
        rebootPolicy: parsed.rebootPolicy,
        exclusiveWindowsUpdate: parsed.exclusiveWindowsUpdate,
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
        rebootIfPending: typeof s.rebootIfPending === 'boolean' ? s.rebootIfPending : false,
        notifyBeforeMinutes: typeof s.notifyBeforeMinutes === 'number' ? s.notifyBeforeMinutes : 15,
        notifyOnStart: typeof s.notifyOnStart === 'boolean' ? s.notifyOnStart : true,
        notifyOnEnd: typeof s.notifyOnEnd === 'boolean' ? s.notifyOnEnd : true,
      });
      break;
    }

    case 'event_log': {
      const parsed = eventLogInlineSettingsSchema.parse(s);
      await tx.insert(configPolicyEventLogSettings).values({
        featureLinkId: linkId,
        ...parsed,
      });
      break;
    }

    case 'sensitive_data': {
      await tx.insert(configPolicySensitiveDataSettings).values({
        featureLinkId: linkId,
        detectionClasses: Array.isArray(s.detectionClasses) ? s.detectionClasses as string[] : ['credential'],
        includePaths: Array.isArray(s.includePaths) ? s.includePaths as string[] : [],
        excludePaths: Array.isArray(s.excludePaths) ? s.excludePaths as string[] : [],
        fileTypes: Array.isArray(s.fileTypes) ? s.fileTypes as string[] : [],
        maxFileSizeBytes: typeof s.maxFileSizeBytes === 'number' ? s.maxFileSizeBytes : 104857600,
        workers: typeof s.workers === 'number' ? s.workers : 4,
        timeoutSeconds: typeof s.timeoutSeconds === 'number' ? s.timeoutSeconds : 300,
        suppressPatternIds: Array.isArray(s.suppressPatternIds) ? s.suppressPatternIds as string[] : [],
        scheduleType: typeof s.scheduleType === 'string' ? s.scheduleType : 'manual',
        intervalMinutes: typeof s.intervalMinutes === 'number' ? s.intervalMinutes : null,
        cron: typeof s.cron === 'string' ? s.cron : null,
        timezone: typeof s.timezone === 'string' ? s.timezone : 'UTC',
      });
      break;
    }

    case 'monitoring': {
      const parsed = monitoringInlineSettingsSchema.parse(s);
      const [settingsRow] = await tx.insert(configPolicyMonitoringSettings).values({
        featureLinkId: linkId,
        checkIntervalSeconds: parsed.checkIntervalSeconds,
      }).returning();
      if (settingsRow && parsed.watches.length > 0) {
        const VALID_SEVERITIES = ['critical', 'high', 'medium', 'low', 'info'] as const;
        type AlertSeverity = (typeof VALID_SEVERITIES)[number];
        await tx.insert(configPolicyMonitoringWatches).values(
          parsed.watches.map((w, idx) => ({
            settingsId: settingsRow.id,
            watchType: w.watchType as 'service' | 'process',
            name: w.name,
            displayName: w.displayName ?? null,
            enabled: w.enabled,
            alertOnStop: w.alertOnStop,
            alertAfterConsecutiveFailures: w.alertAfterConsecutiveFailures,
            alertSeverity: (VALID_SEVERITIES.includes(w.alertSeverity as AlertSeverity) ? w.alertSeverity : 'high') as AlertSeverity,
            cpuThresholdPercent: w.cpuThresholdPercent ?? null,
            memoryThresholdMb: w.memoryThresholdMb ?? null,
            thresholdDurationSeconds: w.thresholdDurationSeconds,
            autoRestart: w.autoRestart,
            maxRestartAttempts: w.maxRestartAttempts,
            restartCooldownSeconds: w.restartCooldownSeconds,
            sortOrder: idx,
          }))
        );
      }

      // Insert event log alert rules (only enabled ones)
      if (parsed.eventLogAlerts?.length > 0) {
        const VALID_SEVERITIES = ['critical', 'high', 'medium', 'low', 'info'] as const;
        type AlertSev = (typeof VALID_SEVERITIES)[number];
        for (const alert of parsed.eventLogAlerts) {
          if (!alert.enabled) continue;
          await tx.insert(configPolicyAlertRules).values({
            featureLinkId: linkId,
            name: alert.name,
            severity: (VALID_SEVERITIES.includes(alert.severity as AlertSev) ? alert.severity : 'high') as AlertSev,
            conditions: [{
              type: 'event_log' as const,
              category: alert.category,
              level: alert.level,
              sourcePattern: alert.sourcePattern || undefined,
              messagePattern: alert.messagePattern || undefined,
              countThreshold: alert.countThreshold,
              windowMinutes: alert.windowMinutes,
            }],
            cooldownMinutes: alert.windowMinutes,
            autoResolve: true,
          });
        }
      }

      // Insert metric/status/custom alert rules
      if (parsed.alertRules?.length > 0) {
        const VALID_SEVERITIES = ['critical', 'high', 'medium', 'low', 'info'] as const;
        type AlertSev = (typeof VALID_SEVERITIES)[number];
        await tx.insert(configPolicyAlertRules).values(
          parsed.alertRules.map((item, idx) => ({
            featureLinkId: linkId,
            name: item.name,
            severity: (VALID_SEVERITIES.includes(item.severity as AlertSev) ? item.severity : 'medium') as AlertSev,
            conditions: item.conditions,
            cooldownMinutes: item.cooldownMinutes,
            autoResolve: item.autoResolve,
            sortOrder: 1000 + idx,
          }))
        );
      }
      break;
    }

    case 'backup': {
      // Settings mirror the parent policy's ownership axis (org XOR partner —
      // spec 2026-07-13; partner-wide backup links are supported since
      // profiles + org-default destinations replaced the old #1724 rejection).
      const [policyRow] = await tx
        .select({
          orgId: configurationPolicies.orgId,
          partnerId: configurationPolicies.partnerId,
          featurePolicyId: configPolicyFeatureLinks.featurePolicyId,
        })
        .from(configPolicyFeatureLinks)
        .innerJoin(configurationPolicies, eq(configPolicyFeatureLinks.configPolicyId, configurationPolicies.id))
        .where(eq(configPolicyFeatureLinks.id, linkId))
        .limit(1);
      if (!policyRow) throw new Error(`Cannot resolve ownership for feature link ${linkId}`);
      if (!policyRow.orgId && !policyRow.partnerId) {
        throw new Error('Configuration policy has no owning organization or partner');
      }

      // featurePolicyId is a backup_profiles id (preferred) or, on legacy
      // links, the org's backup_configs (destination) id.
      let backupProfileId: string | null = null;
      let legacyDestinationId: string | null = null;
      if (policyRow.featurePolicyId) {
        const [profile] = await tx
          .select({ id: backupProfiles.id })
          .from(backupProfiles)
          .where(eq(backupProfiles.id, policyRow.featurePolicyId))
          .limit(1);
        if (profile) {
          backupProfileId = profile.id;
        } else {
          legacyDestinationId = policyRow.featurePolicyId;
        }
      }

      const requestedDestination =
        typeof s.destinationConfigId === 'string' && s.destinationConfigId
          ? s.destinationConfigId
          : null;
      const destinationConfigId = requestedDestination ?? legacyDestinationId;
      if (destinationConfigId) {
        // NULL means "resolve the device org's default destination at job
        // time" — the only valid choice for partner-wide policies, whose
        // devices span orgs.
        if (!policyRow.orgId) {
          throw new Error('Partner-wide backup links resolve each organization\'s default destination; do not set a destination config');
        }
        // Destination must belong to the policy's own org: the FK proves
        // existence but not tenancy, and job dispatch writes to whatever
        // destination this row names.
        const [destination] = await tx
          .select({ id: backupConfigs.id })
          .from(backupConfigs)
          .where(and(eq(backupConfigs.id, destinationConfigId), eq(backupConfigs.orgId, policyRow.orgId)))
          .limit(1);
        if (!destination) {
          throw new Error('Backup destination not found in this organization');
        }
      }

      // #2473 backstop for file-mode exclusion globs.
      //
      // The HTTP routes validate inlineSettings with backupInlineSettingsSchema,
      // but the AI/MCP `manage_policy_feature_link` tool takes inlineSettings as
      // an unvalidated `z.record(z.string(), z.unknown())` and hands it straight
      // to addFeatureLink/updateFeatureLink. Both land here, so this is the last
      // chokepoint before a malformed glob is persisted and shipped to the
      // agent (which would silently ignore it and back the files up anyway).
      //
      // Scoped deliberately to `excludes`: re-parsing the whole blob with
      // backupInlineSettingsSchema would reject profile-linked links, whose
      // targets are legitimately empty because "what to protect" lives on the
      // linked profile.
      const rawTargets = (s.targets ?? {}) as Record<string, unknown>;
      let targets = rawTargets;
      if (rawTargets.excludes !== undefined) {
        const parsed = backupExcludePatternsSchema.safeParse(rawTargets.excludes);
        if (!parsed.success) {
          const detail = parsed.error.issues.map((i) => i.message).join('; ');
          throw new Error(`Invalid backup exclusion pattern: ${detail}`);
        }
        // Persist the stripped/validated list, not the raw one.
        targets = { ...rawTargets, excludes: parsed.data };
      }

      await tx.insert(configPolicyBackupSettings).values({
        featureLinkId: linkId,
        orgId: policyRow.orgId,
        partnerId: policyRow.orgId ? null : policyRow.partnerId,
        schedule: (s.schedule ?? {}) as Record<string, unknown>,
        retention: (s.retention ?? {}) as Record<string, unknown>,
        paths: (Array.isArray(s.paths) ? s.paths : []) as unknown[],
        backupMode: (s.backupMode ?? 'file') as 'file' | 'hyperv' | 'mssql' | 'system_image',
        targets,
        backupProfileId,
        destinationConfigId,
      });
      break;
    }

    case 'remote_access': {
      // Pick out only the consent fields (#1694). The blob also carries the
      // capability fields (webrtcDesktop, ...) that have no normalized columns
      // — they live in the feature link's JSONB mirror, which the agent path
      // (resolveRemoteAccessForDevice) reads directly. They must not make this
      // parse throw (#2320).
      const parsed = remoteAccessConsentSettingsSchema.parse(s);
      await tx.insert(configPolicyRemoteAccessSettings).values({
        featureLinkId: linkId,
        sessionPromptMode: parsed.sessionPromptMode,
        consentUnavailableBehavior: parsed.consentUnavailableBehavior,
        notifyOnSessionEnd: parsed.notifyOnSessionEnd,
        showActiveIndicator: parsed.showActiveIndicator,
        technicianIdentityLevel: parsed.technicianIdentityLevel,
      });
      break;
    }

    case 'onedrive_helper': {
      const parsed = onedriveHelperInlineSettingsSchema.parse(s);
      // Look up orgId via feature link → policy join (same pattern as 'backup').
      const [policyRow] = await tx
        .select({ orgId: configurationPolicies.orgId })
        .from(configPolicyFeatureLinks)
        .innerJoin(configurationPolicies, eq(configPolicyFeatureLinks.configPolicyId, configurationPolicies.id))
        .where(eq(configPolicyFeatureLinks.id, linkId))
        .limit(1);
      if (!policyRow) throw new Error(`Cannot resolve orgId for feature link ${linkId}`);
      // Library mappings are per-tenant (each org has its own M365 tenant), so
      // onedrive_helper is org-scoped-only (ORG_SCOPED_ONLY_FEATURE_TYPES). The
      // route already 400s partner-wide links; this is the service-level backstop.
      if (!policyRow.orgId) {
        throw new Error('OneDrive Helper settings are not supported on partner-wide configuration policies');
      }
      const [settingsRow] = await tx.insert(configPolicyOnedriveSettings).values({
        featureLinkId: linkId,
        orgId: policyRow.orgId,
        silentAccountConfig: parsed.silentAccountConfig,
        filesOnDemand: parsed.filesOnDemand,
        kfmSilentOptIn: parsed.kfmSilentOptIn,
        kfmFolders: parsed.kfmFolders,
        kfmBlockOptOut: parsed.kfmBlockOptOut,
        tenantAssociationId: parsed.tenantAssociationId ?? null,
        restartOnChange: parsed.restartOnChange,
      }).returning();
      if (settingsRow && parsed.libraries.length > 0) {
        await tx.insert(configPolicyOnedriveLibraries).values(
          parsed.libraries.map((l, idx) => ({
            settingsId: settingsRow.id,
            orgId: policyRow.orgId!,
            libraryId: l.libraryId,
            displayName: l.displayName,
            siteUrl: l.siteUrl ?? null,
            siteId: l.siteId ?? null,
            webId: l.webId ?? null,
            listId: l.listId ?? null,
            targetingMode: l.targetingMode,
            groupId: l.groupId ?? null,
            groupName: l.groupName ?? null,
            hiveScope: l.hiveScope,
            sortOrder: idx,
            enabled: l.enabled,
          }))
        );
      }
      break;
    }

    case 'warranty':
    case 'helper':
    case 'pam':
    case 'vulnerability':
      // Pure JSONB — no normalized table needed
      break;

    default:
      // security — no normalized tables yet
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
    case 'event_log':
      await tx.delete(configPolicyEventLogSettings).where(eq(configPolicyEventLogSettings.featureLinkId, linkId));
      break;
    case 'sensitive_data':
      await tx.delete(configPolicySensitiveDataSettings).where(eq(configPolicySensitiveDataSettings.featureLinkId, linkId));
      break;
    case 'monitoring': {
      // Watches cascade-delete from settings, so just delete settings
      await tx.delete(configPolicyMonitoringSettings).where(eq(configPolicyMonitoringSettings.featureLinkId, linkId));
      // Also delete event log alert rules stored under this monitoring feature link
      await tx.delete(configPolicyAlertRules).where(eq(configPolicyAlertRules.featureLinkId, linkId));
      break;
    }
    case 'backup':
      await tx.delete(configPolicyBackupSettings).where(eq(configPolicyBackupSettings.featureLinkId, linkId));
      break;
    case 'remote_access':
      await tx.delete(configPolicyRemoteAccessSettings).where(eq(configPolicyRemoteAccessSettings.featureLinkId, linkId));
      break;
    case 'onedrive_helper': {
      // Libraries cascade-delete from settings, so just delete settings
      await tx.delete(configPolicyOnedriveSettings).where(eq(configPolicyOnedriveSettings.featureLinkId, linkId));
      break;
    }
    case 'warranty':
    case 'helper':
    case 'pam':
    case 'vulnerability':
      // Pure JSONB — no normalized table to delete
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
      // NOTE: autoApproveDeferralDays and apps (block/pin rules) are intentionally
      // absent here — config_policy_patch_settings has no columns for them; they
      // live ONLY in the feature link's inline JSONB. Callers (listFeatureLinks)
      // MUST merge them back in from the stored inlineSettings, otherwise reads
      // come back with apps: [] and the next save destroys every app rule.
      return {
        sources: row.sources,
        autoApprove: row.autoApprove,
        autoApproveSeverities: row.autoApproveSeverities ?? [],
        scheduleFrequency: row.scheduleFrequency,
        scheduleTime: row.scheduleTime,
        scheduleDayOfWeek: row.scheduleDayOfWeek,
        scheduleDayOfMonth: row.scheduleDayOfMonth,
        rebootPolicy: row.rebootPolicy,
        exclusiveWindowsUpdate: row.exclusiveWindowsUpdate,
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
        rebootIfPending: row.rebootIfPending,
        notifyBeforeMinutes: row.notifyBeforeMinutes,
        notifyOnStart: row.notifyOnStart,
        notifyOnEnd: row.notifyOnEnd,
      };
    }

    case 'event_log': {
      const [row] = await db
        .select()
        .from(configPolicyEventLogSettings)
        .where(eq(configPolicyEventLogSettings.featureLinkId, linkId))
        .limit(1);
      if (!row) return null;
      return {
        retentionDays: row.retentionDays,
        maxEventsPerCycle: row.maxEventsPerCycle,
        collectCategories: row.collectCategories,
        minimumLevel: row.minimumLevel,
        collectionIntervalMinutes: row.collectionIntervalMinutes,
        rateLimitPerHour: row.rateLimitPerHour,
      };
    }

    case 'sensitive_data': {
      const [row] = await db
        .select()
        .from(configPolicySensitiveDataSettings)
        .where(eq(configPolicySensitiveDataSettings.featureLinkId, linkId))
        .limit(1);
      if (!row) return null;
      return {
        detectionClasses: row.detectionClasses,
        includePaths: row.includePaths,
        excludePaths: row.excludePaths,
        fileTypes: row.fileTypes,
        maxFileSizeBytes: row.maxFileSizeBytes,
        workers: row.workers,
        timeoutSeconds: row.timeoutSeconds,
        suppressPatternIds: row.suppressPatternIds,
        scheduleType: row.scheduleType,
        intervalMinutes: row.intervalMinutes,
        cron: row.cron,
        timezone: row.timezone,
      };
    }

    case 'monitoring': {
      const [settingsRow] = await db
        .select()
        .from(configPolicyMonitoringSettings)
        .where(eq(configPolicyMonitoringSettings.featureLinkId, linkId))
        .limit(1);
      if (!settingsRow) return null;
      const watches = await db
        .select()
        .from(configPolicyMonitoringWatches)
        .where(eq(configPolicyMonitoringWatches.settingsId, settingsRow.id))
        .orderBy(asc(configPolicyMonitoringWatches.sortOrder));

      // Reconstruct event log alerts from alert rules stored under this monitoring feature link
      const alertRules = await db
        .select()
        .from(configPolicyAlertRules)
        .where(eq(configPolicyAlertRules.featureLinkId, linkId));

      const eventLogAlerts = alertRules
        .filter((r) => {
          const conds = r.conditions as unknown[];
          return Array.isArray(conds) && conds.length === 1 && (conds[0] as Record<string, unknown>)?.type === 'event_log';
        })
        .map((r) => {
          const cond = (r.conditions as Record<string, unknown>[])[0]!;
          return {
            name: r.name,
            category: cond.category as string,
            level: cond.level as string,
            sourcePattern: cond.sourcePattern as string | undefined,
            messagePattern: cond.messagePattern as string | undefined,
            countThreshold: cond.countThreshold as number,
            windowMinutes: cond.windowMinutes as number,
            severity: r.severity,
            enabled: true, // only enabled rules are stored
          };
        });

      // Reconstruct metric/status/custom alert rules (non-event_log)
      const metricAlertRules = alertRules
        .filter((r) => {
          const conds = r.conditions as unknown[];
          if (!Array.isArray(conds) || conds.length === 0) return false;
          return (conds[0] as Record<string, unknown>)?.type !== 'event_log';
        })
        .map((r) => ({
          name: r.name,
          severity: r.severity,
          conditions: r.conditions,
          cooldownMinutes: r.cooldownMinutes,
          autoResolve: r.autoResolve,
        }));

      return {
        checkIntervalSeconds: settingsRow.checkIntervalSeconds,
        watches: watches.map((w) => ({
          watchType: w.watchType,
          name: w.name,
          displayName: w.displayName,
          enabled: w.enabled,
          alertOnStop: w.alertOnStop,
          alertAfterConsecutiveFailures: w.alertAfterConsecutiveFailures,
          alertSeverity: w.alertSeverity,
          cpuThresholdPercent: w.cpuThresholdPercent,
          memoryThresholdMb: w.memoryThresholdMb,
          thresholdDurationSeconds: w.thresholdDurationSeconds,
          autoRestart: w.autoRestart,
          maxRestartAttempts: w.maxRestartAttempts,
          restartCooldownSeconds: w.restartCooldownSeconds,
        })),
        eventLogAlerts,
        alertRules: metricAlertRules,
      };
    }

    case 'backup': {
      const [row] = await db
        .select()
        .from(configPolicyBackupSettings)
        .where(eq(configPolicyBackupSettings.featureLinkId, linkId))
        .limit(1);
      if (!row) return null;
      return {
        schedule: row.schedule,
        retention: row.retention,
        paths: row.paths,
        backupMode: row.backupMode,
        targets: row.targets,
        ...(row.backupProfileId ? { backupProfileId: row.backupProfileId } : {}),
        ...(row.destinationConfigId ? { destinationConfigId: row.destinationConfigId } : {}),
      };
    }

    case 'remote_access': {
      const [row] = await db
        .select()
        .from(configPolicyRemoteAccessSettings)
        .where(eq(configPolicyRemoteAccessSettings.featureLinkId, linkId))
        .limit(1);
      if (!row) return null;
      return {
        sessionPromptMode: row.sessionPromptMode,
        consentUnavailableBehavior: row.consentUnavailableBehavior,
        notifyOnSessionEnd: row.notifyOnSessionEnd,
        showActiveIndicator: row.showActiveIndicator,
        technicianIdentityLevel: row.technicianIdentityLevel,
      };
    }

    case 'warranty':
    case 'helper':
    case 'pam':
    case 'vulnerability':
      // Pure JSONB — settings stored directly on feature link
      return null;

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
  if (inlineSettings !== undefined && inlineSettings !== null) {
    inlineSettings = configFeatureInlineSettingsSchema.parse(inlineSettings);
  }

  if (featureType === 'pam' && inlineSettings !== undefined && inlineSettings !== null) {
    pamInlineSettingsSchema.parse(inlineSettings);
  }

  if (featureType === 'vulnerability' && inlineSettings !== undefined && inlineSettings !== null) {
    vulnerabilityInlineSettingsSchema.parse(inlineSettings);
  }

  // Service-level backstop for callers that bypass the HTTP route's validation
  // (the AI manage_policy_feature_link tool calls this directly). Validates the
  // combined capability + consent shape and stores the PARSED result so unknown
  // keys are stripped from the JSONB mirror on every path (an AI-guessed key
  // like `remoteDesktop` must not be persisted-and-echoed as if it took effect
  // — the runtime readers would silently ignore it). Decompose below re-picks
  // the consent subset for the normalized row (#2320).
  if (featureType === 'remote_access' && inlineSettings !== undefined && inlineSettings !== null) {
    inlineSettings = remoteAccessInlineSettingsSchema.parse(inlineSettings);
  }

  return db.transaction(async (tx) => {
    const effectiveInlineSettings =
      featureType === 'patch'
        ? normalizePatchInlineSettings(inlineSettings)
        : inlineSettings;

    // ON CONFLICT DO NOTHING instead of catch-and-map: callers run inside the
    // withDbAccessContext transaction, and postgres.js re-throws a raised
    // unique violation at commit time even after it's caught by the caller,
    // turning a mapped 409 back into a raw 500 (see createCatalogItem in
    // catalogService.ts). `config_feature_links_unique` (config_policy_id,
    // feature_type) is the only non-PK unique constraint on this table, so a
    // bare onConflictDoNothing only ever suppresses that duplicate-link case.
    // Callers must treat a null return as "already linked".
    const [link] = await tx
      .insert(configPolicyFeatureLinks)
      .values({
        configPolicyId,
        featureType,
        featurePolicyId: featurePolicyId ?? null,
        // Keep JSONB as a compatibility/UI mirror; runtime must read normalized settings.
        inlineSettings: effectiveInlineSettings ?? null,
      })
      .onConflictDoNothing()
      .returning();

    if (!link) return null;

    // Decompose inlineSettings into normalized per-feature table
    if (
      featureType === 'patch'
      || effectiveInlineSettings
      || (featureType === 'backup' && featurePolicyId)
    ) {
      await decomposeInlineSettings(
        link.id,
        featureType,
        featureType === 'backup' ? (effectiveInlineSettings ?? {}) : effectiveInlineSettings,
        tx
      );
    }

    return link;
  });
}

export async function updateFeatureLink(
  linkId: string,
  updates: { featurePolicyId?: string | null; inlineSettings?: unknown },
  configPolicyId?: string
) {
  if (updates.inlineSettings !== undefined && updates.inlineSettings !== null) {
    updates.inlineSettings = configFeatureInlineSettingsSchema.parse(updates.inlineSettings);
  }

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

    if (existing.featureType === 'pam' && updates.inlineSettings !== undefined && updates.inlineSettings !== null) {
      pamInlineSettingsSchema.parse(updates.inlineSettings);
    }

    if (existing.featureType === 'vulnerability' && updates.inlineSettings !== undefined && updates.inlineSettings !== null) {
      vulnerabilityInlineSettingsSchema.parse(updates.inlineSettings);
    }

    // Same service-level backstop as addFeatureLink (AI tool path) — see #2320.
    // remote_access updates use MERGE semantics: the incoming payload is
    // validated + stripped, then merged over the (validated) currently stored
    // blob. The blob is written by two surfaces — the RemoteAccessTab edits the
    // capability fields, the consent fields (#1694) have no UI and arrive via
    // the AI tool — and decompose below re-creates the normalized consent row
    // from scratch with schema defaults. A replace-semantics partial update
    // (e.g. AI sending only {webrtcDesktop: false}) would silently reset
    // sessionPromptMode 'consent' → 'notify' and, inversely, a consent-only
    // update would drop every capability key from the mirror, fail-open
    // re-enabling deliberately disabled capabilities via the permissive
    // baseline. Merging closes both holes; fields can only be changed, never
    // implicitly reset (every field has a spec default anyway).
    if (existing.featureType === 'remote_access' && updates.inlineSettings !== undefined && updates.inlineSettings !== null) {
      const incoming = remoteAccessInlineSettingsSchema.parse(updates.inlineSettings);
      // Tolerate malformed/legacy stored blobs on the read side: safeParse and
      // fall back to {} rather than making the whole update impossible.
      const stored = remoteAccessInlineSettingsSchema.safeParse(existing.inlineSettings ?? {});
      updates.inlineSettings = { ...(stored.success ? stored.data : {}), ...incoming };
    }

    const setValues: Record<string, unknown> = { updatedAt: new Date() };
    const normalizedInlineSettings =
      existing.featureType === 'patch' && updates.inlineSettings !== undefined
        ? normalizePatchInlineSettings(updates.inlineSettings)
        : updates.inlineSettings;
    if (updates.featurePolicyId !== undefined) setValues.featurePolicyId = updates.featurePolicyId;
    if (updates.inlineSettings !== undefined) {
      // Keep JSONB as a compatibility/UI mirror; runtime must read normalized settings.
      setValues.inlineSettings = normalizedInlineSettings;
    }

    const [updated] = await tx
      .update(configPolicyFeatureLinks)
      .set(setValues)
      .where(eq(configPolicyFeatureLinks.id, linkId))
      .returning();

    // A backup featurePolicyId selects the profile (or legacy destination)
    // materialized into config_policy_backup_settings. Rebuild that row even
    // when callers omit inlineSettings, otherwise the link can say profile B
    // while runtime keeps applying the previously materialized profile A.
    const backupReferenceChanged =
      existing.featureType === 'backup'
      && updates.featurePolicyId !== undefined
      && updates.featurePolicyId !== existing.featurePolicyId;

    // If settings or the backup reference changed, replace normalized rows
    // (delete + re-insert) from the updated reference and effective mirror.
    if (updates.inlineSettings !== undefined || backupReferenceChanged) {
      const featureType = existing.featureType as ConfigFeatureType;
      const settingsToDecompose =
        updates.inlineSettings !== undefined
          ? normalizedInlineSettings
          : existing.inlineSettings;
      await deleteNormalizedRows(linkId, featureType, tx);
      if (
        featureType === 'patch'
        || settingsToDecompose
        || (featureType === 'backup' && updates.featurePolicyId)
      ) {
        await decomposeInlineSettings(
          linkId,
          featureType,
          featureType === 'backup' ? (settingsToDecompose ?? {}) : settingsToDecompose,
          tx
        );
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
      let effectiveInlineSettings: unknown;
      if (featureType === 'patch') {
        // CONSTRAINT: autoApproveDeferralDays and apps (block/pin rules) have NO
        // columns on config_policy_patch_settings — they live ONLY in the feature
        // link's inline JSONB. They must be merged in even when the relational row
        // wins, exactly mirroring loadPolicyLocalPatchConfig in configPolicyPatching.ts.
        // Without this merge every read returns apps: [] / autoApproveDeferralDays: 0,
        // and the next save writes that emptiness back to the JSONB — permanently
        // destroying all app rules with no warning (blocked apps then auto-install).
        // A maintainer "cleaning up" this mixed sourcing must first add columns and
        // a backfill migration. Malformed stored JSON must not throw; it falls back
        // to schema defaults for just these fields via tryNormalizePatchInlineSettings.
        const storedInline = tryNormalizePatchInlineSettings(link.inlineSettings).settings;
        effectiveInlineSettings = assembled
          ? normalizePatchInlineSettings({
              ...(assembled as Record<string, unknown>),
              autoApproveDeferralDays: storedInline.autoApproveDeferralDays,
              apps: storedInline.apps,
            })
          : storedInline;
      } else if (featureType === 'remote_access' && assembled) {
        // The normalized row (config_policy_remote_access_settings) holds ONLY
        // the session-consent fields (#1694); the capability toggles the
        // RemoteAccessTab edits (webrtcDesktop, vncRelay, clipboard*, proxy,
        // limits) live ONLY in the feature link's JSONB mirror. Merge the two
        // (normalized consent row wins) so reads don't hide the capability
        // settings — otherwise the tab renders defaults and the next save
        // writes those defaults back over the real values (#2320).
        const mirror =
          link.inlineSettings && typeof link.inlineSettings === 'object' && !Array.isArray(link.inlineSettings)
            ? (link.inlineSettings as Record<string, unknown>)
            : {};
        effectiveInlineSettings = { ...mirror, ...(assembled as Record<string, unknown>) };
      } else {
        effectiveInlineSettings = assembled ?? link.inlineSettings;
      }
      return {
        ...link,
        // Prefer assembled normalized data; fall back to stored JSONB
        inlineSettings: effectiveInlineSettings,
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
  userId: string,
  roleFilter?: string[],
  osFilter?: string[]
) {
  // ON CONFLICT DO NOTHING instead of catch-and-map: callers run inside the
  // withDbAccessContext transaction, and postgres.js re-throws a raised unique
  // violation at commit time even after it's caught by the caller, turning a
  // mapped 409 back into a raw 500 (see createCatalogItem in catalogService.ts).
  // `config_assignments_unique` (config_policy_id, level, target_id) is the
  // only non-PK unique constraint on this table, so a bare onConflictDoNothing
  // only ever suppresses that duplicate-assignment case. Callers must treat a
  // null return as "already assigned".
  const [assignment] = await db
    .insert(configPolicyAssignments)
    .values({
      configPolicyId,
      level,
      targetId,
      priority,
      roleFilter: roleFilter?.length ? roleFilter : null,
      osFilter: osFilter?.length ? osFilter : null,
      assignedBy: userId,
    })
    .onConflictDoNothing()
    .returning();
  return assignment ?? null;
}

export async function validateAssignmentTarget(
  policyOwner: { orgId: string | null; partnerId: string | null },
  level: ConfigAssignmentLevel,
  targetId: string
): Promise<AssignmentTargetValidation> {
  const policyOrgId = policyOwner.orgId;

  // Partner-owned policies (#1724, #2280) are reusable libraries: a partner-level
  // assignment applies them to ALL orgs, and org/site/group/device assignments
  // apply them to a chosen subset. Every non-partner target must resolve to an org
  // owned by THIS partner (organizations.partner_id) — cross-partner targets are
  // rejected here (defense-in-depth; RLS is the real backstop).
  if (policyOwner.partnerId) {
    const partnerId = policyOwner.partnerId;
    switch (level) {
      case 'partner':
        return targetId === partnerId
          ? { valid: true }
          : { valid: false, error: 'A partner-wide policy can only target its own partner' };

      case 'organization': {
        const [org] = await db
          .select({ id: organizations.id })
          .from(organizations)
          .where(and(eq(organizations.id, targetId), eq(organizations.partnerId, partnerId)))
          .limit(1);
        return org
          ? { valid: true }
          : { valid: false, error: 'Target organization is not in this partner' };
      }

      case 'site': {
        const [site] = await db
          .select({ id: sites.id })
          .from(sites)
          .innerJoin(organizations, eq(sites.orgId, organizations.id))
          .where(and(eq(sites.id, targetId), eq(organizations.partnerId, partnerId)))
          .limit(1);
        return site
          ? { valid: true }
          : { valid: false, error: 'Target site is not in this partner' };
      }

      case 'device_group': {
        const [group] = await db
          .select({ id: deviceGroups.id })
          .from(deviceGroups)
          .innerJoin(organizations, eq(deviceGroups.orgId, organizations.id))
          .where(and(eq(deviceGroups.id, targetId), eq(organizations.partnerId, partnerId)))
          .limit(1);
        return group
          ? { valid: true }
          : { valid: false, error: 'Target device group is not in this partner' };
      }

      case 'device': {
        const [device] = await db
          .select({ id: devices.id })
          .from(devices)
          .innerJoin(organizations, eq(devices.orgId, organizations.id))
          .where(and(eq(devices.id, targetId), eq(organizations.partnerId, partnerId)))
          .limit(1);
        return device
          ? { valid: true }
          : { valid: false, error: 'Target device is not in this partner' };
      }

      default:
        return { valid: false, error: 'Unsupported assignment target level' };
    }
  }

  // Org-owned policies: org_id is guaranteed non-null by the ownership CHECK.
  if (!policyOrgId) {
    return { valid: false, error: 'Policy has no owning organization' };
  }

  switch (level) {
    case 'organization': {
      if (targetId !== policyOrgId) {
        return { valid: false, error: 'Configuration policies can only be assigned within their owning organization' };
      }

      const [org] = await db
        .select({ id: organizations.id })
        .from(organizations)
        .where(eq(organizations.id, policyOrgId))
        .limit(1);
      return org
        ? { valid: true }
        : { valid: false, error: 'Policy organization not found' };
    }

    case 'site': {
      const [site] = await db
        .select({ id: sites.id })
        .from(sites)
        .where(and(eq(sites.id, targetId), eq(sites.orgId, policyOrgId)))
        .limit(1);
      return site
        ? { valid: true }
        : { valid: false, error: 'Site target not found in the policy organization' };
    }

    case 'device_group': {
      const [group] = await db
        .select({ id: deviceGroups.id })
        .from(deviceGroups)
        .where(and(eq(deviceGroups.id, targetId), eq(deviceGroups.orgId, policyOrgId)))
        .limit(1);
      return group
        ? { valid: true }
        : { valid: false, error: 'Device group target not found in the policy organization' };
    }

    case 'device': {
      const [device] = await db
        .select({ id: devices.id })
        .from(devices)
        .where(and(eq(devices.id, targetId), eq(devices.orgId, policyOrgId)))
        .limit(1);
      return device
        ? { valid: true }
        : { valid: false, error: 'Device target not found in the policy organization' };
    }

    case 'partner': {
      // An org-owned policy assigned at the partner level is a footgun: it
      // *looks* partner-wide but resolution still clamps it to its single
      // owning org (org_id = device.orgId), so it silently reaches only that
      // one org. True cross-org propagation requires a partner-OWNED policy
      // (created via the "Partner library" scope). Reject it outright rather
      // than let it masquerade as fleet-wide (#1724 follow-up).
      return {
        valid: false,
        error: 'Only partner-wide policies can be assigned at the Partner level. This policy is owned by a single organization — assign it at the organization, site, group, or device level instead.',
      };
    }

    default:
      return { valid: false, error: 'Unsupported assignment target level' };
  }
}

/**
 * Site-axis (SR5-07) authorization for a policy assignment target. This is a
 * SEPARATE concern from `validateAssignmentTarget`, which only proves the target
 * belongs to the policy's owning org/partner. `authorizeAssignmentTarget` proves
 * the CALLER is permitted to touch the target under their site allowlist —
 * Postgres RLS does NOT enforce the site sub-axis, so it must be checked here.
 *
 * No-op (allow) for an unrestricted caller (`allowedSiteIds` undefined). For a
 * site-restricted caller it fails closed:
 *  - organization/partner targets are denied outright — a site-scoped tech
 *    cannot push a policy across a whole org or partner.
 *  - site targets must be in the caller's site allowlist.
 *  - device_group / device targets are resolved to their site and checked with
 *    `canAccessSite` (a group/device with no site, or an unknown id, is denied).
 *
 * Callable at assignment time (create) AND re-checked at removal time using the
 * stored assignment's level/targetId so a later site-restriction change can't be
 * bypassed by deleting an assignment created earlier.
 */
export async function authorizeAssignmentTarget(
  auth: AuthContext,
  level: ConfigAssignmentLevel,
  targetId: string
): Promise<AssignmentTargetValidation> {
  // Unrestricted caller (partner/system scope, or org user with no site
  // restriction) — org/partner ownership is already enforced elsewhere.
  if (!auth.allowedSiteIds || !auth.canAccessSite) return { valid: true };
  const canAccessSite = auth.canAccessSite;

  switch (level) {
    case 'partner':
    case 'organization':
      return {
        valid: false,
        error: 'Your access is restricted to specific sites — you cannot assign a policy at the organization or partner level.',
      };

    case 'site':
      return canAccessSite(targetId)
        ? { valid: true }
        : { valid: false, error: 'Target site is outside your site access' };

    case 'device_group': {
      const [group] = await db
        .select({ siteId: deviceGroups.siteId })
        .from(deviceGroups)
        .where(eq(deviceGroups.id, targetId))
        .limit(1);
      // Unknown group, or a group with no single site (org-wide), is denied for a
      // site-restricted caller (fail closed).
      return group && canAccessSite(group.siteId)
        ? { valid: true }
        : { valid: false, error: 'Target device group is outside your site access' };
    }

    case 'device': {
      const [device] = await db
        .select({ siteId: devices.siteId })
        .from(devices)
        .where(eq(devices.id, targetId))
        .limit(1);
      return device && canAccessSite(device.siteId)
        ? { valid: true }
        : { valid: false, error: 'Target device is outside your site access' };
    }

    default:
      return { valid: false, error: 'Unsupported assignment target level' };
  }
}

/**
 * Fetch a single assignment's identity (level + targetId) scoped to its policy.
 * Used by the REST delete route to re-run the site-axis check against the
 * stored target before removing the row.
 */
export async function getAssignment(assignmentId: string, configPolicyId: string) {
  const [row] = await db
    .select({
      id: configPolicyAssignments.id,
      level: configPolicyAssignments.level,
      targetId: configPolicyAssignments.targetId,
    })
    .from(configPolicyAssignments)
    .where(
      and(
        eq(configPolicyAssignments.id, assignmentId),
        eq(configPolicyAssignments.configPolicyId, configPolicyId)
      )
    )
    .limit(1);
  return row ?? null;
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
  auth: AuthContext,
  opts?: { includeBaseline?: boolean }
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
      eq(configurationPolicies.status, 'active'),
      // Org-owned policies for this device's org, OR partner-owned policies
      // (org_id NULL) for this device's partner (#1724).
      org?.partnerId
        ? sql`(${configurationPolicies.orgId} = ${device.orgId} OR (${configurationPolicies.orgId} IS NULL AND ${configurationPolicies.partnerId} = ${org.partnerId}))`
        : eq(configurationPolicies.orgId, device.orgId)
    ))
    .innerJoin(configPolicyFeatureLinks, eq(configPolicyFeatureLinks.configPolicyId, configurationPolicies.id))
    .where(and(
      sql`(${sql.join(targetConditions, sql` OR `)})`,
      // Apply the optional role/os device-type filter (#1724). A NULL filter
      // matches all; a set filter gates the assignment to matching devices.
      sql`(${configPolicyAssignments.roleFilter} IS NULL OR ${sql.param(device.deviceRole)} = ANY(${configPolicyAssignments.roleFilter}))`,
      sql`(${configPolicyAssignments.osFilter} IS NULL OR ${sql.param(device.osType)} = ANY(${configPolicyAssignments.osFilter}))`
    ))
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

  const inheritanceChain: EffectiveConfiguration['inheritanceChain'] = Array.from(chainMap.values()).map((entry) => ({
    ...entry,
    featureTypes: Array.from(entry.featureTypes),
  }));

  // Synthesizes the virtual bottom-of-hierarchy "Breeze Defaults" layer for every
  // feature type with no real winner. The BREEZE_DEFAULTS_SENTINEL ids, priority 0,
  // and sourceLevel:'default' are sentinels the UI keys off to exclude this node from
  // assigned-policy counts. Opt-in so existing callers are unaffected.
  if (opts?.includeBaseline) {
    const synthesized: ConfigFeatureType[] = [];
    for (const entry of getPolicyBaselineDefaults()) {
      if (features[entry.featureType]) continue;
      features[entry.featureType] = {
        featureType: entry.featureType,
        featurePolicyId: null,
        inlineSettings: entry.inlineSettings,
        sourceLevel: 'default',
        sourceTargetId: BREEZE_DEFAULTS_SENTINEL,
        sourcePolicyId: BREEZE_DEFAULTS_SENTINEL,
        sourcePolicyName: 'Breeze Defaults',
        sourcePriority: 0,
      };
      synthesized.push(entry.featureType);
    }
    if (synthesized.length > 0) {
      inheritanceChain.push({
        level: 'default',
        targetId: BREEZE_DEFAULTS_SENTINEL,
        policyId: BREEZE_DEFAULTS_SENTINEL,
        policyName: 'Breeze Defaults',
        priority: 0,
        featureTypes: synthesized,
      });
    }
  }

  return { deviceId, features, inheritanceChain };
}

export async function resolveEffectiveConfig(
  deviceId: string,
  auth: AuthContext,
  opts?: { includeBaseline?: boolean }
): Promise<EffectiveConfiguration | null> {
  return resolveEffectiveConfigWithExecutor(db, deviceId, auth, opts);
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
  // Every linked feature type is handled separately in
  // validateFeaturePolicyExists: rings are pure partner-axis; software /
  // security / alert-rule / compliance / sensitive-data / peripheral /
  // maintenance are dual-ownership (org XOR partner,
  // #2126/#2127/#2128/#2129/#2131); backup links a dual-ownership
  // backup_profiles selection profile (spec 2026-07-13), with a legacy
  // fallback accepting an org-owned backup_configs id from pre-profile links.
};

/**
 * Feature types whose LINKED standalone table supports partner ownership, and
 * may therefore carry a featurePolicyId on a PARTNER-WIDE config policy:
 * update rings are pure partner-axis; software policies are dual-ownership
 * (#2126). Grows as more template tables migrate to dual-axis (epic #2135).
 * The featureLinks routes consult this set instead of hardcoding 'patch'.
 */
export const PARTNER_LINKABLE_FEATURE_TYPES: ReadonlySet<ConfigFeatureType> = new Set([
  'patch',
  'software_policy',
  'security',
  'alert_rule',
  'compliance',
  'sensitive_data',
  'peripheral_control',
  'maintenance',
  // backup (spec 2026-07-13): links a dual-ownership backup_profiles
  // selection profile; partner-wide links resolve each device org's DEFAULT
  // destination at job time (backup_configs stays org-owned — credentials).
  'backup',
]);

/**
 * True when featurePolicyId references a backup_profiles row (vs a legacy
 * backup_configs destination id). Routes use this to pick the right inline
 * settings schema for backup links.
 *
 * Pure existence probe, deliberately run in a system context: a PARTNER-WIDE
 * profile is RLS-invisible to an org-scoped token, so under the caller's context
 * an org admin linking one would have it misclassified as a legacy destination
 * id and rejected with a nonsense error. Tenancy of the link is enforced
 * separately by validateFeaturePolicyExists, which matches on the owner axis.
 */
export async function isBackupProfileReference(
  featurePolicyId: string | null | undefined
): Promise<boolean> {
  if (!featurePolicyId) return false;
  const [row] = await runOutsideDbContext(() =>
    withSystemDbAccessContext(() =>
      db
        .select({ id: backupProfiles.id })
        .from(backupProfiles)
        .where(eq(backupProfiles.id, featurePolicyId))
        .limit(1)
    )
  );
  return !!row;
}

export async function validateFeaturePolicyExists(
  featureType: ConfigFeatureType,
  featurePolicyId: string | undefined | null,
  owner: { orgId: string | null; partnerId: string | null }
): Promise<{ valid: boolean; error?: string }> {
  if (featureType === 'patch') {
    if (!featurePolicyId) {
      return { valid: true };
    }

    // Rings are partner-axis. A partner-wide policy (#1724) carries partnerId
    // directly (orgId null); an org-scoped policy derives it from its org.
    const partnerId =
      owner.partnerId ?? (owner.orgId ? await resolvePartnerIdForOrg(owner.orgId) : null);
    if (!partnerId) {
      return { valid: false, error: `Update ring "${featurePolicyId}" not found — organization has no partner` };
    }

    const [ring] = await db
      .select({ id: patchPolicies.id })
      .from(patchPolicies)
      .where(
        and(
          eq(patchPolicies.id, featurePolicyId),
          eq(patchPolicies.partnerId, partnerId),
          eq(patchPolicies.kind, 'ring')
        )
      )
      .limit(1);

    if (!ring) {
      return { valid: false, error: `Update ring "${featurePolicyId}" not found for this partner` };
    }

    return { valid: true };
  }

  if (featureType === 'backup') {
    if (!featurePolicyId) {
      return { valid: true };
    }
    // Preferred reference: a dual-ownership backup_profiles selection profile
    // (org-owned in the config policy's own org, or partner-wide under its
    // partner). Legacy fallback: pre-profile links stored the org's
    // backup_configs (storage destination) id in featurePolicyId — still
    // accepted for org-owned config policies so existing links keep saving.
    const partnerId =
      owner.partnerId ?? (owner.orgId ? await resolvePartnerIdForOrg(owner.orgId) : null);
    const profileConditions: SQL[] = [];
    if (owner.orgId) {
      profileConditions.push(eq(backupProfiles.orgId, owner.orgId));
    }
    if (partnerId) {
      profileConditions.push(
        sql`(${backupProfiles.orgId} IS NULL AND ${backupProfiles.partnerId} = ${partnerId})`
      );
    }
    // Both lookups are self-tenanted by the owner axis above, and run in a
    // system context: a partner-wide profile (org_id NULL) is RLS-invisible to
    // an org-scoped token, so validating in the caller's context would reject a
    // legitimate org-policy → partner-wide-profile link as "not found".
    if (profileConditions.length > 0) {
      const [profile] = await runOutsideDbContext(() =>
        withSystemDbAccessContext(() =>
          db
            .select({ id: backupProfiles.id })
            .from(backupProfiles)
            .where(and(eq(backupProfiles.id, featurePolicyId), or(...profileConditions)))
            .limit(1)
        )
      );
      if (profile) {
        return { valid: true };
      }
    }
    const ownerOrgId = owner.orgId;
    if (ownerOrgId) {
      const [config] = await runOutsideDbContext(() =>
        withSystemDbAccessContext(() =>
          db
            .select({ id: backupConfigs.id })
            .from(backupConfigs)
            .where(and(eq(backupConfigs.id, featurePolicyId), eq(backupConfigs.orgId, ownerOrgId)))
            .limit(1)
        )
      );
      if (config) {
        return { valid: true };
      }
    }
    return {
      valid: false,
      error: `Backup profile "${featurePolicyId}" not found for this organization or partner`,
    };
  }

  if (
    featureType === 'software_policy' ||
    featureType === 'security' ||
    featureType === 'alert_rule' ||
    featureType === 'compliance' ||
    featureType === 'sensitive_data' ||
    featureType === 'peripheral_control' ||
    featureType === 'maintenance'
  ) {
    if (!featurePolicyId) {
      return { valid: true };
    }

    // Software (#2126), security (#2127), alert-rule (#2128), compliance
    // (#2129, automation_policies), sensitive-data, and peripheral-control
    // (#2131) policies are dual-ownership. A config policy may link:
    //  - an org-owned policy belonging to the config policy's own org
    //  - a partner-owned ("all orgs") template belonging to the config
    //    policy's partner (derived from its org for org-owned config policies)
    // A partner-wide config policy (orgId null) can only link partner-owned
    // templates — there is no owning org to anchor an org-owned one.
    const dualAxis = featureType === 'software_policy'
      ? { table: softwarePolicies, label: 'Software policy' }
      : featureType === 'security'
        ? { table: securityPolicies, label: 'Security policy' }
        : featureType === 'alert_rule'
          ? { table: alertRules, label: 'Alert rule' }
          : featureType === 'compliance'
            ? { table: automationPolicies, label: 'Compliance policy' }
            : featureType === 'sensitive_data'
              ? { table: sensitiveDataPolicies, label: 'Sensitive data policy' }
              : featureType === 'peripheral_control'
                ? { table: peripheralPolicies, label: 'Peripheral policy' }
                : { table: maintenanceWindows, label: 'Maintenance window' };
    const partnerId =
      owner.partnerId ?? (owner.orgId ? await resolvePartnerIdForOrg(owner.orgId) : null);

    const ownershipConditions: SQL[] = [];
    if (owner.orgId) {
      ownershipConditions.push(eq(dualAxis.table.orgId, owner.orgId));
    }
    if (partnerId) {
      ownershipConditions.push(
        sql`(${dualAxis.table.orgId} IS NULL AND ${dualAxis.table.partnerId} = ${partnerId})`
      );
    }
    if (ownershipConditions.length === 0) {
      return { valid: false, error: `${dualAxis.label} "${featurePolicyId}" not found — no owning organization or partner` };
    }

    const [row] = await db
      .select({ id: dualAxis.table.id })
      .from(dualAxis.table)
      .where(and(eq(dualAxis.table.id, featurePolicyId), or(...ownershipConditions)))
      .limit(1);

    if (!row) {
      // sensitive_data historically also accepts a featurePolicyId that
      // references another Configuration Policy (whole-policy linking) — the
      // generic fallback below used to allow it. Preserve that with the same
      // dual-axis ownership conditions (config policies are dual-owned).
      if (featureType === 'sensitive_data') {
        const cpConditions: SQL[] = [];
        if (owner.orgId) {
          cpConditions.push(eq(configurationPolicies.orgId, owner.orgId));
        }
        if (partnerId) {
          cpConditions.push(
            sql`(${configurationPolicies.orgId} IS NULL AND ${configurationPolicies.partnerId} = ${partnerId})`
          );
        }
        if (cpConditions.length > 0) {
          const [configPolicy] = await db
            .select({ id: configurationPolicies.id })
            .from(configurationPolicies)
            .where(and(eq(configurationPolicies.id, featurePolicyId), or(...cpConditions)))
            .limit(1);
          if (configPolicy) {
            return { valid: true };
          }
        }
      }
      return { valid: false, error: `${dualAxis.label} "${featurePolicyId}" not found for this organization or partner` };
    }

    return { valid: true };
  }

  if (
    featureType === 'monitoring' ||
    featureType === 'event_log' ||
    featureType === 'onedrive_helper' ||
    featureType === 'vulnerability'
  ) {
    // Monitoring, event_log, onedrive_helper, vulnerability have no policy table — requires inlineSettings
    if (featurePolicyId) {
      return { valid: false, error: `${featureType} feature type does not support featurePolicyId; use inlineSettings instead` };
    }
    return { valid: true };
  }

  // (sensitive_data is handled in the dual-axis branch above, including its
  // legacy config-policy-reference fallback.)

  if (!featurePolicyId) {
    return { valid: true }; // inline-only is allowed; schema ensures inlineSettings is present
  }

  // Every remaining feature type references an org-scoped policy table. A
  // partner-wide policy (orgId null, #1724) cannot link one — patch (rings,
  // partner-axis) is the only linked feature valid partner-wide and returned
  // above. The route blocks this upstream; guard here as defense-in-depth.
  const orgId = owner.orgId;
  if (!orgId) {
    return {
      valid: false,
      error: `The "${featureType}" feature policy is organization-scoped and cannot be linked to a partner-wide configuration policy`,
    };
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
