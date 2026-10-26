import { eq, inArray } from 'drizzle-orm';
import { securityAgentsInlineSettingsSchema } from '@breeze/shared/validators';
import { db } from '../../db';
import {
  configPolicyFeatureLinks,
  softwareCatalog,
  type SoftwarePolicyRulesDefinition,
  type SoftwarePolicyViolation,
} from '../../db/schema';
import {
  evaluatePlatformReadiness,
  loadOrgInstallerReadiness,
  type ReadinessReason,
  type ReadinessResult,
} from './installerReadiness';
import { vendorForCatalogPackage, type VendorKey } from './securityAgentVendors';

/**
 * Which rules of a GENERATED (security agents) software policy apply to which
 * devices, for one compliance pass (#6960).
 *
 * A rule's vendor is derived from its catalogId: the catalog row's
 * integration_provider (EDR vendors) or builtin_package_key (tenant-variable
 * vendors, whose rows each serve exactly one OS). Its applicability on a
 * device is the installer readiness preflight: platform first (registry
 * support, the row's own OS, then the link's own platform list), then the
 * DEVICE's org (EDR mapping and keys, or the org's tenant variables).
 *
 * Every violation a managed rule can carry is filtered: `missing` (#6960 W02)
 * and the `service_running` bridge's `not_running` / `service_unverified`
 * (#6958 D5 obligation). In today's compliance pass the filter runs before the
 * bridge, and the bridge only converts a surviving `missing` or adds a
 * violation for an inventory-matched rule (which a DNS rule, named after its
 * pinned package, never is), so a not-ready device gets no service violation;
 * filtering the service types as well keeps that true whatever the order.
 *
 * Fail-closed: a rule whose catalog row is not a known vendor package, or a
 * device the pass did not describe, is not applicable. A managed policy only
 * ever installs through these checks.
 *
 * Loaded once per pass: two queries plus one batched readiness read per vendor,
 * whatever the device count. Runs in the compliance worker's system context.
 */

export type NotApplicableEntry = { catalogId: string; vendor: VendorKey | null; reason: ReadinessReason };

export type DeviceVendorReadiness = { catalogId: string; vendor: VendorKey; result: ReadinessResult };

export interface ManagedRuleApplicability {
  /**
   * Readiness of every known-vendor rule for one device, whether or not the
   * device has a violation for it (#6960 W03: persisted as coverage state).
   * Rules whose catalog row is not a vendor package are omitted: there is no
   * vendor to key a status row on.
   */
  evaluateDevice(deviceId: string): DeviceVendorReadiness[];
  /** Vendors this policy's rules resolve to, in rule order. */
  vendors(): VendorKey[];
  filterViolations(
    deviceId: string,
    violations: SoftwarePolicyViolation[],
  ): { violations: SoftwarePolicyViolation[]; notApplicable: NotApplicableEntry[] };
}

/** Violation types that belong to a managed rule (and so to its vendor's readiness). */
const MANAGED_RULE_VIOLATION_TYPES: ReadonlySet<SoftwarePolicyViolation['type']> = new Set([
  'missing',
  'not_running',
  'service_unverified',
]);

export async function loadManagedRuleApplicability(
  policy: { id: string; managedByLinkId: string; rules: SoftwarePolicyRulesDefinition },
  devices: ReadonlyArray<{ deviceId: string; orgId: string; osType: string }>,
): Promise<ManagedRuleApplicability> {
  const catalogIds = Array.from(new Set(
    (policy.rules.software ?? [])
      .map((rule) => rule.catalogId)
      .filter((id): id is string => typeof id === 'string' && id.length > 0),
  ));

  const vendorByCatalogId = new Map<string, VendorKey | null>();
  // The single OS a built-in (tenant-variable) row installs on; absent for EDR
  // integration rows, which serve every platform the vendor supports.
  const platformByCatalogId = new Map<string, string>();
  if (catalogIds.length > 0) {
    const rows = await db
      .select({
        id: softwareCatalog.id,
        integrationProvider: softwareCatalog.integrationProvider,
        builtinPackageKey: softwareCatalog.builtinPackageKey,
      })
      .from(softwareCatalog)
      .where(inArray(softwareCatalog.id, catalogIds));
    for (const row of rows) {
      const pkg = vendorForCatalogPackage(row);
      vendorByCatalogId.set(row.id, pkg?.vendor ?? null);
      if (pkg?.platform) platformByCatalogId.set(row.id, pkg.platform);
    }
  }

  // The ONE authored link this policy hangs on: its per-vendor platform list.
  const [link] = await db
    .select({ inlineSettings: configPolicyFeatureLinks.inlineSettings })
    .from(configPolicyFeatureLinks)
    .where(eq(configPolicyFeatureLinks.id, policy.managedByLinkId))
    .limit(1);
  const parsed = securityAgentsInlineSettingsSchema.safeParse(link?.inlineSettings);
  // Without readable link settings the per-vendor platform limits are unknown,
  // so nothing applies (fail closed) rather than "every platform".
  const linkUnreadable = !parsed.success;
  if (linkUnreadable) {
    console.error('[securityAgents] Generated policy link missing or unparseable; treating every rule as not applicable', {
      policyId: policy.id,
      managedByLinkId: policy.managedByLinkId,
      found: !!link,
    });
  }
  const platformsByVendor = new Map<VendorKey, readonly string[] | undefined>(
    parsed.success ? parsed.data.agents.map((agent) => [agent.vendor, agent.platforms] as const) : [],
  );

  const deviceById = new Map(devices.map((device) => [device.deviceId, device] as const));
  const orgIds = Array.from(new Set(devices.map((device) => device.orgId)));
  const vendors = Array.from(new Set(Array.from(vendorByCatalogId.values()).filter((v): v is VendorKey => v !== null)));
  const orgReadinessByVendor = new Map<VendorKey, Map<string, ReadinessResult>>();
  for (const vendor of vendors) {
    orgReadinessByVendor.set(vendor, await loadOrgInstallerReadiness(vendor, orgIds));
  }

  function readiness(deviceId: string, catalogId: string): { vendor: VendorKey | null; result: ReadinessResult } {
    const vendor = vendorByCatalogId.get(catalogId) ?? null;
    if (!vendor || linkUnreadable) return { vendor, result: { ok: false, reason: 'vendor_unavailable' } };
    const device = deviceById.get(deviceId);
    if (!device) return { vendor, result: { ok: false, reason: 'org_not_mapped' } };
    const platform = evaluatePlatformReadiness(vendor, device.osType, platformsByVendor.get(vendor));
    if (!platform.ok) return { vendor, result: platform };
    // A per-OS row (Control D Windows vs macOS) only ever targets its own OS.
    const rowPlatform = platformByCatalogId.get(catalogId);
    if (rowPlatform !== undefined && rowPlatform !== device.osType) {
      return { vendor, result: { ok: false, reason: 'platform_unsupported' } };
    }
    return {
      vendor,
      result: orgReadinessByVendor.get(vendor)?.get(device.orgId) ?? { ok: false, reason: 'org_not_mapped' },
    };
  }

  // Vendor → its rule catalog ids, in rule order (several for a per-OS vendor).
  const vendorRules: Array<{ vendor: VendorKey; catalogIds: string[] }> = [];
  for (const catalogId of catalogIds) {
    const vendor = vendorByCatalogId.get(catalogId) ?? null;
    if (!vendor) continue;
    const entry = vendorRules.find((rule) => rule.vendor === vendor);
    if (entry) entry.catalogIds.push(catalogId);
    else vendorRules.push({ vendor, catalogIds: [catalogId] });
  }

  /** The vendor's rule for this device: the one for the device's OS, else its first. */
  function deviceCatalogId(deviceId: string, ruleCatalogIds: string[]): string {
    const osType = deviceById.get(deviceId)?.osType;
    return ruleCatalogIds.find((id) => {
      const rowPlatform = platformByCatalogId.get(id);
      return rowPlatform === undefined || rowPlatform === osType;
    }) ?? ruleCatalogIds[0]!;
  }

  return {
    evaluateDevice(deviceId) {
      return vendorRules.map(({ vendor, catalogIds: ruleCatalogIds }) => {
        const catalogId = deviceCatalogId(deviceId, ruleCatalogIds);
        return { catalogId, vendor, result: readiness(deviceId, catalogId).result };
      });
    },
    vendors() {
      return vendorRules.map((rule) => rule.vendor);
    },
    filterViolations(deviceId, violations) {
      const kept: SoftwarePolicyViolation[] = [];
      const notApplicable: NotApplicableEntry[] = [];
      for (const violation of violations) {
        const catalogId = MANAGED_RULE_VIOLATION_TYPES.has(violation.type) ? violation.rule?.catalogId : undefined;
        if (!catalogId) {
          kept.push(violation);
          continue;
        }
        const { vendor, result } = readiness(deviceId, catalogId);
        if (result.ok) kept.push(violation);
        else notApplicable.push({ catalogId, vendor, reason: result.reason });
      }
      return { violations: kept, notApplicable };
    },
  };
}
