// clientPaymentAuthority.ts
import { AsyncLocalStorage } from 'node:async_hooks';
export interface ClientPaymentAuthority {
  tokenId: string; invoiceId: string; generation: number; methodId: string;
  principal: string; fee: string; currency: string;
  capture?: { setupAttemptId: string; stripePaymentMethodId: string; setupIntentId: string; stripeAccountId: string; stripeCustomerId: string };
}
const authority = new AsyncLocalStorage<ClientPaymentAuthority>();
export function withClientPaymentAuthority<T>(value: ClientPaymentAuthority, run: () => Promise<T>): Promise<T> {
  return authority.run(value, run);
}
export function getClientPaymentAuthority(): ClientPaymentAuthority | undefined { return authority.getStore(); }

import type { BankPaymentConsent } from '@breeze/shared';
export type BankSetupTerms = Omit<BankPaymentConsent, 'collection'>;
const setupAuthority = new AsyncLocalStorage<BankSetupTerms>();
export function withBankSetupTerms<T>(terms: BankSetupTerms, run: () => Promise<T>): Promise<T> { return setupAuthority.run(terms, run); }
export function getBankSetupTerms(): BankSetupTerms | undefined { return setupAuthority.getStore(); }
