import { bitdefenderAdapter } from './bitdefender/adapter';
import type { EdrProviderAdapter } from './types';

/**
 * Every EDR vendor Breeze can talk to. `edr_connections.provider` is a plain
 * varchar, so this list — not a migration — is the single place a vendor is added.
 */
export const EDR_PROVIDER_KEYS = ['bitdefender'] as const;

export type EdrProviderKey = (typeof EDR_PROVIDER_KEYS)[number];

const ADAPTERS: Record<EdrProviderKey, EdrProviderAdapter> = {
  bitdefender: bitdefenderAdapter,
};

export function isEdrProviderKey(key: string): key is EdrProviderKey {
  return (EDR_PROVIDER_KEYS as readonly string[]).includes(key);
}

/** Adapter for `key`, or a loud throw. Membership first so `__proto__`/`constructor` never resolve. */
export function getEdrProvider(key: string): EdrProviderAdapter {
  if (!isEdrProviderKey(key)) {
    throw new Error(`Unknown EDR provider "${key}" (registered: ${EDR_PROVIDER_KEYS.join(', ')})`);
  }
  return ADAPTERS[key];
}

export function listEdrProviders(): EdrProviderAdapter[] {
  return EDR_PROVIDER_KEYS.map((key) => ADAPTERS[key]);
}
