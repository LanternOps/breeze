import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  accountingPath,
  ACCOUNTING_PROVIDER_IDS,
  ACCOUNTING_PROVIDER_NAMES,
  ACCOUNTING_PROVIDER_PRODUCT_NAMES,
  ACCOUNTING_PROVIDER_UI,
  ALL_CAPABILITIES,
  connectErrorKey,
  isAccountingProviderId,
  isAccountingProviderVisible,
  type AccountingProviderSummary,
} from './accountingProviders';

describe('accountingProviders', () => {
  it('builds provider-scoped API paths', () => {
    expect(accountingPath('quickbooks')).toBe('/accounting/quickbooks');
    expect(accountingPath('quickbooks', '/invoices/push-bulk')).toBe('/accounting/quickbooks/invoices/push-bulk');
    expect(accountingPath('xero', '/connect')).toBe('/accounting/xero/connect');
  });
  it('knows brand names and ids', () => {
    expect(ACCOUNTING_PROVIDER_NAMES.quickbooks).toBe('QuickBooks');
    expect(ACCOUNTING_PROVIDER_NAMES.xero).toBe('Xero');
    expect(isAccountingProviderId('xero')).toBe(true);
    expect(isAccountingProviderId('stripe')).toBe(false);
  });
  it('knows full product names, distinct from the brand name only for QuickBooks', () => {
    expect(ACCOUNTING_PROVIDER_PRODUCT_NAMES.quickbooks).toBe('QuickBooks Online');
    expect(ACCOUNTING_PROVIDER_PRODUCT_NAMES.xero).toBe('Xero');
  });
});

describe('accountingProviders — web/API provider-id contract', () => {
  // The web duplicates the API's provider tuple (it cannot import API code).
  // Read the API source and compare, so adding a provider on one side without
  // the other fails here instead of at a 404 on /accounting/<provider>/*.
  const apiTypesPath = join(
    dirname(fileURLToPath(import.meta.url)),
    '../../../api/src/services/accounting/types.ts',
  );

  it('matches ACCOUNTING_PROVIDER_IDS in apps/api/src/services/accounting/types.ts', () => {
    const src = readFileSync(apiTypesPath, 'utf8');
    const match = src.match(/export const ACCOUNTING_PROVIDER_IDS\s*=\s*\[([^\]]*)\]\s*as const/);
    if (!match) {
      throw new Error(`ACCOUNTING_PROVIDER_IDS = [...] as const not found in ${apiTypesPath}; update this contract test`);
    }
    const apiIds = [...match[1].matchAll(/['"]([^'"]+)['"]/g)].map((m) => m[1]);
    expect(apiIds.length).toBeGreaterThan(0);
    expect([...ACCOUNTING_PROVIDER_IDS]).toEqual(apiIds);
  });

  it('names every provider id exactly once', () => {
    const ids = [...ACCOUNTING_PROVIDER_IDS].sort();
    expect(Object.keys(ACCOUNTING_PROVIDER_NAMES).sort()).toEqual(ids);
    expect(Object.keys(ACCOUNTING_PROVIDER_PRODUCT_NAMES).sort()).toEqual(ids);
  });
});

describe('isAccountingProviderVisible', () => {
  const caps = { connect: true, mapping: true, customerImport: true, invoicePush: true, paymentPull: true, paymentPush: true };
  const summary = (id: 'quickbooks' | 'xero', configured: boolean): AccountingProviderSummary =>
    ({ id, displayName: ACCOUNTING_PROVIDER_NAMES[id], configured, capabilities: caps });

  it('shows a configured provider', () => {
    expect(isAccountingProviderVisible(summary('xero', true), null)).toBe(true);
  });
  it('shows an unconfigured provider that holds the active connection, so it can be disconnected', () => {
    expect(isAccountingProviderVisible(summary('quickbooks', false), { provider: 'quickbooks', status: 'connected' })).toBe(true);
  });
  it('hides an unconfigured provider that is not the active connection', () => {
    expect(isAccountingProviderVisible(summary('xero', false), null)).toBe(false);
    expect(isAccountingProviderVisible(summary('xero', false), { provider: 'quickbooks', status: 'connected' })).toBe(false);
  });
});

describe('ACCOUNTING_PROVIDER_UI', () => {
  it('QuickBooks keeps the pre-W02 unbranded, unconfirmed treatment', () => {
    expect(ACCOUNTING_PROVIDER_UI.quickbooks).toEqual({ brandedConnect: false, confirmDisconnect: false });
  });
  it('Xero follows its app-certification rules: branded connect + confirmed disconnect', () => {
    expect(ACCOUNTING_PROVIDER_UI.xero).toEqual({ brandedConnect: true, confirmDisconnect: true });
  });
});

describe('ALL_CAPABILITIES', () => {
  it('treats every capability as available, for an older API with no capabilities field', () => {
    expect(ALL_CAPABILITIES).toEqual({
      connect: true, mapping: true, customerImport: true, invoicePush: true, paymentPull: true, paymentPush: true,
    });
  });
});

// connectErrorKey returns a FULL i18n key (namespace-relative). QuickBooks
// copy stays byte-identical — provider_conflict and the unknown/null fallback
// both point at the two EXISTING keys the panel already used pre-W02, never a
// new duplicate `connectErrors.generic` / `connectErrors.providerConflict`.
describe('connectErrorKey', () => {
  it.each([
    ['tenant_held', 'accountingConnection.connectErrors.tenantHeld'],
    ['provider_conflict', 'accountingConnection.providerConflict'],
    ['auth_event_missing', 'accountingConnection.connectErrors.authEventMissing'],
    ['no_organisation', 'accountingConnection.connectErrors.noOrganisation'],
    ['tenant_lookup_failed', 'accountingConnection.connectErrors.tenantLookupFailed'],
    ['consent_denied', 'accountingConnection.connectErrors.consentDenied'],
  ])('%s -> %s', (code, key) => {
    expect(connectErrorKey(code)).toBe(key);
  });

  it.each(['exchange_failed', 'persist_failed', 'some_unknown_code'])(
    'falls back to the existing generic key for %s',
    (code) => {
      expect(connectErrorKey(code)).toBe('accountingConnection.providerConnectionFailedPleaseTryAgain');
    },
  );

  it('falls back to the existing generic key for null', () => {
    expect(connectErrorKey(null)).toBe('accountingConnection.providerConnectionFailedPleaseTryAgain');
  });
});
