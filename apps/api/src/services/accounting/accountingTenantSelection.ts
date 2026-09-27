/**
 * Xero W02 tenant selection: the picker, cancel, the 1-hour reaper, and the
 * removal of unchosen links. Rules (spec W02 + quorum finding 3):
 *  - Only links from THIS flow's auth event are ever listed (listGrantTenants).
 *  - A link is removed only if no accounting_connections row holds its tenant
 *    or its connection id, checked in SYSTEM scope.
 *  - Never token revocation.
 *  - A pending row is never refreshed: the pick must happen inside the ORIGINAL
 *    access token's life, which is also what lets us decode its auth event.
 * Every entry point makes outbound HTTP, so none may hold a DB context.
 */
import { db, withSystemDbAccessContext } from '../../db';
import { captureException } from '../sentry';
import { assertNoAmbientDbContext, type DbContextRunner } from './dbContextGuard';
import { findAccountingProvider, getAccountingProvider } from './providerRegistry';
import {
  deletePendingTenantRow, listHeldTenantKeys, listStalePendingTenantConnections, loadPendingTenantRow, pendingGrantFingerprint,
} from './accountingTenantSelectionStore';
import type { AccountingConnection } from './accountingConnectionService';
import type { AccountingProviderId, ProviderTenant, ProviderTenantSelection } from './types';

export const PENDING_TENANT_TTL_MS = 60 * 60 * 1000;
export const TENANT_PICK_TOKEN_MARGIN_MS = 60_000;

export type TenantSelectionErrorCode =
  | 'no_pending_selection' | 'tenant_selection_expired' | 'tenant_not_in_grant' | 'selection_unsupported' | 'auth_event_missing'
  | 'grant_superseded';

export class AccountingTenantSelectionError extends Error {
  constructor(readonly code: TenantSelectionErrorCode, readonly status: 400 | 404 | 409, message: string) {
    super(message);
    this.name = 'AccountingTenantSelectionError';
  }
}

export interface PendingGrant {
  row: AccountingConnection;
  selection: ProviderTenantSelection;
  accessToken: string;
  authEventId: string;
  tenants: ProviderTenant[];
  /** Captured with the credentials, BEFORE any HTTP; the claim refuses if the row's grant changed since. */
  grantFingerprint: string;
}

function selectionFor(provider: AccountingProviderId): ProviderTenantSelection {
  const selection = getAccountingProvider(provider).tenantSelection;
  if (!selection) {
    throw new AccountingTenantSelectionError('selection_unsupported', 409, 'This accounting provider does not use organisation selection');
  }
  return selection;
}

export function connectableTenants(grant: Pick<PendingGrant, 'selection' | 'tenants'>): ProviderTenant[] {
  return grant.tenants.filter((t) => t.tenantType === grant.selection.connectableTenantType);
}

export async function loadPendingGrant(partnerId: string, provider: AccountingProviderId, runInDbContext: DbContextRunner): Promise<PendingGrant> {
  assertNoAmbientDbContext('loadPendingGrant');
  const label = getAccountingProvider(provider).displayName;
  const selection = selectionFor(provider);
  const row = await runInDbContext(() => loadPendingTenantRow(db, partnerId, provider));
  if (!row) throw new AccountingTenantSelectionError('no_pending_selection', 404, `There is no ${label} connection waiting for an organisation`);
  const expiresAt = row.accessTokenExpiresAt?.getTime() ?? 0;
  if (!row.accessToken || !row.refreshToken || expiresAt <= Date.now() + TENANT_PICK_TOKEN_MARGIN_MS) {
    throw new AccountingTenantSelectionError('tenant_selection_expired', 409, `This ${label} sign-in has expired. Cancel and connect again.`);
  }
  // Grant identity is taken from the SAME read as the credentials, before the HTTP lookup below.
  const grantFingerprint = pendingGrantFingerprint(row.refreshToken);
  const authEventId = selection.authEventIdOf(row.accessToken);
  if (!authEventId) {
    throw new AccountingTenantSelectionError('auth_event_missing', 409, `${label} did not identify this sign-in. Cancel and connect again.`);
  }
  const tenants = await selection.listGrantTenants(row.accessToken, authEventId);
  return { row, selection, accessToken: row.accessToken, authEventId, tenants, grantFingerprint };
}

export async function releaseUnchosenTenants(input: {
  provider: AccountingProviderId; accessToken: string; tenants: readonly ProviderTenant[];
  keepConnectionRef: string | null; context: 'callback' | 'select' | 'cancel' | 'reaped';
}): Promise<{ removed: number; kept: number; failed: number }> {
  assertNoAmbientDbContext('releaseUnchosenTenants');
  const selection = findAccountingProvider(input.provider)?.tenantSelection;
  const candidates = input.tenants.filter((t) => t.connectionRef !== input.keepConnectionRef);
  if (!selection || candidates.length === 0) return { removed: 0, kept: 0, failed: 0 };

  let held: { heldTenantIds: Set<string>; heldConnectionRefs: Set<string> };
  try {
    held = await withSystemDbAccessContext(
      () => listHeldTenantKeys(db, input.provider, candidates),
      'accountingTenantSelection.heldCheck',
    );
  } catch (err) {
    // Fail CLOSED: without the held check we cannot prove a link is ours to remove.
    captureException(err instanceof Error ? err : new Error(String(err)), undefined, { service: 'accountingTenantSelection' });
    console.warn('[accountingTenantSelection] held check failed; removing no links', { provider: input.provider, context: input.context });
    return { removed: 0, kept: candidates.length, failed: 0 };
  }

  let removed = 0; let kept = 0; let failed = 0;
  for (const t of candidates) {
    if (held.heldTenantIds.has(t.tenantId) || held.heldConnectionRefs.has(t.connectionRef)) { kept++; continue; }
    try {
      await selection.removeTenantConnection(input.accessToken, t.connectionRef);
      removed++;
    } catch (err) {
      failed++;
      console.warn('[accountingTenantSelection] unchosen link removal failed (best-effort)', {
        provider: input.provider, context: input.context, error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  console.info('[accountingTenantSelection] unchosen links released', { provider: input.provider, context: input.context, removed, kept, failed });
  return { removed, kept, failed };
}

export async function discardPendingTenantSelection(input: {
  partnerId: string; provider: AccountingProviderId; connectionId?: string; olderThan?: Date;
  reason: 'cancel' | 'reaped'; runInDbContext: DbContextRunner;
}): Promise<{ discarded: boolean }> {
  assertNoAmbientDbContext('discardPendingTenantSelection');
  // Row FIRST: a select racing this cancel/reap then finds nothing to claim,
  // rather than claiming a tenant whose link we are about to remove.
  const deleted = await input.runInDbContext(() => deletePendingTenantRow(db, {
    partnerId: input.partnerId, provider: input.provider, connectionId: input.connectionId, olderThan: input.olderThan,
  }));
  if (!deleted) return { discarded: false };

  const impl = findAccountingProvider(input.provider);
  const selection = impl?.tenantSelection;
  if (!impl || !selection || !deleted.accessToken) return { discarded: true };
  // The ORIGINAL token: pending rows are never refreshed, so its claim is this flow's.
  const authEventId = selection.authEventIdOf(deleted.accessToken);
  if (!authEventId) return { discarded: true };

  try {
    let accessToken = deleted.accessToken;
    const expiresAt = deleted.accessTokenExpiresAt?.getTime() ?? 0;
    if (expiresAt <= Date.now() + TENANT_PICK_TOKEN_MARGIN_MS) {
      if (!deleted.refreshToken) return { discarded: true };
      // The row is gone; the rotated tokens are used once for cleanup and dropped.
      accessToken = (await impl.refresh(deleted.refreshToken)).accessToken;
    }
    const tenants = await selection.listGrantTenants(accessToken, authEventId);
    await releaseUnchosenTenants({ provider: input.provider, accessToken, tenants, keepConnectionRef: null, context: input.reason });
  } catch (err) {
    console.warn('[accountingTenantSelection] remote cleanup after discard failed (best-effort)', {
      provider: input.provider, reason: input.reason, error: err instanceof Error ? err.message : String(err),
    });
  }
  return { discarded: true };
}

export async function reapStalePendingTenants(now: Date = new Date()): Promise<{ stale: number; reaped: number }> {
  assertNoAmbientDbContext('reapStalePendingTenants');
  const cutoff = new Date(now.getTime() - PENDING_TENANT_TTL_MS);
  const stale = await withSystemDbAccessContext(
    () => listStalePendingTenantConnections(db, cutoff),
    'accountingTenantSelection.reap.list',
  );
  let reaped = 0;
  for (const row of stale) {
    try {
      const result = await discardPendingTenantSelection({
        partnerId: row.partnerId, provider: row.provider, connectionId: row.id, olderThan: cutoff, reason: 'reaped',
        runInDbContext: (fn) => withSystemDbAccessContext(fn, 'accountingTenantSelection.reap'),
      });
      if (result.discarded) reaped++;
    } catch (err) {
      captureException(err instanceof Error ? err : new Error(String(err)), undefined, { service: 'accountingTenantSelection' });
    }
  }
  return { stale: stale.length, reaped };
}
