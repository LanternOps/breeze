import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import type { SecurityAgentsInlineSettings } from '@breeze/shared/validators';
import { db } from '../../db';
import { organizations, softwareCatalog, softwareVersions } from '../../db/schema';
import { getBuiltinPackage, installArgsCarryPlaceholders } from '../builtinDeploymentPackages';
import { getVendor, listVendors, type VendorKey } from './securityAgentVendors';

/**
 * Catalog reads for the security-agents managed-policy generator (#6960):
 * which built-in package each enabled vendor installs from, and whether a
 * package that needs a partner-uploaded installer has a deployable one.
 * Runs on the generator's executor (the link-write or sweep transaction).
 */

export type DbExecutor = typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0];

type OwnerConfigPolicy = { orgId: string | null; partnerId: string | null };

/**
 * Whether the vendor's built-in package has no derivable installer URL, so the
 * partner must upload the binary before anything can be installed. Read from
 * the package definition, not keyed on a vendor name.
 */
export function vendorRequiresUploadedBinary(vendor: VendorKey): boolean {
  const provider = getVendor(vendor).integrationProvider;
  return provider !== null && getBuiltinPackage(provider).requiresBinaryUpload;
}

/**
 * The partner's built-in catalog package per enabled vendor, and which of
 * those packages that need a partner-uploaded installer have a deployable one.
 * The owner's partner: the config policy's own for a partner-wide policy, its
 * org's for an org policy. Built-in packages are partner rows that every org of
 * the partner may read (software_catalog SELECT branch for integration
 * packages), and a partner-wide policy only reaches that partner's orgs, so
 * the owner's package is the one every reached device installs from.
 */
export async function readOwnerCatalog(
  executor: DbExecutor,
  configPolicy: OwnerConfigPolicy,
  settings: SecurityAgentsInlineSettings,
): Promise<{ catalogIdByVendor: Map<VendorKey, string>; uploadedBinaryVendors: Set<VendorKey> }> {
  const providers = settings.agents
    .filter((agent) => agent.enabled)
    .map((agent) => getVendor(agent.vendor).integrationProvider)
    .filter((provider): provider is 'huntress' | 'sentinelone' => provider !== null);
  const result = new Map<VendorKey, string>();
  const uploadedBinaryVendors = new Set<VendorKey>();
  const empty = { catalogIdByVendor: result, uploadedBinaryVendors };
  if (providers.length === 0) return empty;

  let partnerId = configPolicy.partnerId;
  if (configPolicy.orgId) {
    const [org] = await executor
      .select({ partnerId: organizations.partnerId })
      .from(organizations)
      .where(eq(organizations.id, configPolicy.orgId))
      .limit(1);
    partnerId = org?.partnerId ?? null;
  }
  if (!partnerId) return empty;

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

  const needsBinary = Array.from(result.entries()).filter(([vendor]) => vendorRequiresUploadedBinary(vendor));
  if (needsBinary.length > 0) {
    const deployable = await readDeployableVersionCatalogIds(executor, needsBinary.map(([, catalogId]) => catalogId));
    for (const [vendor, catalogId] of needsBinary) {
      const version = deployable.get(catalogId);
      if (version && versionIsDeployableFor(version, vendor)) uploadedBinaryVendors.add(vendor);
    }
  }
  return { catalogIdByVendor: result, uploadedBinaryVendors };
}

/** The fields of a latest version that decide whether it can be dispatched. */
type LatestVersion = { supportedOs: unknown; fileType: string | null; silentInstallArgs: string | null };

/**
 * Catalog ids (of those given) whose LATEST version carries an installer the
 * dispatch path can ship: an uploaded object (`s3_key`) or a stored URL. This
 * is the version `resolvePolicyInstallTarget` picks (built-in packages cannot
 * carry install methods), so "no such row" means every install would fail.
 */
async function readDeployableVersionCatalogIds(executor: DbExecutor, catalogIds: string[]): Promise<Map<string, LatestVersion>> {
  const rows = await executor
    .select({
      catalogId: softwareVersions.catalogId,
      supportedOs: softwareVersions.supportedOs,
      fileType: softwareVersions.fileType,
      silentInstallArgs: softwareVersions.silentInstallArgs,
    })
    .from(softwareVersions)
    .where(and(
      inArray(softwareVersions.catalogId, catalogIds),
      eq(softwareVersions.isLatest, true),
      sql`(NULLIF(btrim(${softwareVersions.s3Key}), '') IS NOT NULL OR NULLIF(btrim(${softwareVersions.downloadUrl}), '') IS NOT NULL)`,
    ));
  return new Map(rows.map((row) => [row.catalogId, row] as const));
}

/**
 * A latest version installs the vendor correctly only when:
 *  - its `supported_os` is empty (no restriction, same rule as the install
 *    target resolver's `versionSupportsOs`) or names a platform the vendor
 *    supports;
 *  - its file type is the package's (an MSI for SentinelOne: anything else is
 *    run the wrong way or is the wrong installer);
 *  - its install args carry the package template's per-org placeholders
 *    (`{s1_site_token}`), or the agent would install without its key.
 */
function versionIsDeployableFor(version: LatestVersion, vendor: VendorKey): boolean {
  const provider = getVendor(vendor).integrationProvider;
  if (!provider) return false;
  const pkg = getBuiltinPackage(provider);
  return versionCoversVendorPlatforms(version.supportedOs, vendor)
    && version.fileType?.toLowerCase() === pkg.fileType
    && installArgsCarryPlaceholders(provider, version.silentInstallArgs);
}

/** Empty or missing means no restriction; otherwise it must name a platform the vendor supports. */
function versionCoversVendorPlatforms(supportedOs: unknown, vendor: VendorKey): boolean {
  if (!Array.isArray(supportedOs) || supportedOs.length === 0) return true;
  const platforms = getVendor(vendor).platforms as Readonly<Record<string, string>>;
  return supportedOs.some((os) => typeof os === 'string' && platforms[os] === 'supported');
}
