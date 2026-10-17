import { and, eq, isNull, SQL } from 'drizzle-orm';
import type { z } from 'zod';
import {
  canonicalAppRuleKey,
  patchInlineSettingsSchema,
  policyAppRuleSchema,
  rebootPromptTextSchemas,
} from '@breeze/shared/validators';
import { db } from '../db';
import { readOwnPartnerAxisRows } from '../db/partnerAxisRead';
import { captureException } from './sentry';
import {
  configurationPolicies,
  configPolicyFeatureLinks,
  configPolicyEffectiveFeatureLinks,
  configPolicyPatchSettings,
  patchPolicies,
} from '../db/schema';
import type { AuthContext } from '../middleware/auth';
import { coerceAppRuleList, type PolicyAppRule } from './patchApprovalEvaluator';
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
  /** Ring category include allowlist / exclude denylist (#2117). API/AI-only. */
  categories: string[];
  excludeCategories: string[];
  autoApprove: Record<string, unknown> | boolean;
  /**
   * The ring's per-app block/pin rules (`patch_policies.app_rules`, #8184),
   * normalised for the evaluator. `[]` for every classification other than
   * `valid_ring`.
   */
  appRules: PolicyAppRule[];
}

/** A resolution with no usable ring: no ring config of any kind. */
function noRingResolution(
  classification: Exclude<PatchReferenceClassification, 'valid_ring'>,
  valid: boolean
): PatchRingResolution {
  return {
    classification,
    valid,
    ringId: null,
    ringName: null,
    categoryRules: [],
    categories: [],
    excludeCategories: [],
    autoApprove: {},
    appRules: [],
  };
}

/**
 * Normalise a ring row's stored `app_rules` with the job executor's
 * fail-closed coercion. A non-array value (the column CHECK forbids it, so
 * only reachable through drift) yields no ring rules, reported loudly.
 */
function coerceRingAppRules(raw: unknown, ringId: string): PolicyAppRule[] {
  const context = `[configPolicyPatching] ring ${ringId}`;
  const rules = coerceAppRuleList(raw, context);
  if (rules === null) {
    const message = `${context} has malformed app_rules (not an array); ignoring ring app rules`;
    console.warn(`${message}:`, JSON.stringify(raw));
    captureException(new Error(message));
    return [];
  }
  return rules;
}

export interface PolicyLocalPatchConfig {
  /** The policy this config was loaded FOR — the assigned policy. */
  configPolicyId: string;
  configPolicyName: string;
  // null for partner-wide policies (#1724).
  orgId: string | null;
  featureLinkId: string;
  featurePolicyId: string | null;
  /**
   * The policy that AUTHORED the patch link (#5080). Equal to `configPolicyId`
   * for an authored link; the parent's id when the link is inherited. The
   * scheduler still acts as `configPolicyId` — this is provenance.
   */
  sourcePolicyId: string;
  inherited: boolean;
  settings: PatchInlineSettings;
  ring: PatchRingResolution;
}

export interface PatchInventorySummary {
  total: number;
  ok: number;
  needsRepair: number;
  invalidReference: number;
}

/** Coerce a stored text[] column to a clean string[], tolerating null/garbage. */
function coerceCategoryList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((v): v is string => typeof v === 'string' && v.length > 0);
}

/**
 * #8030: the restart-prompt text columns are cosmetic, so an invalid stored
 * value (a hand-edited row, a future unvalidated write) must not make the
 * strict parse below throw and take the whole policy's patching down with it.
 * Each field is re-validated on its own; a failing one is nulled (the agent
 * then shows its built-in text) and reported. Mirrors rebootPromptTextFrom on
 * the dispatch path.
 */
export function salvageRebootPromptColumns(
  columns: { rebootPromptTitle: unknown; rebootPromptBody: unknown; rebootPromptButton: unknown },
  featureLinkId: string,
): { rebootPromptTitle: string | null; rebootPromptBody: string | null; rebootPromptButton: string | null } {
  const salvage = (field: 'title' | 'body' | 'button', column: string, value: unknown): string | null => {
    const parsed = rebootPromptTextSchemas[field].safeParse(value);
    if (parsed.success) return parsed.data;
    console.warn(
      `[configPolicyPatching] feature link ${featureLinkId} has an invalid stored ${column}; ignoring it`,
    );
    captureException(
      new Error(`Invalid config_policy_patch_settings.${column} for feature link ${featureLinkId}; ignored`),
    );
    return null;
  };
  return {
    rebootPromptTitle: salvage('title', 'reboot_prompt_title', columns.rebootPromptTitle),
    rebootPromptBody: salvage('body', 'reboot_prompt_body', columns.rebootPromptBody),
    rebootPromptButton: salvage('button', 'reboot_prompt_button', columns.rebootPromptButton),
  };
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
export function normalizeStoredInlineSettingsWithSalvage(
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

/**
 * A configuration-policy patch write tried to change approval config that now
 * lives on the Update Ring (#8186): the per-app `apps` rules, or switching
 * policy-level `autoApprove` on. Routes map it to a 400 with `code`.
 */
export class PolicyApprovalFieldMovedError extends Error {
  readonly status = 400 as const;
  readonly code = 'APPROVAL_RULES_MOVED_TO_RING' as const;

  constructor() {
    super('Approval and application rules are configured on the Update Ring linked to this policy.');
    this.name = 'PolicyApprovalFieldMovedError';
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

/**
 * What a rule list enforces, order- and case-insensitively: one
 * `key|action|version` token per entry (display names do not count, and a
 * block's stray version is ignored, as the evaluator ignores it). A
 * non-object entry keeps a raw token so it can never match a stored list.
 */
export function enforcedAppRuleSet(apps: unknown): string[] {
  if (!Array.isArray(apps)) return [];
  const tokens = apps.map((entry) => {
    if (!isRecord(entry)) return `invalid|${JSON.stringify(entry)}`;
    const key = canonicalAppRuleKey(String(entry.source), String(entry.packageId));
    const version = entry.action === 'pin' ? String(entry.pinnedVersion ?? '') : '';
    return `${key}|${String(entry.action)}|${version}`;
  });
  return [...new Set(tokens)].sort();
}

export function sameAppRuleSet(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((token, i) => token === b[i]);
}

/**
 * Reject a patch feature-link write that edits approval config which the
 * Update Ring now owns (#8186, Open Decision 4 = A):
 *  - `apps` present and enforcing a different set than the stored link's;
 *  - `autoApprove: true` when the stored link does not already have it.
 *
 * An unchanged round-trip passes, so a Patch tab loaded before the release
 * can still save its other fields. "Stored" is matched both as the raw link
 * salvages it and as the read path hands it to a client (a stored document
 * that fails validation is read back with schema defaults, i.e. `apps: []`).
 * `stored` is the link's current `inline_settings`, or null for a new link.
 */
export function assertNoPolicyApprovalEdits(
  stored: unknown,
  incoming: unknown,
  context: { configPolicyId: string; featureLinkId: string } = { configPolicyId: 'unknown', featureLinkId: 'unknown' },
): void {
  if (!isRecord(incoming)) return;

  if (incoming.apps !== undefined) {
    const incomingSet = enforcedAppRuleSet(incoming.apps);
    const acceptable = stored === null || stored === undefined
      ? [[]]
      : [
          enforcedAppRuleSet(
            normalizeStoredInlineSettingsWithSalvage(stored, context).apps,
          ),
          enforcedAppRuleSet(tryNormalizePatchInlineSettings(stored).settings.apps),
        ];
    if (!acceptable.some((set) => sameAppRuleSet(set, incomingSet))) {
      throw new PolicyApprovalFieldMovedError();
    }
  }

  if (incoming.autoApprove === true && !(isRecord(stored) && stored.autoApprove === true)) {
    throw new PolicyApprovalFieldMovedError();
  }
}

/**
 * The approval keys a patch link still stores from before the Update Ring
 * owned them (#8186). W04 strips them; until then a write that does not send
 * them keeps the stored values (#8671).
 */
export const LEGACY_PATCH_APPROVAL_KEYS = [
  'apps',
  'autoApprove',
  'autoApproveSeverities',
  'autoApproveDeferralDays',
] as const;

/**
 * `patchInlineSettingsSchema` fills an absent `apps` with `[]` and absent
 * `autoApprove*` with their defaults. Hand the service only the legacy
 * approval keys the client actually sent, so an omitted key means "unchanged"
 * rather than an explicit edit the ring-ownership guards reject (#8671).
 */
export function omitUnsentLegacyApprovalKeys(
  raw: unknown,
  parsed: Record<string, unknown>,
): Record<string, unknown> {
  const sent = isRecord(raw) ? raw : {};
  const result: Record<string, unknown> = { ...parsed };
  for (const key of LEGACY_PATCH_APPROVAL_KEYS) {
    if (!(key in sent)) delete result[key];
  }
  return result;
}

/**
 * Fill the legacy approval keys an update did not send from what the link
 * stores, so a write that omits them (the Patch tab, the AI tool, a PATCH
 * routed through `omitUnsentLegacyApprovalKeys`) does not reset them to
 * schema defaults (#8671). `stored` is the link JSONB with the relational
 * `autoApprove` the read path serves overlaid; `apps` comes from the salvage
 * reader so a stored document that fails validation still yields its valid
 * rules instead of failing the write.
 */
export function withStoredLegacyApprovalKeys(
  incoming: Record<string, unknown>,
  stored: unknown,
  context: { configPolicyId: string; featureLinkId: string },
): Record<string, unknown> {
  const missing = LEGACY_PATCH_APPROVAL_KEYS.filter((key) => !(key in incoming));
  if (missing.length === 0 || stored === null || stored === undefined) return incoming;
  const salvaged = normalizeStoredInlineSettingsWithSalvage(stored, context);
  const storedRecord = isRecord(stored) ? stored : {};
  const result: Record<string, unknown> = { ...incoming };
  for (const key of missing) {
    if (key === 'apps') {
      result.apps = salvaged.apps;
    } else if (key === 'autoApprove') {
      result.autoApprove = storedRecord.autoApprove === true;
    } else if (key === 'autoApproveSeverities') {
      result.autoApproveSeverities = salvaged.autoApproveSeverities;
    } else {
      result.autoApproveDeferralDays = salvaged.autoApproveDeferralDays;
    }
  }
  // The schema refuses autoApprove without a severity. A stored document can
  // only reach that state by failing validation (its severities fall back to
  // the default); the policy flag is inert since reads moved to the ring, so
  // drop it rather than fail an unrelated save.
  if (
    result.autoApprove === true
    && Array.isArray(result.autoApproveSeverities)
    && result.autoApproveSeverities.length === 0
  ) {
    console.warn(
      `[configPolicyPatching] Dropping stored autoApprove with no valid severity for config policy ` +
        `${context.configPolicyId} (feature link ${context.featureLinkId}); the Update Ring owns auto-approval`,
    );
    result.autoApprove = false;
  }
  return result;
}

/** The enforced set of a link's stored legacy `apps`, as the salvage reads it. */
export function storedLegacyAppRuleSet(
  stored: unknown,
  context: { configPolicyId: string; featureLinkId: string },
): string[] {
  if (stored === null || stored === undefined) return [];
  return enforcedAppRuleSet(normalizeStoredInlineSettingsWithSalvage(stored, context).apps);
}

/** The partner a configuration policy's patch ring must belong to. */
export async function loadConfigPolicyPartnerId(configPolicyId: string): Promise<string | null> {
  const [policy] = await db
    .select({ partnerId: configurationPolicies.partnerId, orgId: configurationPolicies.orgId })
    .from(configurationPolicies)
    .where(eq(configurationPolicies.id, configPolicyId))
    .limit(1);
  if (!policy) return null;
  if (policy.partnerId) return policy.partnerId;
  return policy.orgId ? resolvePartnerIdForOrg(policy.orgId) : null;
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
    return noRingResolution('null', true);
  }

  // #2822 / #7647. `patch_policies` is partner-axis, and the four routes in
  // routes/configurationPolicies/patchJobs.ts that consume this are
  // requireScope('organization','partner','system'). A plain request-context
  // read under an org-scoped caller used to return zero rows and fall through
  // to `classification: 'missing_target', valid: false` — so the UI reported a
  // perfectly good update ring as "invalid" while the system-scoped scheduler
  // executed the same job. The table's own-partner SELECT branch now makes it
  // legible in place to any context whose own partner is `partnerId`;
  // readOwnPartnerAxisRows only escapes (second pooled connection) for a
  // context that cannot see it. Self-tenanted by the caller-derived
  // `partnerId`, so no cross-partner reach.
  const [patchPolicy] = await readOwnPartnerAxisRows(partnerId, () =>
    db
      .select({
        id: patchPolicies.id,
        kind: patchPolicies.kind,
        name: patchPolicies.name,
        categoryRules: patchPolicies.categoryRules,
        categories: patchPolicies.categories,
        excludeCategories: patchPolicies.excludeCategories,
        autoApprove: patchPolicies.autoApprove,
        appRules: patchPolicies.appRules,
      })
      .from(patchPolicies)
      .where(and(eq(patchPolicies.id, featurePolicyId), eq(patchPolicies.partnerId, partnerId)))
      .limit(1)
  );

  if (patchPolicy) {
    if (patchPolicy.kind === 'ring') {
      return {
        classification: 'valid_ring',
        valid: true,
        ringId: patchPolicy.id,
        ringName: patchPolicy.name,
        categoryRules: Array.isArray(patchPolicy.categoryRules) ? patchPolicy.categoryRules : [],
        categories: coerceCategoryList(patchPolicy.categories),
        excludeCategories: coerceCategoryList(patchPolicy.excludeCategories),
        autoApprove: (patchPolicy.autoApprove ?? {}) as Record<string, unknown> | boolean,
        appRules: coerceRingAppRules(patchPolicy.appRules, patchPolicy.id),
      };
    }
    return noRingResolution('legacy_patch_policy', false);
  }

  const [configPolicy] = await db
    .select({ id: configurationPolicies.id })
    .from(configurationPolicies)
    .where(eq(configurationPolicies.id, featurePolicyId))
    .limit(1);

  if (configPolicy) {
    return noRingResolution('config_policy_uuid', false);
  }

  return noRingResolution('missing_target', false);
}

export async function loadPolicyLocalPatchConfig(
  configPolicyId: string
): Promise<PolicyLocalPatchConfig | null> {
  // EFFECTIVE (#5080). Once the patch scheduler enumerates through the view, a
  // child that inherits its parent's patch link is discovered as a candidate;
  // reading the authored table here would return null and silently skip it.
  // The link id is the parent's when inherited, on purpose — the normalized
  // `config_policy_patch_settings` join below keys on it unchanged.
  const [row] = await db
    .select({
      configPolicyId: configurationPolicies.id,
      configPolicyName: configurationPolicies.name,
      orgId: configurationPolicies.orgId,
      partnerId: configurationPolicies.partnerId,
      featureLinkId: configPolicyEffectiveFeatureLinks.id,
      featurePolicyId: configPolicyEffectiveFeatureLinks.featurePolicyId,
      storedInlineSettings: configPolicyEffectiveFeatureLinks.inlineSettings,
      sourcePolicyId: configPolicyEffectiveFeatureLinks.sourcePolicyId,
      inherited: configPolicyEffectiveFeatureLinks.inherited,
      patchSettings: configPolicyPatchSettings,
    })
    .from(configurationPolicies)
    .innerJoin(
      configPolicyEffectiveFeatureLinks,
      and(
        eq(configPolicyEffectiveFeatureLinks.configPolicyId, configurationPolicies.id),
        eq(configPolicyEffectiveFeatureLinks.featureType, 'patch')
      )
    )
    .leftJoin(
      configPolicyPatchSettings,
      eq(configPolicyPatchSettings.featureLinkId, configPolicyEffectiveFeatureLinks.id)
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
        offlineBehavior: row.patchSettings.offlineBehavior,
        rebootPolicy: row.patchSettings.rebootPolicy,
        rebootDelayMinutes: row.patchSettings.rebootDelayMinutes,
        rebootAllowDeferral: row.patchSettings.rebootAllowDeferral,
        rebootMaxDeferrals: row.patchSettings.rebootMaxDeferrals,
        rebootDeferralMinutes: row.patchSettings.rebootDeferralMinutes,
        ...salvageRebootPromptColumns(row.patchSettings, row.featureLinkId),
        exclusiveWindowsUpdate: row.patchSettings.exclusiveWindowsUpdate,
      })
    : storedInline;

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
    sourcePolicyId: row.sourcePolicyId,
    inherited: row.inherited,
    settings,
    ring,
  };
}

export async function backfillMissingPatchSettings(): Promise<{
  repaired: number;
  repairedFromInline: number;
  repairedWithDefaults: number;
}> {
  // AUTHORED (#5080): repairs the normalized row behind each real link. Through
  // the view one parent link would surface once per inheriting child, and this
  // would try to insert the same feature_link_id several times.
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
      offlineBehavior: normalized.settings.offlineBehavior,
      rebootPolicy: normalized.settings.rebootPolicy,
      rebootDelayMinutes: normalized.settings.rebootDelayMinutes,
      rebootAllowDeferral: normalized.settings.rebootAllowDeferral,
      rebootMaxDeferrals: normalized.settings.rebootMaxDeferrals,
      rebootDeferralMinutes: normalized.settings.rebootDeferralMinutes,
      rebootPromptTitle: normalized.settings.rebootPromptTitle,
      rebootPromptBody: normalized.settings.rebootPromptBody,
      rebootPromptButton: normalized.settings.rebootPromptButton,
      exclusiveWindowsUpdate: normalized.settings.exclusiveWindowsUpdate,
    });
    repaired += 1;
    if (normalized.valid) repairedFromInline += 1;
    else repairedWithDefaults += 1;
  }

  return { repaired, repairedFromInline, repairedWithDefaults };
}

async function buildPatchInventory(conditions: SQL[]): Promise<PatchInventoryRow[]> {
  // AUTHORED (#5080): the editor-facing "which policies have a broken patch
  // reference" report. It names the policy that must be FIXED, so an inherited
  // copy of a parent's link would report the same defect once per child.
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
