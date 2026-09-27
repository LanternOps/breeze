/**
 * Provider admission for every /accounting/:provider route (Xero W01). The URL
 * enum admits every KNOWN provider id; this gate admits only a REGISTERED
 * provider that declares the route's capability and is configured on this
 * instance. Called at the top of each handler (not as middleware — the import
 * route's chain is at Hono's type-inference limit).
 */
import type { Context } from 'hono';
import { db } from '../../db';
import {
  accountingProviderDisplayName, findAccountingProvider, listRegisteredAccountingProviders, providerSupports,
} from '../../services/accounting/providerRegistry';
import { resolveActiveConnectionRef } from '../../services/accounting/accountingConnectionService';
import type { AccountingCapability, AccountingProviderId } from '../../services/accounting/types';

/** Replaces the route's old validateProviderConfig. null = proceed; otherwise the response to return. */
export function providerGateResponse(c: Context, provider: AccountingProviderId, capability: AccountingCapability): Response | null {
  const impl = findAccountingProvider(provider);
  if (!impl) {
    return c.json({ error: `${accountingProviderDisplayName(provider)} is not available on this instance yet`, code: 'capability_unavailable' }, 409);
  }
  if (!providerSupports(provider, capability)) {
    return c.json({ error: `${impl.displayName} does not support this yet`, code: 'capability_unavailable' }, 409);
  }
  const configError = impl.configError();
  if (configError) return c.json({ error: configError, code: 'provider_not_configured' }, 400);
  return null;
}

/**
 * GET /accounting/providers. Reads the partner's connection through the
 * NON-decrypting ref on the request's ambient context (the same context the
 * GET /:provider status handler reads under), so a rotated encryption key can
 * never 500 the listing.
 */
export async function listProvidersHandler(c: Context, partnerId: string): Promise<Response> {
  const active = await resolveActiveConnectionRef(db, partnerId);
  return c.json({
    data: listRegisteredAccountingProviders().map((p) => ({
      id: p.provider, displayName: p.displayName, configured: p.configError() === null, capabilities: p.capabilities,
    })),
    activeConnection: active ? { provider: active.provider, status: active.status } : null,
  });
}
