import { and, inArray, sql } from 'drizzle-orm';
import { db, runOutsideDbContext, withSystemDbAccessContext } from '../../db';
import { huntressIntegrations, huntressOrgMappings, organizations } from '../../db/schema';
import { getVendor, type VendorKey } from './securityAgentVendors';

/**
 * Installer-readiness preflight for managed security-agent installs (#6960).
 *
 * Answers "could an install of this vendor's agent on this device succeed with
 * the right keys?" WITHOUT decrypting anything, so the compliance worker can
 * treat a device whose org is not set up as NOT APPLICABLE instead of creating
 * a deployment that `resolveEdrInstaller` would fail at dispatch.
 *
 * Readiness is evaluated against the DEVICE's org and that org's partner's
 * integration, never against the policy owner: a partner-wide policy reaches
 * many orgs and each one is mapped (or not) on its own.
 *
 * Exhaustive over vendors. Vendors whose install path is not wired yet fail
 * closed (`vendor_unavailable`) rather than borrowing another vendor's checks.
 */

export type ReadinessReason =
  | 'org_not_mapped'
  | 'integration_inactive'
  | 'org_key_missing'
  | 'account_key_missing'
  | 'platform_unsupported'
  | 'requires_mdm_approval'
  /** The link limits the vendor to platforms that exclude this device's. */
  | 'platform_not_selected'
  /** Tenant-variable vendors: a required variable is not set for the org (wired with those vendors). */
  | 'var_missing'
  /** The vendor's readiness checks are not wired yet; never ready. */
  | 'vendor_unavailable';

export type ReadinessResult = { ok: true } | { ok: false; reason: ReadinessReason };

const READY: ReadinessResult = Object.freeze({ ok: true });

function notReady(reason: ReadinessReason): ReadinessResult {
  return { ok: false, reason };
}

/**
 * Platform half of readiness, pure. `selectedPlatforms` is the link's optional
 * per-vendor platform list; absent means every platform the vendor supports.
 * An os type the registry does not know is unsupported, never assumed Windows.
 */
export function evaluatePlatformReadiness(
  vendor: VendorKey,
  platform: string,
  selectedPlatforms?: readonly string[] | null,
): ReadinessResult {
  const platforms = getVendor(vendor).platforms as Readonly<Record<string, string | undefined>>;
  const support = Object.prototype.hasOwnProperty.call(platforms, platform) ? platforms[platform] : undefined;
  if (support === 'unsupported' || support === undefined) return notReady('platform_unsupported');
  if (support === 'requires_mdm') return notReady('requires_mdm_approval');
  if (selectedPlatforms && !selectedPlatforms.includes(platform)) return notReady('platform_not_selected');
  return READY;
}

/**
 * Org half of readiness for many orgs at once (at most three queries for
 * Huntress, whatever the org count). Every requested org gets an answer.
 *
 * Runs in its own system context: the Huntress tables are partner-axis and an
 * org-scoped caller would read zero rows. The lookups are keyed by the org ids
 * the caller passes, which come from the devices being evaluated, so the
 * escape cannot name another tenant's data by itself.
 */
export async function loadOrgInstallerReadiness(
  vendor: VendorKey,
  orgIds: readonly string[],
): Promise<Map<string, ReadinessResult>> {
  const unique = Array.from(new Set(orgIds.filter((id) => typeof id === 'string' && id.length > 0)));
  const result = new Map<string, ReadinessResult>();
  if (unique.length === 0) return result;

  switch (vendor) {
    case 'huntress':
      return loadHuntressReadiness(unique);
    case 'sentinelone':
    case 'controld':
    case 'nextdns':
      for (const orgId of unique) result.set(orgId, notReady('vendor_unavailable'));
      return result;
    default: {
      const unreachable: never = vendor;
      for (const orgId of unique) result.set(orgId, notReady('vendor_unavailable'));
      void unreachable;
      return result;
    }
  }
}

async function loadHuntressReadiness(orgIds: string[]): Promise<Map<string, ReadinessResult>> {
  const rows = await runOutsideDbContext(() =>
    withSystemDbAccessContext(async () => {
      const orgs = await db
        .select({ id: organizations.id, partnerId: organizations.partnerId })
        .from(organizations)
        .where(inArray(organizations.id, orgIds));

      const mappings = await db
        .select({
          orgId: huntressOrgMappings.orgId,
          partnerId: huntressOrgMappings.partnerId,
          integrationId: huntressOrgMappings.integrationId,
          orgKey: huntressOrgMappings.huntressOrgKey,
        })
        .from(huntressOrgMappings)
        .where(inArray(huntressOrgMappings.orgId, orgIds));

      const integrationIds = Array.from(new Set(mappings.map((m) => m.integrationId)));
      const integrations = integrationIds.length === 0
        ? []
        : await db
          .select({
            id: huntressIntegrations.id,
            partnerId: huntressIntegrations.partnerId,
            isActive: huntressIntegrations.isActive,
            // Presence only: the ciphertext itself never leaves the database.
            hasAccountKey: sql<boolean>`(${huntressIntegrations.accountKeyEncrypted} IS NOT NULL AND ${huntressIntegrations.accountKeyEncrypted} <> '')`,
          })
          .from(huntressIntegrations)
          .where(and(inArray(huntressIntegrations.id, integrationIds)));

      return { orgs, mappings, integrations };
    })
  );

  const partnerByOrg = new Map(rows.orgs.map((org) => [org.id, org.partnerId] as const));
  const integrationById = new Map(rows.integrations.map((integration) => [integration.id, integration] as const));

  const result = new Map<string, ReadinessResult>();
  for (const orgId of orgIds) {
    const partnerId = partnerByOrg.get(orgId) ?? null;
    // Only the org's OWN partner's mappings count: a mapping left behind under a
    // previous partner must not make the org look ready.
    const mappings = partnerId
      ? rows.mappings.filter((m) => m.orgId === orgId && m.partnerId === partnerId)
      : [];
    if (mappings.length === 0) {
      result.set(orgId, notReady('org_not_mapped'));
      continue;
    }
    // Dispatch (`resolveEdrInstaller`) reads ONE of the org's mappings without an
    // order, so the org is ready only when every candidate would succeed.
    let verdict: ReadinessResult = READY;
    for (const mapping of mappings) {
      const integration = integrationById.get(mapping.integrationId);
      if (!integration || !integration.isActive || integration.partnerId !== partnerId) {
        verdict = notReady('integration_inactive');
        break;
      }
      if (!mapping.orgKey || mapping.orgKey.trim().length === 0) {
        verdict = notReady('org_key_missing');
        break;
      }
      if (integration.hasAccountKey !== true) {
        verdict = notReady('account_key_missing');
        break;
      }
    }
    result.set(orgId, verdict);
  }
  return result;
}

/** Single-device form: platform first (no I/O), then the device org's integration. */
export async function checkInstallerReadiness(args: {
  vendor: VendorKey;
  deviceId: string;
  orgId: string;
  platform: string;
  selectedPlatforms?: readonly string[] | null;
}): Promise<ReadinessResult> {
  const platform = evaluatePlatformReadiness(args.vendor, args.platform, args.selectedPlatforms);
  if (!platform.ok) return platform;
  const byOrg = await loadOrgInstallerReadiness(args.vendor, [args.orgId]);
  return byOrg.get(args.orgId) ?? notReady('org_not_mapped');
}
