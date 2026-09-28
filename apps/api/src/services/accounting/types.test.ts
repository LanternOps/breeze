import { describe, expectTypeOf, it } from 'vitest';
import type {
  AccountingCapabilities,
  AccountingCustomerPayload,
  AccountingDeletePaymentPayload,
  AccountingEntityMapping,
  AccountingInvoiceLineMapping,
  AccountingInvoicePayload,
  AccountingInvoicePreflightRefusal,
  AccountingItemPayload,
  AccountingPaymentPayload,
  AccountingPaymentMethod,
  AccountingProvider,
  AccountingVoidInvoicePayload,
  ChangeSet,
  ChangeSetPaymentLine,
  InvoicePushResult,
  InvoiceVoidResult,
  PaymentDeleteResult,
  ProviderSettingsOptions,
  ProviderTenantSelection,
  RateLimitSpec,
  RealmSettings,
  RemoteCustomer,
  RemoteItem,
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
    expectTypeOf<ChangeSetPaymentLine['remotePaymentVersion']>().toEqualTypeOf<string | null>();
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
    expectTypeOf<AccountingPaymentPayload['marker']>().toEqualTypeOf<string>();
    expectTypeOf<AccountingPaymentPayload['reference']>().toEqualTypeOf<string | null>();
  });

  it('deletePayment reports whether the Payment was there, so an already-deleted one is success', () => {
    expectTypeOf<Parameters<AccountingProvider['deletePayment']>>()
      .toEqualTypeOf<[AccountingConnection, AccountingDeletePaymentPayload]>();
    expectTypeOf<ReturnType<AccountingProvider['deletePayment']>>().toEqualTypeOf<Promise<PaymentDeleteResult>>();
    expectTypeOf<AccountingDeletePaymentPayload['remoteVersion']>().toEqualTypeOf<string | null>();
  });

  it('there is NO updatePayment — the push is create-only (spec decision 9)', () => {
    expectTypeOf<AccountingProvider>().not.toHaveProperty('updatePayment');
  });

  it('a CDC payment line carries the parsed Breeze marker', () => {
    expectTypeOf<ChangeSetPaymentLine['breezePaymentId']>().toEqualTypeOf<string | null>();
  });
});

describe('provider capabilities and identity (Xero W01)', () => {
  it('declares the six capabilities and a display name', () => {
    expectTypeOf<AccountingProvider['capabilities']>().toEqualTypeOf<AccountingCapabilities>();
    expectTypeOf<keyof AccountingCapabilities>().toEqualTypeOf<
      'connect' | 'mapping' | 'customerImport' | 'invoicePush' | 'paymentPull' | 'paymentPush'
    >();
    expectTypeOf<AccountingProvider['displayName']>().toEqualTypeOf<string>();
  });
});

describe('provider mechanics (Xero W01)', () => {
  it('results carry an opaque remote version, never a provider-named token', () => {
    expectTypeOf<RemoteRef['remoteVersion']>().toEqualTypeOf<string | undefined>();
    expectTypeOf<InvoiceVoidResult['remoteVersion']>().toEqualTypeOf<string | null>();
    expectTypeOf<ChangeSetPaymentLine['remotePaymentVersion']>().toEqualTypeOf<string | null>();
    expectTypeOf<RemoteRef>().not.toHaveProperty('syncToken');
    expectTypeOf<ChangeSetPaymentLine>().not.toHaveProperty('remotePaymentSyncToken');
  });
  it('payments carry a neutral marker and a neutral method', () => {
    expectTypeOf<AccountingPaymentPayload['marker']>().toEqualTypeOf<string>();
    expectTypeOf<AccountingPaymentPayload>().not.toHaveProperty('privateNote');
    expectTypeOf<ChangeSetPaymentLine['method']>().toEqualTypeOf<AccountingPaymentMethod>();
  });
  it('providers declare limits, a payment marker codec, environment and config checks', () => {
    expectTypeOf<AccountingProvider['limits']['paymentRefMax']>().toEqualTypeOf<number>();
    expectTypeOf<AccountingProvider['limits']['rate']>().toEqualTypeOf<RateLimitSpec>();
    expectTypeOf<Parameters<AccountingProvider['paymentMarker']['embed']>>().toEqualTypeOf<[string | null, string]>();
    expectTypeOf<ReturnType<AccountingProvider['configError']>>().toEqualTypeOf<string | null>();
  });
});

describe('tenant selection and settings options (Xero W02)', () => {
  it('declares the optional tenant-selection seam', () => {
    expectTypeOf<AccountingProvider['tenantSelection']>().toEqualTypeOf<ProviderTenantSelection | undefined>();
    expectTypeOf<Parameters<ProviderTenantSelection['listGrantTenants']>>().toEqualTypeOf<[string, string]>();
    expectTypeOf<ReturnType<ProviderTenantSelection['authEventIdOf']>>().toEqualTypeOf<string | null>();
  });
  it('declares optional settings options and release', () => {
    expectTypeOf<AccountingProvider['listSettingsOptions']>().toEqualTypeOf<((conn: AccountingConnection) => Promise<ProviderSettingsOptions>) | undefined>();
    expectTypeOf<AccountingProvider['releaseConnection']>().toEqualTypeOf<((conn: AccountingConnection) => Promise<void>) | undefined>();
    expectTypeOf<ProviderSettingsOptions['organisation']['isDemoCompany']>().toEqualTypeOf<boolean | null>();
  });
});

describe('single-record lookups and supplierOnly (Xero W03)', () => {
  it('declares the optional lookups', () => {
    expectTypeOf<AccountingProvider['getRemoteCustomer']>()
      .toEqualTypeOf<((conn: AccountingConnection, id: string) => Promise<RemoteCustomer | null>) | undefined>();
    expectTypeOf<AccountingProvider['getRemoteItem']>()
      .toEqualTypeOf<((conn: AccountingConnection, id: string) => Promise<RemoteItem | null>) | undefined>();
  });
  it('declares supplierOnly as an optional boolean', () => {
    expectTypeOf<RemoteCustomer['supplierOnly']>().toEqualTypeOf<boolean | undefined>();
  });
});

describe('invoice push preflight (Xero W04)', () => {
  it('declares an optional synchronous preflight', () => {
    expectTypeOf<AccountingProvider['invoicePushPreflight']>().toEqualTypeOf<
      | ((
        conn: AccountingConnection,
        invoice: Pick<AccountingInvoicePayload, 'currencyCode' | 'taxTotal' | 'lines'>,
      ) => AccountingInvoicePreflightRefusal | null)
      | undefined
    >();
  });
  it('declares an optional lookup of a pushed invoice by its Breeze id (refinement 22)', () => {
    expectTypeOf<AccountingProvider['findRemoteInvoice']>().toEqualTypeOf<
      ((conn: AccountingConnection, invoiceId: string) => Promise<{ id: string; remoteVersion?: string } | null>) | undefined
    >();
  });
  it('a refusal carries a reason and an operator message', () => {
    expectTypeOf<AccountingInvoicePreflightRefusal>().toEqualTypeOf<{ reason: 'settings' | 'totals'; message: string }>();
  });
});
