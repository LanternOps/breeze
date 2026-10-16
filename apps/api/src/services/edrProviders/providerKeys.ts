/**
 * Every EDR vendor Breeze can talk to. `edr_connections.provider` is a plain
 * varchar, so this list — not a migration — is the single place a vendor is added.
 *
 * Kept free of imports so request-path validators (the incidents feed `source`
 * filter) can name the provider keys without pulling the adapters' import
 * closure. `registry.ts` re-exports it and maps each key to its adapter.
 */
export const EDR_PROVIDER_KEYS = ['bitdefender'] as const;

export type EdrProviderKey = (typeof EDR_PROVIDER_KEYS)[number];

export function isEdrProviderKey(key: string): key is EdrProviderKey {
  return (EDR_PROVIDER_KEYS as readonly string[]).includes(key);
}

/**
 * Vendor-neutral display labels for MSP-facing surfaces (feed, AI tools,
 * status). Breeze-generated, never vendor-supplied text. The customer portal
 * never shows these — it uses the generic "Managed endpoint protection".
 */
export const EDR_PROVIDER_LABELS: Record<EdrProviderKey, string> = {
  bitdefender: 'Bitdefender GravityZone',
};

export function edrProviderLabel(key: string): string {
  return isEdrProviderKey(key) ? EDR_PROVIDER_LABELS[key] : 'EDR provider';
}
