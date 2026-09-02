import { describe, expectTypeOf, it } from 'vitest';
import type {
  AccountingCustomerPayload,
  AccountingEntityMapping,
  AccountingInvoiceLineMapping,
  AccountingInvoicePayload,
  AccountingItemPayload,
  AccountingProvider,
  AccountingVoidInvoicePayload,
  ChangeSet,
  ChangeSetPaymentLine,
  InvoicePushResult,
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
    expectTypeOf<ChangeSet['deletedInvoices']>().toEqualTypeOf<string[]>();
    expectTypeOf<ChangeSetPaymentLine['amountMinor']>().toEqualTypeOf<number>();
    expectTypeOf<ChangeSetPaymentLine['remotePaymentSyncToken']>().toEqualTypeOf<string | null>();
    expectTypeOf<ChangeSetPaymentLine['paymentMethodName']>().toEqualTypeOf<string | null>();
    expectTypeOf<ChangeSetPaymentLine['paymentRefNum']>().toEqualTypeOf<string | null>();
  });
});
