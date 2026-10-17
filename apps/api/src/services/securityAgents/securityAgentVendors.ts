import type { SecurityAgentPlatform, SecurityAgentVendorKey } from '@breeze/shared/validators';

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
 * `enabled: true` only when the vendor's install path is wired end to end. In
 * the first wave no vendor is, so every vendor is listed but none can be
 * switched on (`vendor_not_enableable`).
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
  /** Tenant variables that must be set on the device's org (tenant_var vendors only). */
  requiredVars?: readonly string[];
  platforms: Readonly<Record<SecurityAgentPlatform, PlatformSupport>>;
  /**
   * Presence descriptors for the `service_running` detection rule. Populated in
   * the wave that wires presence, once the rule type exists (#6958); empty
   * means "no presence check yet", never "absent".
   */
  presence: Readonly<{ windowsService?: string; macProcess?: string; linuxUnit?: string }>;
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
    platforms: { windows: 'supported', macos: 'requires_mdm', linux: 'unsupported' },
    presence: {},
    enableable: false,
  }),
  sentinelone: freezeVendor({
    key: 'sentinelone',
    label: 'SentinelOne',
    catalogRef: 'builtin:sentinelone',
    orgSource: 'edr_mapping',
    platforms: { windows: 'supported', macos: 'unsupported', linux: 'unsupported' },
    presence: {},
    enableable: false,
  }),
  controld: freezeVendor({
    key: 'controld',
    label: 'Control D',
    catalogRef: 'catalog:controld',
    orgSource: 'tenant_var',
    requiredVars: ['controld_provisioning_code'],
    platforms: { windows: 'supported', macos: 'unsupported', linux: 'unsupported' },
    presence: {},
    enableable: false,
  }),
  nextdns: freezeVendor({
    key: 'nextdns',
    label: 'NextDNS',
    catalogRef: 'catalog:nextdns',
    orgSource: 'tenant_var',
    requiredVars: ['nextdns_profile_id'],
    platforms: { windows: 'supported', macos: 'unsupported', linux: 'unsupported' },
    presence: {},
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
