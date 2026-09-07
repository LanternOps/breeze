import { describe, expectTypeOf, it } from 'vitest';
import type {
  AccountingCustomerPayload,
  AccountingDeletePaymentPayload,
  AccountingEntityMapping,
  AccountingInvoiceLineMapping,
  AccountingInvoicePayload,
  AccountingItemPayload,
  AccountingPaymentPayload,
  AccountingProvider,
  AccountingVoidInvoicePayload,
  ChangeSet,
  ChangeSetPaymentLine,
  InvoicePushResult,
  PaymentDeleteResult,
  RealmSettings,
  RemoteRef,
} from './types';
import type { AccountingConnection } from './accountingConnectionService';

describe('AccountingProvider is fully typed (B8, multi-currency §11)', () => {
  it('pushInvoice takes a connection, a currency-bearing invoice payload and line mappings, and returns a widened InvoicePushResult', () => {
    expectTypeOf<Parameters<AccountingProvider['pushInvoice']>>().toEqualTypeOf<
      [AccountingConnection, AccountingInvoicePayload, readonly AccountingInvoiceLineMapping[]]
    >();
    expectTypeOf<ReturnType<AccountingProvider['pushInvoice']>>().toEqualTypeOf<Promise<InvoicePushResult>>();
    expectTypeOf<AccountingInvoicePayload['currencyCode']>().toEqualTypeOf<string>();
    expectTypeOf<AccountingInvoicePayload['mapping']>().toEqualTypeOf<AccountingEntityMapping | null>();
    expectTypeOf<InvoicePushResult['remoteTaxTotal']>().toEqualTypeOf<string | null>();
    expectTypeOf<InvoicePushResult['remoteTotal']>().toEqualTypeOf<string | null>();
  });

  it('upsertCustomer and upsertItem carry currency and a nullable remote mapping', () => {
    expectTypeOf<Parameters<AccountingProvider['upsertCustomer']>>().toEqualTypeOf<
      [AccountingConnection, AccountingCustomerPayload, AccountingEntityMapping | null]
    >();
    expectTypeOf<Parameters<AccountingProvider['upsertItem']>>().toEqualTypeOf<
      [AccountingConnection, AccountingItemPayload, AccountingEntityMapping | null]
    >();
    expectTypeOf<AccountingCustomerPayload['currencyCode']>().toEqualTypeOf<string>();
    expectTypeOf<AccountingItemPayload['currencyCode']>().toEqualTypeOf<string>();
    // upsertCustomer's create response surfaces CurrencyRef.value symmetrically
    // with listRemoteCustomers/mapQboCustomer (multi-currency §11).
    expectTypeOf<ReturnType<AccountingProvider['upsertCustomer']>>().toEqualTypeOf<Promise<RemoteRef>>();
    expectTypeOf<RemoteRef['currencyCode']>().toEqualTypeOf<string | undefined>();
  });

  it('voidInvoice takes a connection, a currency-bearing void payload and a required mapping', () => {
    expectTypeOf<Parameters<AccountingProvider['voidInvoice']>>().toEqualTypeOf<
      [AccountingConnection, AccountingVoidInvoicePayload, AccountingEntityMapping]
    >();
    expectTypeOf<AccountingVoidInvoicePayload['currencyCode']>().toEqualTypeOf<string>();
    expectTypeOf<AccountingVoidInvoicePayload['invoiceId']>().toEqualTypeOf<string>();
  });

  it('exposes a provider-neutral realm-settings fetch for the connect flow (REPLACES fetchHomeCurrency)', () => {
    expectTypeOf<Parameters<AccountingProvider['fetchRealmSettings']>>().toEqualTypeOf<[AccountingConnection]>();
    expectTypeOf<ReturnType<AccountingProvider['fetchRealmSettings']>>().toEqualTypeOf<Promise<RealmSettings>>();
    expectTypeOf<RealmSettings['homeCurrency']>().toEqualTypeOf<string | null>();
    expectTypeOf<RealmSettings['multiCurrencyEnabled']>().toEqualTypeOf<boolean | null>();
    expectTypeOf<AccountingProvider>().not.toHaveProperty('fetchHomeCurrency');
  });

  it('keeps all money as major-unit decimal strings (spec §12: no integer-cents storage)', () => {
    expectTypeOf<AccountingInvoicePayload['total']>().toEqualTypeOf<string>();
    expectTypeOf<AccountingItemPayload['unitPrice']>().toEqualTypeOf<string>();
  });

  it('reconcileChanges returns a ChangeSet carrying deletions and per-line QBO metadata', () => {
    expectTypeOf<Parameters<AccountingProvider['reconcileChanges']>>()
      .toEqualTypeOf<[AccountingConnection, Date | null]>();
    expectTypeOf<ReturnType<AccountingProvider['reconcileChanges']>>().toEqualTypeOf<Promise<ChangeSet>>();
    expectTypeOf<ChangeSet['deletedPayments']>().toEqualTypeOf<string[]>();
    // Alive-but-unallocated is its OWN list, not a deletion (finding C1): the
    // applier has to keep a Breeze-origin row's remote id for these.
    expectTypeOf<ChangeSet['unappliedPayments']>().toEqualTypeOf<string[]>();
    expectTypeOf<ChangeSet['deletedInvoices']>().toEqualTypeOf<string[]>();
    expectTypeOf<ChangeSetPaymentLine['amountMinor']>().toEqualTypeOf<number>();
    expectTypeOf<ChangeSetPaymentLine['remotePaymentSyncToken']>().toEqualTypeOf<string | null>();
    expectTypeOf<ChangeSetPaymentLine['paymentMethodName']>().toEqualTypeOf<string | null>();
    expectTypeOf<ChangeSetPaymentLine['paymentRefNum']>().toEqualTypeOf<string | null>();
  });
});

describe('payment push seam is fully typed (Phase D2)', () => {
  it('createPayment takes a connection and a currency-bearing payment payload, returning a RemoteRef', () => {
    expectTypeOf<Parameters<AccountingProvider['createPayment']>>()
      .toEqualTypeOf<[AccountingConnection, AccountingPaymentPayload]>();
    expectTypeOf<ReturnType<AccountingProvider['createPayment']>>().toEqualTypeOf<Promise<RemoteRef>>();
    // Money stays a major-unit decimal STRING through the seam (spec §12).
    expectTypeOf<AccountingPaymentPayload['amount']>().toEqualTypeOf<string>();
    expectTypeOf<AccountingPaymentPayload['currencyCode']>().toEqualTypeOf<string>();
    expectTypeOf<AccountingPaymentPayload['privateNote']>().toEqualTypeOf<string>();
    expectTypeOf<AccountingPaymentPayload['reference']>().toEqualTypeOf<string | null>();
  });

  it('deletePayment reports whether the Payment was there, so an already-deleted one is success', () => {
    expectTypeOf<Parameters<AccountingProvider['deletePayment']>>()
      .toEqualTypeOf<[AccountingConnection, AccountingDeletePaymentPayload]>();
    expectTypeOf<ReturnType<AccountingProvider['deletePayment']>>().toEqualTypeOf<Promise<PaymentDeleteResult>>();
    expectTypeOf<AccountingDeletePaymentPayload['syncToken']>().toEqualTypeOf<string | null>();
  });

  it('there is NO updatePayment — the push is create-only (spec decision 9)', () => {
    expectTypeOf<AccountingProvider>().not.toHaveProperty('updatePayment');
  });

  it('a CDC payment line carries the parsed Breeze marker', () => {
    expectTypeOf<ChangeSetPaymentLine['breezePaymentId']>().toEqualTypeOf<string | null>();
  });
});
