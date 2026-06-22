import { and, eq, isNull, SQL } from 'drizzle-orm';
import type { z } from 'zod';
import { patchInlineSettingsSchema, policyAppRuleSchema } from '@breeze/shared/validators';
import { db } from '../db';
import { captureException } from './sentry';
import {
  configurationPolicies,
  configPolicyFeatureLinks,
  configPolicyPatchSettings,
  patchPolicies,
} from '../db/schema';
import type { AuthContext } from '../middleware/auth';
import { resolvePartnerIdForOrg } from '../routes/patches/helpers';

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
  // null for partner-wide policies (#1724).
  orgId: string | null;
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
  // null for partner-wide policies (#1724).
  orgId: string | null;
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

/**
 * Normalizes the feature link's stored inline JSON for the load path, but —
 * unlike the bare `tryNormalizePatchInlineSettings` — never *silently*
 * collapses a corrupt document to defaults. Zod parses the whole document, so
 * a single malformed field (one bad app entry, a legacy '2:00' scheduleTime)
 * would otherwise wipe every safety rule (app block/pin rules, deferral) with
 * nothing in any log, and the executor's fail-closed warnings never fire
 * because job snapshots are built from this already-sanitized output.
 *
 * On whole-document failure this warns + reports to Sentry, then salvages the
 * JSON-only safety fields per-entry (mirroring the executor's per-entry
 * posture): each raw `apps` entry that individually passes
 * `policyAppRuleSchema`, and `autoApproveDeferralDays` when it is a valid
 * non-negative integer <= 60.
 */
function normalizeStoredInlineSettingsWithSalvage(
  raw: unknown,
  context: { configPolicyId: string; featureLinkId: string }
): PatchInlineSettings {
  const normalized = tryNormalizePatchInlineSettings(raw);
  if (normalized.valid) return normalized.settings;

  const ident = `config policy ${context.configPolicyId} (feature link ${context.featureLinkId})`;
  console.warn(
    `[configPolicyPatching] Stored patch inline settings failed validation for ${ident}; ` +
      'using defaults and salvaging app rules / deferral per-entry'
  );
  captureException(
    new Error(
      `Stored patch inline settings failed validation for ${ident}; defaults applied with per-entry salvage`
    )
  );

  const settings = normalized.settings;
  const rawObj: Record<string, unknown> =
    raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};

  if (Array.isArray(rawObj.apps)) {
    const salvagedApps: PatchInlineSettings['apps'] = [];
    // Same canonical dedup key as patchInlineSettingsSchema's superRefine —
    // duplicates would make the downstream whole-document re-parse throw.
    const seenAppKeys = new Set<string>();
    for (const [index, entry] of rawObj.apps.entries()) {
      const parsedApp = policyAppRuleSchema.safeParse(entry);
      if (!parsedApp.success) {
        console.warn(
          `[configPolicyPatching] Dropping invalid app rule at index ${index} for ${ident}: ` +
            parsedApp.error.issues.map((issue) => issue.message).join('; ')
        );
        continue;
      }
      const canonicalSource = parsedApp.data.source === 'custom' ? 'third_party' : parsedApp.data.source;
      const key = `${canonicalSource}|${parsedApp.data.packageId.toLowerCase()}`;
      if (seenAppKeys.has(key)) {
        console.warn(
          `[configPolicyPatching] Dropping duplicate app rule at index ${index} for ${ident} (${key})`
        );
        continue;
      }
      if (salvagedApps.length >= 200) {
        // patchInlineSettingsSchema caps apps at 200; exceeding it would make
        // the downstream re-parse throw.
        console.warn(
          `[configPolicyPatching] Dropping app rule at index ${index} for ${ident}: salvage cap of 200 reached`
        );
        continue;
      }
      seenAppKeys.add(key);
      salvagedApps.push(parsedApp.data);
    }
    settings.apps = salvagedApps;
  }

  const rawDeferral = rawObj.autoApproveDeferralDays;
  if (
    typeof rawDeferral === 'number' &&
    Number.isInteger(rawDeferral) &&
    rawDeferral >= 0 &&
    rawDeferral <= 60
  ) {
    settings.autoApproveDeferralDays = rawDeferral;
  }

  return settings;
}

export async function resolvePatchPolicyReference(
  // patch_policies is partner-axis (scoped by partner_id, no org_id). Partner-wide
  // config policies (#1724) carry orgId === null; callers resolve a partnerId from
  // the org (or, for a partner-wide policy, derive it directly) before calling here,
  // so a null partnerId short-circuits to the empty/'null' classification just as a
  // missing featurePolicyId does.
  partnerId: string | null,
  featurePolicyId: string | null
): Promise<PatchRingResolution> {
  if (!featurePolicyId || !partnerId) {
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
    .where(and(eq(patchPolicies.id, featurePolicyId), eq(patchPolicies.partnerId, partnerId)))
    .limit(1);

  if (patchPolicy) {
    if (patchPolicy.kind === 'ring') {
      return {
        classification: 'valid_ring',
        valid: true,
        ringId: patchPolicy.id,
        ringName: patchPolicy.name,
        categoryRules: Array.isArray(patchPolicy.categoryRules) ? patchPolicy.categoryRules : [],
        autoApprove: (patchPolicy.autoApprove ?? {}) as Record<string, unknown> | boolean,
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
    .where(eq(configurationPolicies.id, featurePolicyId))
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
      partnerId: configurationPolicies.partnerId,
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

  const storedInline = normalizeStoredInlineSettingsWithSalvage(row.storedInlineSettings, {
    configPolicyId: row.configPolicyId,
    featureLinkId: row.featureLinkId,
  });
  // Constraint: autoApproveDeferralDays and apps have no columns on
  // config_policy_patch_settings — they live only in the feature link's
  // inline JSON. The mixed sourcing below (columns for everything else,
  // storedInline for these two) is therefore intentional, not an oversight.
  const settings = row.patchSettings
    ? normalizePatchInlineSettings({
        sources: row.patchSettings.sources,
        autoApprove: row.patchSettings.autoApprove,
        autoApproveSeverities: row.patchSettings.autoApproveSeverities ?? [],
        autoApproveDeferralDays: storedInline.autoApproveDeferralDays,
        apps: storedInline.apps,
        scheduleFrequency: row.patchSettings.scheduleFrequency,
        scheduleTime: row.patchSettings.scheduleTime,
        scheduleDayOfWeek: row.patchSettings.scheduleDayOfWeek ?? undefined,
        scheduleDayOfMonth: row.patchSettings.scheduleDayOfMonth ?? undefined,
        rebootPolicy: row.patchSettings.rebootPolicy,
      })
    : storedInline;

  // Patch feature links are rejected on partner-wide policies (org_id NULL) at the
  // featureLinks route (#1724), so reaching this load path with a patch link and no
  // org is a misconfiguration that escaped the write-side gate. Warn rather than
  // silently resolving so it surfaces instead of masking. (Defense-in-depth: the
  // ring still resolves from partnerId below since patch_policies is partner-axis.)
  if (row.featurePolicyId && !row.orgId) {
    console.warn(
      `[configPolicyPatching] patch feature link ${row.featurePolicyId} on partner-wide config policy ${row.configPolicyId} (no org) — should have been blocked at write time`
    );
  }
  // Partner-wide config policies (#1724) carry partnerId directly and orgId === null;
  // org-scoped policies derive the partner from their org. Prefer the explicit
  // partnerId so partner-wide policies still resolve their (partner-axis) patch ring.
  const partnerId = row.partnerId ?? (row.orgId ? await resolvePartnerIdForOrg(row.orgId) : null);
  if (!partnerId) {
    console.warn(
      `[configPolicyPatching] orphaned org has no partner — cannot resolve patch ring`,
      { orgId: row.orgId, configPolicyId: row.configPolicyId }
    );
    return null;
  }
  const ring = await resolvePatchPolicyReference(partnerId, row.featurePolicyId);

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
      partnerId: configurationPolicies.partnerId,
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
    // Prefer the policy's own partnerId (set for partner-wide policies, #1724);
    // fall back to deriving it from the org for org-scoped policies.
    const rowPartnerId = row.partnerId ?? (row.orgId ? await resolvePartnerIdForOrg(row.orgId) : null);
    if (!rowPartnerId) {
      console.warn(
        `[configPolicyPatching] orphaned org has no partner — classifying as missing_target`,
        { orgId: row.orgId, configPolicyId: row.configPolicyId }
      );
    }
    const classification = rowPartnerId
      ? (await resolvePatchPolicyReference(rowPartnerId, row.referencedTargetId)).classification
      : 'missing_target';
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
