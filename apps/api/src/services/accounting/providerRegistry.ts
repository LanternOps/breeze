import { quickbooksProvider } from './quickbooksProvider';
import type { AccountingCapability, AccountingProvider, AccountingProviderId } from './types';

const providers: Partial<Record<AccountingProviderId, AccountingProvider>> = {
  quickbooks: quickbooksProvider,
};

/**
 * Brand names for ids with NO registered implementation yet (Xero until W02),
 * so a message about a refused or conflicting provider can still name it. A
 * registered provider's own `displayName` always wins.
 */
const FALLBACK_DISPLAY_NAMES: Record<AccountingProviderId, string> = {
  quickbooks: 'QuickBooks',
  xero: 'Xero',
};

/**
 * Jobs enqueued before Xero W01 carry no connectionId. They were QuickBooks
 * work by construction (no other provider existed), so they run ONLY when the
 * partner's active connection is this provider, and are dropped otherwise
 * (spec W01 "Jobs carry connectionId"; Codex quorum finding 4).
 */
export const LEGACY_UNTARGETED_JOB_PROVIDER: AccountingProviderId = 'quickbooks';

export function getAccountingProvider(id: AccountingProviderId): AccountingProvider {
  const provider = providers[id];
  if (!provider) {
    throw new Error(`Unknown accounting provider: ${id}`);
  }
  return provider;
}

export function findAccountingProvider(id: AccountingProviderId): AccountingProvider | null {
  return providers[id] ?? null;
}

export function providerSupports(id: AccountingProviderId, capability: AccountingCapability): boolean {
  return providers[id]?.capabilities[capability] === true;
}

export function accountingProviderDisplayName(id: AccountingProviderId): string {
  return providers[id]?.displayName ?? FALLBACK_DISPLAY_NAMES[id] ?? id;
}

export function listRegisteredAccountingProviders(): AccountingProvider[] {
  return Object.values(providers).filter((p): p is AccountingProvider => !!p);
}
