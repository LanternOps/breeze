import { and, eq, isNull, SQL } from 'drizzle-orm';
import type { z } from 'zod';
import { patchInlineSettingsSchema } from '@breeze/shared/validators';
import { db } from '../db';
import {
  configurationPolicies,
  configPolicyFeatureLinks,
  configPolicyPatchSettings,
  patchPolicies,
} from '../db/schema';
import type { AuthContext } from '../middleware/auth';

export type PatchInlineSettings = z.infer<typeof patchInlineSettingsSchema>;
export type PatchReferenceClassification =
  | 'valid_ring'
  | 'legacy_patch_policy'
  | 'config_policy_uuid'
  | 'missing_target'
  | 'null';

export type PatchEffectiveStatus = 'ok' | 'needs_repair' | 'invalid_reference';

export interface PatchInventoryRow {
  configPolicyId: string;
  configPolicyName: string;
  orgId: string;
  featureLinkId: string;
  referencedTargetId: string | null;
  classification: PatchReferenceClassification;
  normalizedSettingsPresent: boolean;
  inlineSettingsValid: boolean;
  effectiveStatus: PatchEffectiveStatus;
}

export interface PatchRingResolution {
  classification: PatchReferenceClassification;
  valid: boolean;
  ringId: string | null;
  ringName: string | null;
  categoryRules: Record<string, unknown>[];
  autoApprove: Record<string, unknown> | boolean;
}

export interface PolicyLocalPatchConfig {
  configPolicyId: string;
  configPolicyName: string;
  orgId: string;
  featureLinkId: string;
  featurePolicyId: string | null;
  settings: PatchInlineSettings;
  ring: PatchRingResolution;
}

export interface PatchInventorySummary {
  total: number;
  ok: number;
  needsRepair: number;
  invalidReference: number;
}

export function normalizePatchInlineSettings(settings: unknown): PatchInlineSettings {
  return patchInlineSettingsSchema.parse(settings ?? {});
}

export function tryNormalizePatchInlineSettings(settings: unknown): {
  valid: boolean;
  settings: PatchInlineSettings;
} {
  const parsed = patchInlineSettingsSchema.safeParse(settings ?? {});
  if (parsed.success) {
    return { valid: true, settings: parsed.data };
  }
  return {
    valid: false,
    settings: normalizePatchInlineSettings({}),
  };
}

export async function resolvePatchPolicyReference(
  orgId: string,
  featurePolicyId: string | null
): Promise<PatchRingResolution> {
  if (!featurePolicyId) {
    return {
      classification: 'null',
      valid: true,
      ringId: null,
      ringName: null,
      categoryRules: [],
      autoApprove: {},
    };
  }

  const [patchPolicy] = await db
    .select({
      id: patchPolicies.id,
      kind: patchPolicies.kind,
      name: patchPolicies.name,
      categoryRules: patchPolicies.categoryRules,
      autoApprove: patchPolicies.autoApprove,
    })
    .from(patchPolicies)
    .where(and(eq(patchPolicies.id, featurePolicyId), eq(patchPolicies.orgId, orgId)))
    .limit(1);

  if (patchPolicy) {
    if (patchPolicy.kind === 'ring') {
      return {
        classification: 'valid_ring',
        valid: true,
        ringId: patchPolicy.id,
        ringName: patchPolicy.name,
        categoryRules: Array.isArray(patchPolicy.categoryRules) ? patchPolicy.categoryRules : [],
        autoApprove: patchPolicy.autoApprove ?? {},
      };
    }
    return {
      classification: 'legacy_patch_policy',
      valid: false,
      ringId: null,
      ringName: null,
      categoryRules: [],
      autoApprove: {},
    };
  }

  const [configPolicy] = await db
    .select({ id: configurationPolicies.id })
    .from(configurationPolicies)
    .where(and(eq(configurationPolicies.id, featurePolicyId), eq(configurationPolicies.orgId, orgId)))
    .limit(1);

  if (configPolicy) {
    return {
      classification: 'config_policy_uuid',
      valid: false,
      ringId: null,
      ringName: null,
      categoryRules: [],
      autoApprove: {},
    };
  }

  return {
    classification: 'missing_target',
    valid: false,
    ringId: null,
    ringName: null,
    categoryRules: [],
    autoApprove: {},
  };
}

export async function loadPolicyLocalPatchConfig(
  configPolicyId: string
): Promise<PolicyLocalPatchConfig | null> {
  const [row] = await db
    .select({
      configPolicyId: configurationPolicies.id,
      configPolicyName: configurationPolicies.name,
      orgId: configurationPolicies.orgId,
      featureLinkId: configPolicyFeatureLinks.id,
      featurePolicyId: configPolicyFeatureLinks.featurePolicyId,
      storedInlineSettings: configPolicyFeatureLinks.inlineSettings,
      patchSettings: configPolicyPatchSettings,
    })
    .from(configurationPolicies)
    .innerJoin(
      configPolicyFeatureLinks,
      and(
        eq(configPolicyFeatureLinks.configPolicyId, configurationPolicies.id),
        eq(configPolicyFeatureLinks.featureType, 'patch')
      )
    )
    .leftJoin(
      configPolicyPatchSettings,
      eq(configPolicyPatchSettings.featureLinkId, configPolicyFeatureLinks.id)
    )
    .where(eq(configurationPolicies.id, configPolicyId))
    .limit(1);

  if (!row) return null;

  const settings = row.patchSettings
    ? normalizePatchInlineSettings({
        sources: row.patchSettings.sources,
        autoApprove: row.patchSettings.autoApprove,
        autoApproveSeverities: row.patchSettings.autoApproveSeverities ?? [],
        scheduleFrequency: row.patchSettings.scheduleFrequency,
        scheduleTime: row.patchSettings.scheduleTime,
        scheduleDayOfWeek: row.patchSettings.scheduleDayOfWeek ?? undefined,
        scheduleDayOfMonth: row.patchSettings.scheduleDayOfMonth ?? undefined,
        rebootPolicy: row.patchSettings.rebootPolicy,
      })
    : normalizePatchInlineSettings(row.storedInlineSettings);

  const ring = await resolvePatchPolicyReference(row.orgId, row.featurePolicyId);

  return {
    configPolicyId: row.configPolicyId,
    configPolicyName: row.configPolicyName,
    orgId: row.orgId,
    featureLinkId: row.featureLinkId,
    featurePolicyId: row.featurePolicyId,
    settings,
    ring,
  };
}

export async function backfillMissingPatchSettings(): Promise<{
  repaired: number;
  repairedFromInline: number;
  repairedWithDefaults: number;
}> {
  const rows = await db
    .select({
      featureLinkId: configPolicyFeatureLinks.id,
      storedInlineSettings: configPolicyFeatureLinks.inlineSettings,
    })
    .from(configPolicyFeatureLinks)
    .leftJoin(
      configPolicyPatchSettings,
      eq(configPolicyPatchSettings.featureLinkId, configPolicyFeatureLinks.id)
    )
    .where(
      and(
        eq(configPolicyFeatureLinks.featureType, 'patch'),
        isNull(configPolicyPatchSettings.id)
      )
    );

  let repaired = 0;
  let repairedFromInline = 0;
  let repairedWithDefaults = 0;

  for (const row of rows) {
    const normalized = tryNormalizePatchInlineSettings(row.storedInlineSettings);
    await db.insert(configPolicyPatchSettings).values({
      featureLinkId: row.featureLinkId,
      sources: normalized.settings.sources,
      autoApprove: normalized.settings.autoApprove,
      autoApproveSeverities: normalized.settings.autoApproveSeverities,
      scheduleFrequency: normalized.settings.scheduleFrequency,
      scheduleTime: normalized.settings.scheduleTime,
      scheduleDayOfWeek: normalized.settings.scheduleDayOfWeek,
      scheduleDayOfMonth: normalized.settings.scheduleDayOfMonth,
      rebootPolicy: normalized.settings.rebootPolicy,
    });
    repaired += 1;
    if (normalized.valid) repairedFromInline += 1;
    else repairedWithDefaults += 1;
  }

  return { repaired, repairedFromInline, repairedWithDefaults };
}

async function buildPatchInventory(conditions: SQL[]): Promise<PatchInventoryRow[]> {
  const rows = await db
    .select({
      configPolicyId: configurationPolicies.id,
      configPolicyName: configurationPolicies.name,
      orgId: configurationPolicies.orgId,
      featureLinkId: configPolicyFeatureLinks.id,
      referencedTargetId: configPolicyFeatureLinks.featurePolicyId,
      storedInlineSettings: configPolicyFeatureLinks.inlineSettings,
      patchSettingsId: configPolicyPatchSettings.id,
    })
    .from(configPolicyFeatureLinks)
    .innerJoin(configurationPolicies, eq(configPolicyFeatureLinks.configPolicyId, configurationPolicies.id))
    .leftJoin(configPolicyPatchSettings, eq(configPolicyPatchSettings.featureLinkId, configPolicyFeatureLinks.id))
    .where(and(...conditions));

  const inventory: PatchInventoryRow[] = [];

  // TODO: batch-fetch patch policy references to avoid N+1 queries
  for (const row of rows) {
    const classification = (await resolvePatchPolicyReference(row.orgId, row.referencedTargetId)).classification;
    const inlineSettingsValid = patchInlineSettingsSchema.safeParse(row.storedInlineSettings ?? {}).success;
    const normalizedSettingsPresent = Boolean(row.patchSettingsId);
    const effectiveStatus: PatchEffectiveStatus =
      classification === 'legacy_patch_policy' ||
      classification === 'config_policy_uuid' ||
      classification === 'missing_target'
        ? 'invalid_reference'
        : normalizedSettingsPresent && inlineSettingsValid
          ? 'ok'
          : 'needs_repair';

    inventory.push({
      configPolicyId: row.configPolicyId,
      configPolicyName: row.configPolicyName,
      orgId: row.orgId,
      featureLinkId: row.featureLinkId,
      referencedTargetId: row.referencedTargetId,
      classification,
      normalizedSettingsPresent,
      inlineSettingsValid,
      effectiveStatus,
    });
  }

  return inventory;
}

export function summarizePatchInventory(rows: PatchInventoryRow[]): PatchInventorySummary {
  return {
    total: rows.length,
    ok: rows.filter((row) => row.effectiveStatus === 'ok').length,
    needsRepair: rows.filter((row) => row.effectiveStatus === 'needs_repair').length,
    invalidReference: rows.filter((row) => row.effectiveStatus === 'invalid_reference').length,
  };
}

export async function listPatchInventory(auth: AuthContext): Promise<PatchInventoryRow[]> {
  const conditions: SQL[] = [eq(configPolicyFeatureLinks.featureType, 'patch')];
  const orgCond = auth.orgCondition(configurationPolicies.orgId as any);
  if (orgCond) conditions.push(orgCond);

  return buildPatchInventory(conditions);
}

/** @internal System-only — returns unscoped data across all orgs. Do not call from request handlers. */
export async function listAllPatchInventory(): Promise<PatchInventoryRow[]> {
  return buildPatchInventory([eq(configPolicyFeatureLinks.featureType, 'patch')]);
}
