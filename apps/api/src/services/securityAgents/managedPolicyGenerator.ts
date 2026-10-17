import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import {
  securityAgentsInlineSettingsSchema,
  type SecurityAgentsInlineSettings,
} from '@breeze/shared/validators';
import { db, runOutsideDbContext, withSystemDbAccessContext } from '../../db';
import { captureException } from '../sentry';
import {
  configPolicyFeatureLinks,
  configurationPolicies,
  organizations,
  softwareCatalog,
  softwareComplianceStatus,
  softwarePolicies,
  softwarePolicyAudit,
  type SoftwarePolicyRemediationOptions,
  type SoftwarePolicyRulesDefinition,
} from '../../db/schema';
import { getVendor, listVendors, type VendorKey } from './securityAgentVendors';
import { SecurityAgentsLinkWriteError } from './securityAgentsLinkWrite';

/**
 * Generator for the software policy a `security_agents` feature link owns
 * (#6960). The link holds desired state (which vendors); the generated
 * `software_policies` row (found by `managed_by_link_id`) is what the existing
 * software compliance / install-remediation pipeline enforces.
 *
 * Runs synchronously inside the link-write transaction (so "enable" returns
 * with the rule in place, and a missing catalog package refuses the write), and
 * from a periodic repair sweep that re-derives every link's policy.
 *
 * Invariants:
 *  - The owner axis is the CONFIG POLICY's: partner-wide config policy →
 *    partner-owned software policy; org config policy → org-owned.
 *  - Disabling the last vendor DEACTIVATES the row (kept for audit and reuse);
 *    deleting the link deletes it (FK cascade). Neither ever uninstalls.
 *  - Any change to what is enforced bumps `approval_generation`, so install
 *    jobs queued under the old shape are refused at dispatch.
 *  - Only vendors that are enableable in the registry get a rule, so a stored
 *    blob can never arm a vendor whose install path is not wired.
 *
 * Authorization lives with the callers, not here: this file is allowlisted in
 * the partner-wide and site-ceiling write-coverage contract tests on the
 * grounds that its only request-path callers (the feature-link route and the
 * config-policy AI tool) run the site-ceiling gate and, for a partner-wide
 * config policy, the partner-wide gate before the link write. A new caller
 * must gate the same way, or the allowlist reasons become false; the caller set
 * is pinned by managedPolicyGenerator.callers.contract.test.ts.
 */

type DbExecutor = typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0];

export type ManagedConfigPolicy = {
  id: string;
  name: string;
  orgId: string | null;
  partnerId: string | null;
};

export type ManagedPolicyRow = {
  orgId: string | null;
  partnerId: string | null;
  name: string;
  description: string;
  mode: 'allowlist';
  rules: SoftwarePolicyRulesDefinition & { software: Array<{ name: string; catalogId: string; reason: string }> };
  enforceMode: true;
  remediationOptions: SoftwarePolicyRemediationOptions;
  isActive: boolean;
};

const NAME_PREFIX = 'Security agents: ';
const NAME_MAX = 200;

export const SECURITY_AGENTS_CATALOG_MISSING_CODE = 'security_agents_catalog_missing' as const;

/** Pure: the row the link's settings ask for. */
export function desiredManagedPolicy(input: {
  configPolicy: ManagedConfigPolicy;
  settings: SecurityAgentsInlineSettings;
  catalogIdByVendor: ReadonlyMap<VendorKey, string>;
}): { row: ManagedPolicyRow; vendors: VendorKey[]; missingCatalog: VendorKey[] } {
  const enabled = new Set(input.settings.agents.filter((agent) => agent.enabled).map((agent) => agent.vendor));
  const vendors: VendorKey[] = [];
  const missingCatalog: VendorKey[] = [];
  const software: ManagedPolicyRow['rules']['software'] = [];
  // Registry order, so the rule list is stable whatever order the link lists vendors in.
  for (const vendor of listVendors()) {
    if (!enabled.has(vendor.key) || !vendor.enableable) continue;
    const catalogId = input.catalogIdByVendor.get(vendor.key);
    if (!catalogId) {
      missingCatalog.push(vendor.key);
      continue;
    }
    vendors.push(vendor.key);
    software.push({
      name: vendor.detectionRuleName,
      catalogId,
      reason: `${vendor.label} is required by a configuration policy (Security Agents)`,
    });
  }

  const partnerWide = input.configPolicy.orgId === null;
  return {
    row: {
      orgId: input.configPolicy.orgId,
      partnerId: partnerWide ? input.configPolicy.partnerId : null,
      name: `${NAME_PREFIX}${input.configPolicy.name}`.slice(0, NAME_MAX),
      description: 'Generated from a configuration policy (Security Agents). Read-only: change it from that configuration policy.',
      mode: 'allowlist',
      rules: { software, allowUnknown: true },
      enforceMode: true,
      remediationOptions: { autoInstall: true, autoUninstall: false },
      isActive: software.length > 0,
    },
    vendors,
    missingCatalog,
  };
}

type ExistingManagedRow = Pick<
  ManagedPolicyRow,
  'orgId' | 'partnerId' | 'name' | 'mode' | 'rules' | 'enforceMode' | 'remediationOptions' | 'isActive'
> & { description?: string | null };

export type ManagedPolicySyncPlan =
  | { action: 'none' }
  | { action: 'create' }
  | { action: 'update'; bumpGeneration: boolean; removedCatalogIds: string[] };

function catalogIdsOf(rules: unknown): string[] {
  const software = (rules as { software?: unknown } | null)?.software;
  if (!Array.isArray(software)) return [];
  return software
    .map((rule) => (rule && typeof rule === 'object' ? (rule as { catalogId?: unknown }).catalogId : undefined))
    .filter((id): id is string => typeof id === 'string' && id.length > 0);
}

/** Key-order-insensitive: jsonb hands keys back shortest-first, not as written. */
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`).join(',')}}`;
  }
  return JSON.stringify(value ?? null);
}

function sameJson(a: unknown, b: unknown): boolean {
  return canonicalJson(a) === canonicalJson(b);
}

/** Pure: what to do to bring the stored row to the desired one. */
export function planManagedPolicySync(existing: ExistingManagedRow | null, desired: ManagedPolicyRow): ManagedPolicySyncPlan {
  if (!existing) return desired.isActive ? { action: 'create' } : { action: 'none' };

  const enforcementChanged =
    existing.isActive !== desired.isActive
    || existing.mode !== desired.mode
    || existing.enforceMode !== desired.enforceMode
    || !sameJson(existing.rules, desired.rules)
    || !sameJson(existing.remediationOptions, desired.remediationOptions)
    || existing.orgId !== desired.orgId
    || existing.partnerId !== desired.partnerId;
  const labelChanged = existing.name !== desired.name
    || (existing.description !== undefined && existing.description !== desired.description);

  if (!enforcementChanged && !labelChanged) return { action: 'none' };

  const kept = new Set(catalogIdsOf(desired.rules));
  const removedCatalogIds = catalogIdsOf(existing.rules).filter((id) => !kept.has(id));
  return { action: 'update', bumpGeneration: enforcementChanged, removedCatalogIds };
}

export type ManagedPolicySyncResult = {
  policyId: string | null;
  action: ManagedPolicySyncPlan['action'];
  vendors: VendorKey[];
  /** Enabled vendors left without a rule because the partner has no catalog package (skip mode only). */
  skippedVendors: VendorKey[];
};

/**
 * Bring the link's generated software policy in line with its settings, on the
 * caller's executor (the link-write transaction, or the sweep's).
 *
 * `onMissingCatalog: 'refuse'` (the write path) throws a 400
 * SecurityAgentsLinkWriteError naming where to connect the integration, so an
 * enable never silently produces nothing. `'skip'` (the sweep) leaves the
 * vendor without a rule and reports it.
 */
export async function syncManagedSoftwarePolicy(
  executor: DbExecutor,
  link: { id: string; configPolicyId: string; inlineSettings: unknown },
  options: { actorUserId?: string | null; onMissingCatalog?: 'refuse' | 'skip' } = {},
): Promise<ManagedPolicySyncResult> {
  const parsed = securityAgentsInlineSettingsSchema.safeParse(link.inlineSettings);
  // An unparseable stored blob installs nothing (same rule as the resolver).
  // The write path refuses such blobs, so this means a direct DB edit or a
  // schema change: say so, because it deactivates the generated policy.
  if (!parsed.success) {
    console.error('[securityAgents] security_agents link has unparseable settings; generating no rules', {
      linkId: link.id,
      configPolicyId: link.configPolicyId,
      issue: parsed.error.issues[0]?.message,
    });
  }
  const settings: SecurityAgentsInlineSettings = parsed.success ? parsed.data : { version: 1, agents: [] };

  const [configPolicy] = await executor
    .select({
      id: configurationPolicies.id,
      name: configurationPolicies.name,
      orgId: configurationPolicies.orgId,
      partnerId: configurationPolicies.partnerId,
    })
    .from(configurationPolicies)
    .where(eq(configurationPolicies.id, link.configPolicyId))
    .limit(1);
  if (!configPolicy) throw new Error(`Configuration policy ${link.configPolicyId} not found for security agents link ${link.id}`);

  const catalogIdByVendor = await readOwnerCatalog(executor, configPolicy, settings);
  const desired = desiredManagedPolicy({ configPolicy, settings, catalogIdByVendor });

  if (desired.missingCatalog.length > 0 && options.onMissingCatalog !== 'skip') {
    const first = getVendor(desired.missingCatalog[0]!);
    throw new SecurityAgentsLinkWriteError({
      status: 400,
      body: {
        error: `${desired.missingCatalog.map((key) => getVendor(key).label).join(', ')} cannot be enabled until its integration is connected for this partner.`,
        code: SECURITY_AGENTS_CATALOG_MISSING_CODE,
        vendors: desired.missingCatalog,
        setupPath: first.setupPath,
      },
    });
  }

  const [existing] = await executor
    .select({
      id: softwarePolicies.id,
      orgId: softwarePolicies.orgId,
      partnerId: softwarePolicies.partnerId,
      name: softwarePolicies.name,
      description: softwarePolicies.description,
      mode: softwarePolicies.mode,
      rules: softwarePolicies.rules,
      enforceMode: softwarePolicies.enforceMode,
      remediationOptions: softwarePolicies.remediationOptions,
      isActive: softwarePolicies.isActive,
    })
    .from(softwarePolicies)
    .where(eq(softwarePolicies.managedByLinkId, link.id))
    .limit(1)
    .for('update');

  const plan = planManagedPolicySync(existing ? (existing as ExistingManagedRow) : null, desired.row);
  const base = { vendors: desired.vendors, skippedVendors: desired.missingCatalog, action: plan.action };

  if (plan.action === 'none') return { ...base, policyId: existing?.id ?? null };

  const auditOwner = { orgId: desired.row.orgId, partnerId: desired.row.partnerId };
  const actor = options.actorUserId ? { actor: 'user', actorId: options.actorUserId } : { actor: 'system', actorId: null };

  if (plan.action === 'create') {
    const [created] = await executor
      .insert(softwarePolicies)
      .values({ ...desired.row, managedByLinkId: link.id, createdBy: options.actorUserId ?? null })
      .returning({ id: softwarePolicies.id });
    if (!created) throw new Error(`Failed to create the managed software policy for link ${link.id}`);
    await executor.insert(softwarePolicyAudit).values({
      ...auditOwner,
      policyId: created.id,
      action: 'policy_created',
      ...actor,
      details: { managedByLinkId: link.id, configPolicyId: configPolicy.id, vendors: desired.vendors },
    });
    return { ...base, policyId: created.id };
  }

  await executor
    .update(softwarePolicies)
    .set({
      ...desired.row,
      updatedAt: new Date(),
      ...(plan.bumpGeneration ? { approvalGeneration: sql`${softwarePolicies.approvalGeneration} + 1` } : {}),
    })
    .where(eq(softwarePolicies.id, existing!.id));

  if (plan.removedCatalogIds.length > 0) {
    await dropCachedViolations(executor, existing!.id, plan.removedCatalogIds);
  }

  await executor.insert(softwarePolicyAudit).values({
    ...auditOwner,
    policyId: existing!.id,
    // `policy_deactivated` only on the transition, so a later relabel of an
    // already-inactive row does not read as another deactivation.
    action: !desired.row.isActive && existing!.isActive ? 'policy_deactivated' : 'policy_updated',
    ...actor,
    details: {
      managedByLinkId: link.id,
      configPolicyId: configPolicy.id,
      vendors: desired.vendors,
      removedCatalogIds: plan.removedCatalogIds,
      generationBumped: plan.bumpGeneration,
    },
  });
  return { ...base, policyId: existing!.id };
}

/**
 * The partner's built-in catalog package per enabled vendor. The owner's
 * partner: the config policy's own for a partner-wide policy, its org's for an
 * org policy. Built-in packages are partner rows that every org of the partner
 * may read (software_catalog SELECT branch for integration packages).
 */
async function readOwnerCatalog(
  executor: DbExecutor,
  configPolicy: ManagedConfigPolicy,
  settings: SecurityAgentsInlineSettings,
): Promise<Map<VendorKey, string>> {
  const providers = settings.agents
    .filter((agent) => agent.enabled)
    .map((agent) => getVendor(agent.vendor).integrationProvider)
    .filter((provider): provider is 'huntress' | 'sentinelone' => provider !== null);
  const result = new Map<VendorKey, string>();
  if (providers.length === 0) return result;

  let partnerId = configPolicy.partnerId;
  if (configPolicy.orgId) {
    const [org] = await executor
      .select({ partnerId: organizations.partnerId })
      .from(organizations)
      .where(eq(organizations.id, configPolicy.orgId))
      .limit(1);
    partnerId = org?.partnerId ?? null;
  }
  if (!partnerId) return result;

  const rows = await executor
    .select({ id: softwareCatalog.id, integrationProvider: softwareCatalog.integrationProvider, createdAt: softwareCatalog.createdAt })
    .from(softwareCatalog)
    .where(and(
      eq(softwareCatalog.partnerId, partnerId),
      isNull(softwareCatalog.orgId),
      isNull(softwareCatalog.deletedAt),
      inArray(softwareCatalog.integrationProvider, providers),
    ));
  // Oldest first: ensureBuiltinPackage reuses the first row it finds, so the
  // oldest is the one integration connects keep pointing at.
  rows.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
  for (const vendor of listVendors()) {
    if (!vendor.integrationProvider || result.has(vendor.key)) continue;
    const row = rows.find((candidate) => candidate.integrationProvider === vendor.integrationProvider);
    if (row) result.set(vendor.key, row.id);
  }
  return result;
}

/**
 * Remove cached `missing` violations for rules the policy no longer has, so a
 * device is not shown non-compliant for a vendor that was switched off. The
 * next compliance pass recomputes everything; this only stops the stale read
 * in between.
 */
async function dropCachedViolations(executor: DbExecutor, policyId: string, removedCatalogIds: string[]): Promise<void> {
  const removed = sql`ARRAY[${sql.join(removedCatalogIds.map((id) => sql`${id}`), sql`, `)}]::text[]`;
  await executor
    .update(softwareComplianceStatus)
    .set({
      violations: sql`COALESCE((
        SELECT jsonb_agg(v) FROM jsonb_array_elements(${softwareComplianceStatus.violations}) AS v
        WHERE NOT (COALESCE(v->'rule'->>'catalogId', '') = ANY(${removed}))
      ), '[]'::jsonb)`,
    })
    .where(and(
      eq(softwareComplianceStatus.policyId, policyId),
      sql`jsonb_typeof(${softwareComplianceStatus.violations}) = 'array'`,
    ));
  await executor
    .update(softwareComplianceStatus)
    .set({ status: 'compliant' })
    .where(and(
      eq(softwareComplianceStatus.policyId, policyId),
      eq(softwareComplianceStatus.status, 'violation'),
      sql`jsonb_array_length(COALESCE(${softwareComplianceStatus.violations}, '[]'::jsonb)) = 0`,
    ));
}

/**
 * Periodic repair: re-derive the generated policy of every `security_agents`
 * link, so drift from direct DB edits, a deleted or archived catalog package,
 * or a registry change is corrected.
 *
 * Each link runs in its OWN system transaction (outside any ambient one, so the
 * caller's job transaction does not hold every link's row lock until it ends).
 * The transaction locks the link row, which serializes it against a concurrent
 * link write. A failing link is logged, sent to Sentry and skipped; the caller
 * sees the count in `failed`.
 */
export async function repairManagedSoftwarePolicies(): Promise<{ links: number; changed: number; failed: number }> {
  const links = await db
    .select({ id: configPolicyFeatureLinks.id })
    .from(configPolicyFeatureLinks)
    .where(eq(configPolicyFeatureLinks.featureType, 'security_agents'));

  let changed = 0;
  let failed = 0;
  for (const { id } of links) {
    try {
      const result = await runOutsideDbContext(() => withSystemDbAccessContext(() => db.transaction(async (tx) => {
        const [link] = await tx
          .select({
            id: configPolicyFeatureLinks.id,
            configPolicyId: configPolicyFeatureLinks.configPolicyId,
            inlineSettings: configPolicyFeatureLinks.inlineSettings,
          })
          .from(configPolicyFeatureLinks)
          .where(eq(configPolicyFeatureLinks.id, id))
          .limit(1)
          .for('update');
        if (!link) return null;
        return syncManagedSoftwarePolicy(tx, link, { onMissingCatalog: 'skip' });
      })));
      if (!result) continue;
      if (result.action !== 'none') {
        changed += 1;
        console.warn('[securityAgents] Repaired generated software policy', {
          linkId: id,
          policyId: result.policyId,
          action: result.action,
        });
      }
      if (result.skippedVendors.length > 0) {
        // Enforcement for these vendors has stopped (their rule is gone): an
        // operator needs to see it, not only a log line.
        console.warn('[securityAgents] Enabled vendor has no catalog package; no rule generated', {
          linkId: id,
          vendors: result.skippedVendors,
        });
        captureException(
          new Error('Security agents: enabled vendor has no catalog package; its rule was not generated'),
          undefined,
          { area: 'security_agents_repair', vendors: result.skippedVendors.join(',') },
          { fingerprint: ['security_agents_repair', 'catalog_missing'] },
        );
      }
    } catch (error) {
      failed += 1;
      console.error('[securityAgents] Failed to repair generated software policy', { linkId: id, error });
      captureException(error, undefined, { area: 'security_agents_repair' }, {
        fingerprint: ['security_agents_repair', 'link_failed'],
      });
    }
  }
  return { links: links.length, changed, failed };
}
