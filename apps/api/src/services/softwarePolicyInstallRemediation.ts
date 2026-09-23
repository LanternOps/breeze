import { and, eq, gte, inArray, isNull, notInArray, or, sql } from 'drizzle-orm';
import { db } from '../db';
import {
  deploymentResults,
  softwareCatalog,
  softwareDeployments,
  softwareInstallMethods,
  softwareVersions,
} from '../db/schema';
import { createSoftwareDeployment } from './softwareDeployment';

/**
 * #5505 W03 — everything that must be decided BEFORE a policy-owned
 * software_deployments row exists.
 *
 * The whole module runs inside the software remediation worker's SYSTEM db
 * context (softwareRemediationWorker.ts:14-22), where breeze_has_org_access
 * short-circuits true and RLS scopes nothing. Every predicate below is
 * therefore load-bearing on its own: a rule's catalogId is operator-authored
 * jsonb living in software_policies.rules, and nothing else checks it.
 */

/** Why a (policy, device, rule) triple produced no install deployment. */
export type PolicyInstallSkipReason =
  /** The rule can be DETECTED as missing but names nothing to install. */
  | 'no_catalog_id'
  /** The catalogId does not resolve to an item this device's tenant may use. */
  | 'catalog_item_not_reachable'
  /** Reachable item, but nothing installable on this device's OS. */
  | 'no_install_target_for_platform'
  /**
   * The job's payload named this catalog item, but the compliance row no
   * longer reports it missing — the job is stale, or it was forged. Recorded
   * rather than dropped: the audit row is the only durable place a technician
   * can see that a requested install was not attempted, and why.
   */
  | 'not_currently_missing';

export type PolicyInstallTarget =
  | { kind: 'install_method'; catalogId: string; installMethodId: string }
  | { kind: 'version'; catalogId: string; softwareVersionId: string };

export type PolicyInstallTargetResolution =
  | { ok: true; target: PolicyInstallTarget }
  | { ok: false; reason: PolicyInstallSkipReason };

/**
 * software_install_methods.platform is 'windows' | 'macos' only
 * (db/schema/software.ts:264) — there is no linux install method by
 * construction, so a linux device can only ever be served by a version row.
 */
const INSTALL_METHOD_PLATFORM_BY_OS_TYPE: Readonly<Record<string, 'windows' | 'macos'>> = {
  windows: 'windows',
  macos: 'macos',
};

/**
 * `supported_os` is an optional array of the same three values as
 * devices.os_type (routes/software.ts:465,523). Null, non-array or empty means
 * the uploader declared no restriction, which stays permissive — this filter
 * may only ever narrow what an operator already allowed, never widen it.
 */
function versionSupportsOs(supportedOs: unknown, osType: string): boolean {
  if (!Array.isArray(supportedOs) || supportedOs.length === 0) return true;
  return supportedOs.some((value) => typeof value === 'string' && value === osType);
}

/**
 * Resolve a catalog item the DEVICE's tenant is actually entitled to install.
 *
 * Mirrors the route-layer widening at routes/software.ts:867-870, but keyed on
 * the DEVICE's org rather than on a request's auth: an org-owned item must
 * belong to this device's org, and a partner-owned item (built-in integration
 * package or partner-wide custom package) is reachable only when this device's
 * org belongs to that partner. Anything else — including another org's item
 * under the same partner — resolves to nothing.
 */
async function readReachableCatalogItem(
  catalogId: string,
  deviceOrgId: string,
): Promise<{ id: string } | null> {
  const [row] = await db
    .select({ id: softwareCatalog.id })
    .from(softwareCatalog)
    .where(
      and(
        eq(softwareCatalog.id, catalogId),
        // An archived package (#4980) is unreachable, exactly like a deleted one.
        isNull(softwareCatalog.deletedAt),
        or(
          eq(softwareCatalog.orgId, deviceOrgId),
          and(
            isNull(softwareCatalog.orgId),
            sql`EXISTS (
              SELECT 1 FROM organizations o
              WHERE o.id = ${deviceOrgId}
                AND o.partner_id = ${softwareCatalog.partnerId}
            )`,
          ),
        ),
      ),
    )
    .limit(1);
  return row ?? null;
}

/**
 * Resolve a policy rule's catalogId to exactly one deployment target for this
 * device, or say precisely why it cannot.
 *
 * Package-manager install methods win over uploaded versions when both exist:
 * a manager deploy always resolves the current package at install time, so it
 * cannot go stale the way a pinned version row can.
 *
 * The platform filter is deliberately done HERE rather than relying on
 * softwareDeployment.ts:413-429, which (a) only covers the install-method path
 * and never the version path, and (b) fires downstream, after a deployment row
 * and a failed deployment_results row already exist — which a compliance pass
 * every 15 minutes would turn into an unbounded stream of guaranteed-failing
 * deployments for every cross-platform device under the policy.
 */
export async function resolvePolicyInstallTarget(input: {
  catalogId: string | null | undefined;
  deviceOrgId: string;
  deviceOsType: string;
}): Promise<PolicyInstallTargetResolution> {
  if (!input.catalogId) {
    return { ok: false, reason: 'no_catalog_id' };
  }

  const catalogItem = await readReachableCatalogItem(input.catalogId, input.deviceOrgId);
  if (!catalogItem) {
    return { ok: false, reason: 'catalog_item_not_reachable' };
  }

  const platform = INSTALL_METHOD_PLATFORM_BY_OS_TYPE[input.deviceOsType];
  if (platform) {
    const [method] = await db
      .select({ id: softwareInstallMethods.id })
      .from(softwareInstallMethods)
      .where(
        and(
          eq(softwareInstallMethods.catalogId, catalogItem.id),
          eq(softwareInstallMethods.platform, platform),
          eq(softwareInstallMethods.enabled, true),
        ),
      )
      .limit(1);
    if (method) {
      return {
        ok: true,
        target: { kind: 'install_method', catalogId: catalogItem.id, installMethodId: method.id },
      };
    }
  }

  // At most one row can match: software_versions_one_latest_per_catalog_idx is
  // a unique partial index on (catalog_id) WHERE is_latest = true.
  const [version] = await db
    .select({ id: softwareVersions.id, supportedOs: softwareVersions.supportedOs })
    .from(softwareVersions)
    .where(
      and(eq(softwareVersions.catalogId, catalogItem.id), eq(softwareVersions.isLatest, true)),
    )
    .limit(1);

  if (!version || !versionSupportsOs(version.supportedOs, input.deviceOsType)) {
    return { ok: false, reason: 'no_install_target_for_platform' };
  }

  return {
    ok: true,
    target: { kind: 'version', catalogId: catalogItem.id, softwareVersionId: version.id },
  };
}

/**
 * Mirrors IN_FLIGHT_LOOKBACK_MINUTES (softwareRemediationWorker.ts:36) so both
 * verbs forget stuck work on the same horizon. Its job here is to bound the
 * cost of the deliberately conservative "unfinished" definition below: without
 * it, one permanently wedged deployment_results row would suppress every future
 * policy install for that (policy, device) pair forever.
 */
export const POLICY_INSTALL_IN_FLIGHT_LOOKBACK_MINUTES = 24 * 60;

/**
 * The CLOSED set of deployment_status values that mean "this device is done
 * with that deployment". Deliberately a terminal list rather than a live list:
 * a deployment_status enum member added later then counts as UNFINISHED and
 * suppresses a duplicate install, which is the safe direction — the spec's
 * top-ranked customer-facing risk is an install loop, not a delayed install.
 * (deployment_status = draft|pending|running|paused|downloading|installing|
 *  completed|failed|cancelled|rollback — db/schema/deployments.ts:15-26.
 *  'rollback' is deliberately NOT terminal.)
 */
export const FINISHED_POLICY_INSTALL_RESULT_STATUSES = [
  'completed',
  'failed',
  'cancelled',
] as const;

/**
 * The install-side dedup, and the reason W03 adds a column instead of reusing
 * readInFlightUninstallKeys (softwareRemediationWorker.ts:168-195): that query
 * pins device_commands.type to SOFTWARE_UNINSTALL, so it is structurally blind
 * to installs. This asks the deployment row instead — is there already
 * unfinished policy-owned work for this exact (policy, device)?
 */
export async function hasUnfinishedPolicyOwnedInstall(
  policyId: string,
  deviceId: string,
): Promise<boolean> {
  const cutoff = new Date(Date.now() - POLICY_INSTALL_IN_FLIGHT_LOOKBACK_MINUTES * 60 * 1000);
  const [row] = await db
    .select({ id: deploymentResults.id })
    .from(deploymentResults)
    .innerJoin(softwareDeployments, eq(softwareDeployments.id, deploymentResults.deploymentId))
    .where(
      and(
        eq(softwareDeployments.softwarePolicyId, policyId),
        eq(deploymentResults.deviceId, deviceId),
        notInArray(deploymentResults.status, [...FINISHED_POLICY_INSTALL_RESULT_STATUSES]),
        gte(softwareDeployments.createdAt, cutoff),
      ),
    )
    .limit(1);
  return row != null;
}

/**
 * Create ONE policy-owned deployment for ONE device and dispatch it through the
 * existing seam.
 *
 * `orgId` is the DEVICE's org, never the policy's: a partner-wide policy has
 * org_id NULL, and every worker-created child row takes the device's org (the
 * partner-wide playbook's rule, and the same rule the audit rows follow at
 * softwareRemediationWorker.ts:264).
 *
 * `createdBy: null` is required and deliberate — createSoftwareDeployment
 * declares it non-optional (softwareDeployment.ts:46) and there is no operator
 * behind an automatic remediation. `scheduleType: 'immediate'` +
 * `deploymentType: 'install'` is what makes createSoftwareDeployment take its
 * dispatch branch (:1103) rather than leaving the row sitting for the scheduler.
 *
 * Exactly one of installMethodId / softwareVersionId is set, mirroring
 * software_deployments_one_target_chk; passing both or neither throws at
 * softwareDeployment.ts:998-1002.
 *
 * Nothing here touches the EDR secret-resolution branch
 * (softwareDeployment.ts:554-584): that fires only when the resolved catalog
 * item's integrationProvider is 'huntress' or 'sentinelone', and this path adds
 * no special handling for it either way.
 */
export async function createPolicyOwnedInstallDeployment(input: {
  policyId: string;
  policyName: string;
  orgId: string;
  deviceId: string;
  target: PolicyInstallTarget;
}): Promise<{ deploymentId: string; status: 'pending' | 'failed'; message?: string }> {
  const targetFields =
    input.target.kind === 'install_method'
      ? { installMethodId: input.target.installMethodId, versionMode: 'latest' as const }
      : { softwareVersionId: input.target.softwareVersionId };

  const result = await createSoftwareDeployment({
    orgId: input.orgId,
    ...targetFields,
    deploymentType: 'install',
    deviceIds: [input.deviceId],
    scheduleType: 'immediate',
    createdBy: null,
    // software_deployments.name is varchar(255) and software_policies.name is
    // varchar(200), so the prefixed form always fits.
    name: `Policy: ${input.policyName}`,
    targetType: 'devices',
    targetIds: [input.deviceId],
    softwarePolicyId: input.policyId,
  });

  return {
    deploymentId: result.deploymentId,
    status: result.status,
    ...(result.message ? { message: result.message } : {}),
  };
}

/**
 * The newest policy-owned deployment per device for one policy, batched.
 *
 * Feeds the compliance worker's orphaned-install reconcile sweep (#5505 W03),
 * which must distinguish "this enqueue produced a deployment" from "this
 * enqueue produced nothing". Mere MEMBERSHIP is not enough: a device whose
 * PREVIOUS cycle installed successfully still has policy-owned deployments, so
 * the sweep needs the timestamp to compare against
 * last_install_remediation_attempt.
 *
 * Deliberately not bounded by POLICY_INSTALL_IN_FLIGHT_LOOKBACK_MINUTES: the
 * comparison the caller makes is against its own attempt timestamp, and an
 * older bound would hide exactly the rows it needs to see.
 */
export async function readLatestPolicyOwnedInstallByDevice(
  policyId: string,
  deviceIds: string[],
): Promise<Map<string, Date>> {
  const byDevice = new Map<string, Date>();
  const normalized = Array.from(
    new Set(deviceIds.filter((id): id is string => typeof id === 'string' && id.length > 0)),
  );
  if (normalized.length === 0) return byDevice;

  const rows = await db
    .select({
      deviceId: deploymentResults.deviceId,
      createdAt: softwareDeployments.createdAt,
    })
    .from(deploymentResults)
    .innerJoin(softwareDeployments, eq(softwareDeployments.id, deploymentResults.deploymentId))
    .where(
      and(
        eq(softwareDeployments.softwarePolicyId, policyId),
        inArray(deploymentResults.deviceId, normalized),
      ),
    );

  for (const row of rows) {
    // software_deployments.created_at is NOT NULL, but this reads a join result
    // that a future schema change could widen — a garbage value must be dropped
    // rather than stored as an Invalid Date that silently compares false.
    if (!(row.createdAt instanceof Date) || Number.isNaN(row.createdAt.getTime())) continue;
    const existing = byDevice.get(row.deviceId);
    if (!existing || row.createdAt.getTime() > existing.getTime()) {
      byDevice.set(row.deviceId, row.createdAt);
    }
  }
  return byDevice;
}
