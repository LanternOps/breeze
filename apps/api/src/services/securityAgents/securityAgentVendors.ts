import type { SecurityAgentPlatform, SecurityAgentVendorKey } from '@breeze/shared/validators';
// Type-only: the registry stays free of the catalog module's DB imports. The
// runtime key → vendor table below is pinned equal to BUILTIN_TENANT_VAR_PACKAGES
// by securityAgentVendors.test.ts, and the Record type makes a new key a
// compile error here.
import type { BuiltinPackageKey, TenantVarVendorKey } from '../builtinDeploymentPackages';

/**
 * Code-level registry of the third-party security agents the `security_agents`
 * config-policy feature type can manage (#6960).
 *
 * It holds only what the EDR provider framework (`services/edrProviders`) does
 * not: DNS-filter vendors that key on a tenant variable, per-platform support,
 * and presence descriptors. Credentials are NOT here and never will be: they
 * stay in the integration/mapping tables (EDR vendors) or tenant variables (DNS
 * vendors) and are substituted at dispatch.
 *
 * `enableable` gates the link-write path: a link may list a vendor with
 * `enabled: true` only when the vendor's install path is wired end to end.
 * Huntress (W02), SentinelOne (W04) and the DNS vendors (W05) are wired. The
 * DNS vendors stay `enableable: false` until the #6958 owner lab gates L1–L5
 * are recorded (W05 shipped code-only); until then they are refused with
 * `vendor_not_enableable`.
 *
 * `enableable` is static. Per-partner prerequisites are enforced by the
 * generator at write time, not here: the partner's built-in catalog package
 * must exist (`security_agents_catalog_missing`) and, for a package whose
 * binary the partner uploads (SentinelOne's MSI, `requiresBinaryUpload`), it
 * must have a deployable version (`security_agents_binary_missing`).
 */

export type VendorKey = SecurityAgentVendorKey;
export type PlatformSupport = 'supported' | 'requires_mdm' | 'unsupported';

export interface SecurityAgentVendor {
  key: VendorKey;
  label: string;
  /** Built-in catalog package (EDR vendors) or catalog slug (DNS vendors) the generated policy installs. */
  catalogRef: string;
  /** Where the per-org install keys come from. */
  orgSource: 'edr_mapping' | 'tenant_var';
  /**
   * `software_catalog.integration_provider` of the built-in package (EDR
   * vendors), or null. This is how a generated rule's `catalogId` is mapped
   * back to its vendor: rule JSON cannot carry the vendor (the normalizer drops
   * unknown keys).
   */
  integrationProvider: 'huntress' | 'sentinelone' | null;
  /**
   * EDR vendors: the software-policy rule name the generated policy matches
   * against inventory (a case-insensitive glob over the Add/Remove Programs
   * display name). Its miss is what makes the device a `missing` install
   * candidate.
   *
   * null for tenant-variable vendors: their clients are zip installs with no
   * Add/Remove Programs entry, so no glob can ever match. Each per-OS rule is
   * named after its pinned built-in package (`Control D (Windows)`), which no
   * inventory entry carries, so presence comes only from the `service_running`
   * bridge (#6958 D4) and an unrelated product of the same vendor (the NextDNS
   * GUI app) can never be mistaken for the managed client.
   */
  detectionRuleName: string | null;
  /** Web path where the vendor's integration is connected (deep link when its catalog row is missing). */
  setupPath: string;
  /** Tenant variables that must be set on the device's org (tenant_var vendors only). */
  requiredVars?: readonly string[];
  platforms: Readonly<Record<SecurityAgentPlatform, PlatformSupport>>;
  /**
   * Presence descriptors: the `service_running` names the vendor's catalog
   * version declares, per OS (Windows SCM service name, macOS launchd label,
   * Linux systemd unit). Descriptive only: enforcement reads the catalog
   * version's detection rules (#6958 D4), and the registry test asserts the
   * two agree (the #6958 D5 contract). Empty means "no presence check",
   * never "absent". A descriptor is set only for an OS the vendor supports.
   */
  presence: Readonly<{ windowsService?: string; macLaunchdLabel?: string; linuxUnit?: string }>;
  enableable: boolean;
}

function freezeVendor(vendor: SecurityAgentVendor): SecurityAgentVendor {
  Object.freeze(vendor.platforms);
  Object.freeze(vendor.presence);
  if (vendor.requiredVars) Object.freeze(vendor.requiredVars);
  return Object.freeze(vendor);
}

const VENDORS: Readonly<Record<VendorKey, SecurityAgentVendor>> = Object.freeze({
  huntress: freezeVendor({
    key: 'huntress',
    label: 'Huntress',
    catalogRef: 'builtin:huntress',
    orgSource: 'edr_mapping',
    integrationProvider: 'huntress',
    detectionRuleName: 'Huntress Agent*',
    setupPath: '/integrations#huntress',
    platforms: { windows: 'supported', macos: 'requires_mdm', linux: 'unsupported' },
    presence: {},
    // W02: generator, readiness preflight, compliance/dispatch checks and the
    // authoring tab are wired.
    enableable: true,
  }),
  sentinelone: freezeVendor({
    key: 'sentinelone',
    label: 'SentinelOne',
    catalogRef: 'builtin:sentinelone',
    orgSource: 'edr_mapping',
    integrationProvider: 'sentinelone',
    detectionRuleName: 'Sentinel Agent*',
    setupPath: '/integrations#sentinelone',
    platforms: { windows: 'supported', macos: 'unsupported', linux: 'unsupported' },
    presence: {},
    // W04: readiness (site mapping + token), the s1_agents coverage source and
    // the partner-uploaded MSI gate are wired.
    enableable: true,
  }),
  controld: freezeVendor({
    key: 'controld',
    label: 'Control D',
    catalogRef: 'catalog:controld',
    orgSource: 'tenant_var',
    integrationProvider: null,
    detectionRuleName: null,
    setupPath: '/software',
    requiredVars: ['controld_provisioning_code'],
    // macOS stays unsupported while `controld_macos` is hidden (#6958 Gate B
    // decision 1: until lab gate L2 passes); its launchd label `ctrld` is added
    // to `presence` in the same change that supports it.
    platforms: { windows: 'supported', macos: 'unsupported', linux: 'unsupported' },
    presence: { windowsService: 'ctrld' },
    // W05: readiness (tenant variable), one rule per (vendor, OS) built-in
    // package, the service_running presence bridge and the authoring tab are
    // wired. Off until the #6958 lab gates L1–L5 are recorded.
    enableable: false,
  }),
  nextdns: freezeVendor({
    key: 'nextdns',
    label: 'NextDNS',
    catalogRef: 'catalog:nextdns',
    orgSource: 'tenant_var',
    integrationProvider: null,
    detectionRuleName: null,
    setupPath: '/software',
    requiredVars: ['nextdns_profile_id'],
    // NextDNS macOS is deferred (#6958: the CLI ships per-arch tarballs only).
    platforms: { windows: 'supported', macos: 'unsupported', linux: 'unsupported' },
    presence: { windowsService: 'nextdns' },
    // W05: wired as Control D. Off until the #6958 lab gates L1–L5 are recorded.
    enableable: false,
  }),
});

const VENDOR_LIST: readonly SecurityAgentVendor[] = Object.freeze(Object.values(VENDORS));

export function getVendor(key: VendorKey): SecurityAgentVendor {
  const vendor = Object.prototype.hasOwnProperty.call(VENDORS, key) ? VENDORS[key] : undefined;
  if (!vendor) throw new Error(`Unknown security agent vendor: ${String(key)}`);
  return vendor;
}

export function listVendors(): readonly SecurityAgentVendor[] {
  return VENDOR_LIST;
}

/** The vendor whose built-in catalog package carries this integration provider, or null. */
export function vendorForIntegrationProvider(provider: string | null | undefined): VendorKey | null {
  if (!provider) return null;
  return VENDOR_LIST.find((vendor) => vendor.integrationProvider === provider)?.key ?? null;
}

/**
 * Pinned built-in package key → (vendor, OS). Mirrors
 * `BUILTIN_TENANT_VAR_PACKAGES[key].{vendorKey, os}` (pinned by test) so this
 * registry needs no runtime import of the catalog module.
 */
const BUILTIN_PACKAGE_VENDOR: Readonly<Record<BuiltinPackageKey, { vendor: TenantVarVendorKey; platform: 'windows' | 'macos' }>> =
  Object.freeze({
    controld_windows: Object.freeze({ vendor: 'controld', platform: 'windows' }),
    controld_macos: Object.freeze({ vendor: 'controld', platform: 'macos' }),
    nextdns_windows: Object.freeze({ vendor: 'nextdns', platform: 'windows' }),
  });

/**
 * The vendor a catalog row installs, from the row's discriminators: an EDR
 * integration package (`integration_provider`, any OS the vendor supports) or
 * a pinned built-in package (`builtin_package_key`, exactly one OS). null when
 * the row is neither, which every caller treats as "not a vendor package"
 * (fail closed). A generated rule's `catalogId` is mapped back to its vendor
 * through this: rule JSON cannot carry the vendor.
 */
export function vendorForCatalogPackage(row: {
  integrationProvider?: string | null;
  builtinPackageKey?: string | null;
}): { vendor: VendorKey; platform: SecurityAgentPlatform | null } | null {
  const edr = vendorForIntegrationProvider(row.integrationProvider);
  if (edr) return { vendor: edr, platform: null };
  const key = row.builtinPackageKey;
  if (!key || !Object.prototype.hasOwnProperty.call(BUILTIN_PACKAGE_VENDOR, key)) return null;
  const entry = BUILTIN_PACKAGE_VENDOR[key as BuiltinPackageKey];
  return { vendor: entry.vendor, platform: entry.platform };
}
