import { quickbooksProvider } from './quickbooksProvider';
import { xeroProvider } from './xeroProvider';
import type { AccountingCapability, AccountingProvider, AccountingProviderId } from './types';

const providers: Partial<Record<AccountingProviderId, AccountingProvider>> = {
  quickbooks: quickbooksProvider,
  // Xero W02: connect only. W03–W05 flip capabilities as they land.
  xero: xeroProvider,
};

/**
 * Brand names for ids with no registered implementation, so a message about a
 * refused or conflicting provider can still name it. Every current id is
 * registered (Xero since W02); the table stays for any future id. A registered
 * provider's own `displayName` always wins.
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
