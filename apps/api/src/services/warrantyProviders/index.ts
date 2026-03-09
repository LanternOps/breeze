import type { WarrantyProvider } from './types';
import { dellProvider } from './dellProvider';
import { hpProvider } from './hpProvider';
import { lenovoProvider } from './lenovoProvider';

export type { WarrantyProvider, WarrantyLookupResult, WarrantyEntitlement } from './types';

const providers: WarrantyProvider[] = [dellProvider, hpProvider, lenovoProvider];

export function normalizeManufacturer(raw: string): string {
  const lower = raw.toLowerCase().trim();
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
