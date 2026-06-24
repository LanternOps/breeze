import { quickbooksProvider } from './quickbooksProvider';
import type { AccountingProvider, AccountingProviderId } from './types';

const providers: Partial<Record<AccountingProviderId, AccountingProvider>> = {
  quickbooks: quickbooksProvider,
};

export function getAccountingProvider(id: AccountingProviderId): AccountingProvider {
  const provider = providers[id];
  if (!provider) {
    throw new Error(`Unknown accounting provider: ${id}`);
  }
  return provider;
}
