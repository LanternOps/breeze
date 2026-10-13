import { bitdefenderAdapter } from './bitdefender/adapter';
import type { EdrProviderAdapter } from './types';
import { EDR_PROVIDER_KEYS, isEdrProviderKey, type EdrProviderKey } from './providerKeys';

// The key list lives in the import-free ./providerKeys so validators can use it.
export { EDR_PROVIDER_KEYS, isEdrProviderKey, type EdrProviderKey };

const ADAPTERS: Record<EdrProviderKey, EdrProviderAdapter> = {
  bitdefender: bitdefenderAdapter,
};

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
