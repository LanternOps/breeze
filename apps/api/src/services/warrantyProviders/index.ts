import type { WarrantyProvider } from './types';
import { dellProvider } from './dellProvider';
import { lenovoProvider } from './lenovoProvider';

export type { WarrantyProvider, WarrantyLookupResult, WarrantyEntitlement } from './types';

// hpProvider is deliberately NOT registered: its unofficial support.hp.com
// endpoint now returns the site's HTML shell (verified 2026-09-09) and HP's real
// backend is captcha-gated, so enabling it only parks devices in `unknown` with
// a JSON parse error. HP coverage is coming from the agent instead. The module
// is kept (and unit-tested) until that lands.
const providers: WarrantyProvider[] = [dellProvider, lenovoProvider];

export function normalizeManufacturer(raw: string): string {
  const lower = raw.toLowerCase().trim();
  if (lower.includes('apple')) return 'apple';
  if (lower.includes('dell')) return 'dell';
  if (lower.includes('hp') || lower.includes('hewlett')) return 'hp';
  if (lower.includes('lenovo')) return 'lenovo';
  return lower.replace(/[^a-z0-9]/g, '');
}

export function getProviderForManufacturer(manufacturer: string): WarrantyProvider | null {
  for (const provider of providers) {
    if (provider.supports(manufacturer) && provider.isConfigured()) {
      return provider;
    }
  }
  return null;
}

export function getConfiguredProviders(): WarrantyProvider[] {
  return providers.filter((p) => p.isConfigured());
}
