import { useEffect, useState } from 'react';
import { fetchWithAuth } from '../stores/auth';

/**
 * The accounting providers the web knows how to drive (Xero W01). Mirrors
 * `ACCOUNTING_PROVIDER_IDS` in apps/api/src/services/accounting/types.ts — the
 * API's `/accounting/:provider/*` routes accept exactly these ids.
 */
export const ACCOUNTING_PROVIDER_IDS = ['quickbooks', 'xero'] as const;
export type AccountingProviderId = (typeof ACCOUNTING_PROVIDER_IDS)[number];
export type AccountingCapability = 'connect' | 'mapping' | 'customerImport' | 'invoicePush' | 'paymentPull' | 'paymentPush';

/** Brand names — never translated. */
export const ACCOUNTING_PROVIDER_NAMES: Record<AccountingProviderId, string> = { quickbooks: 'QuickBooks', xero: 'Xero' };

export function isAccountingProviderId(v: string): v is AccountingProviderId {
  return (ACCOUNTING_PROVIDER_IDS as readonly string[]).includes(v);
}

/** `/accounting/<provider><suffix>` — the provider-scoped API path. */
export function accountingPath(provider: AccountingProviderId, suffix = ''): string {
  return `/accounting/${provider}${suffix}`;
}

export interface AccountingProviderSummary {
  id: AccountingProviderId;
  displayName: string;
  configured: boolean;
  capabilities: Record<AccountingCapability, boolean>;
}
export interface AccountingProvidersResponse {
  data: AccountingProviderSummary[];
  activeConnection: { provider: AccountingProviderId; status: string } | null;
}

/** GET /accounting/providers. `null` on 401/403, any other non-2xx, a network
 *  failure, or a body that is not the expected shape. */
export async function fetchAccountingProviders(): Promise<AccountingProvidersResponse | null> {
  try {
    const res = await fetchWithAuth('/accounting/providers');
    if (!res.ok) return null;
    const body = (await res.json()) as Partial<AccountingProvidersResponse> | null;
    if (!body || !Array.isArray(body.data)) return null;
    return { data: body.data, activeConnection: body.activeConnection ?? null };
  } catch {
    return null;
  }
}

/** The provider an invoice push would go to: the active connection, iff it can
 *  push invoices. `null` while loading, when disabled, with no connection, or
 *  when the connected provider lacks `invoicePush` — callers hide the push
 *  control on `null` (a push with nowhere to go used to enqueue jobs the
 *  worker then dropped). */
export function useActivePushProvider(enabled: boolean): AccountingProviderId | null {
  const [provider, setProvider] = useState<AccountingProviderId | null>(null);
  useEffect(() => {
    if (!enabled) {
      setProvider(null);
      return;
    }
    let live = true;
    void fetchAccountingProviders().then((r) => {
      if (!live) return;
      const active = r?.activeConnection ?? null;
      const summary = r && active ? r.data.find((p) => p.id === active.provider) : undefined;
      setProvider(summary?.capabilities?.invoicePush ? summary.id : null);
    });
    return () => { live = false; };
  }, [enabled]);
  return provider;
}
