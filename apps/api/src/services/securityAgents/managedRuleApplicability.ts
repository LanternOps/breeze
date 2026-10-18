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
import { vendorForIntegrationProvider, type VendorKey } from './securityAgentVendors';

/**
 * Which rules of a GENERATED (security agents) software policy apply to which
 * devices, for one compliance pass (#6960).
 *
 * A rule's vendor is derived from its catalogId (the catalog row's
 * integration_provider). Its applicability on a device is the installer
 * readiness preflight: platform first (registry support, then the link's own
 * platform list), then the DEVICE's org (mapping, partner integration, keys).
 *
 * Fail-closed: a rule whose catalog row is not a known vendor package, or a
 * device the pass did not describe, is not applicable. A managed policy only
 * ever installs through these checks.
 *
 * Loaded once per pass: two queries plus one batched readiness read per vendor,
 * whatever the device count. Runs in the compliance worker's system context.
 */

export type NotApplicableEntry = { catalogId: string; vendor: VendorKey | null; reason: ReadinessReason };

export interface ManagedRuleApplicability {
  filterViolations(
    deviceId: string,
    violations: SoftwarePolicyViolation[],
  ): { violations: SoftwarePolicyViolation[]; notApplicable: NotApplicableEntry[] };
}

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
  if (catalogIds.length > 0) {
    const rows = await db
      .select({ id: softwareCatalog.id, integrationProvider: softwareCatalog.integrationProvider })
      .from(softwareCatalog)
      .where(inArray(softwareCatalog.id, catalogIds));
    for (const row of rows) vendorByCatalogId.set(row.id, vendorForIntegrationProvider(row.integrationProvider));
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
    return {
      vendor,
      result: orgReadinessByVendor.get(vendor)?.get(device.orgId) ?? { ok: false, reason: 'org_not_mapped' },
    };
  }

  return {
    filterViolations(deviceId, violations) {
      const kept: SoftwarePolicyViolation[] = [];
      const notApplicable: NotApplicableEntry[] = [];
      for (const violation of violations) {
        const catalogId = violation.type === 'missing' ? violation.rule?.catalogId : undefined;
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
