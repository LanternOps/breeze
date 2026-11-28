/**
 * Every EDR vendor Breeze can talk to. `edr_connections.provider` is a plain
 * varchar, so this list — not a migration — is the single place a vendor is added.
 *
 * Kept free of imports so request-path validators (the incidents feed `source`
 * filter) can name the provider keys without pulling the adapters' import
 * closure. `registry.ts` re-exports it and maps each key to its adapter.
 */
export const EDR_PROVIDER_KEYS = ['bitdefender', 'emsisoft'] as const;

export type EdrProviderKey = (typeof EDR_PROVIDER_KEYS)[number];

export function isEdrProviderKey(key: string): key is EdrProviderKey {
  return (EDR_PROVIDER_KEYS as readonly string[]).includes(key);
}

/**
 * The providers whose adapter can supply an installer. `registry.test.ts` pins
 * this list to the adapters declaring `capabilities.installer !== 'none'`.
 */
export const EDR_INSTALLER_PROVIDER_KEYS = ['bitdefender'] as const;

export type EdrInstallerProviderKey = (typeof EDR_INSTALLER_PROVIDER_KEYS)[number];

export function isEdrInstallerProviderKey(key: string): key is EdrInstallerProviderKey {
  return (EDR_INSTALLER_PROVIDER_KEYS as readonly string[]).includes(key);
}

/**
 * The providers whose `health` / `online` are detail-owned (`capabilities.detailOwnedFields`): the
 * inventory list never refreshes them, only a per-endpoint details read does, at most
 * DETAIL_ENRICH_PER_RUN endpoints per company per run. Their stored value is as of
 * `vendor_detail_synced_at`, so `endpointFreshness.ts` counts it only within a bound (#12825).
 * Import-free like the lists above so report and portal code need not load the adapters;
 * `registry.test.ts` pins it to the adapters' declarations.
 */
export const EDR_DETAIL_OWNED_STATE_PROVIDER_KEYS: readonly EdrProviderKey[] = ['bitdefender', 'emsisoft'];

/**
 * Vendor-neutral display labels for MSP-facing surfaces (feed, AI tools,
 * status). Breeze-generated, never vendor-supplied text. The customer portal
 * never shows these — it uses the generic "Managed endpoint protection".
 */
export const EDR_PROVIDER_LABELS: Record<EdrProviderKey, string> = {
  bitdefender: 'Bitdefender GravityZone',
  emsisoft: 'Emsisoft',
};

export function edrProviderLabel(key: string): string {
  return isEdrProviderKey(key) ? EDR_PROVIDER_LABELS[key] : 'EDR provider';
}
