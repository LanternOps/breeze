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
import { rateLimitRetryAfterMs } from './accountingProviderError';
import { assertNoAmbientDbContext, type DbContextRunner } from './dbContextGuard';
import { findAccountingProvider, getAccountingProvider } from './providerRegistry';
import {
  deletePendingTenantRow, listHeldTenantKeys, listStalePendingTenantConnections, loadPendingTenantRow, pendingGrantFingerprint,
} from './accountingTenantSelectionStore';
import type { AccountingConnection, OwedPaymentDeletes } from './accountingConnectionService';
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

/**
 * removed: DELETEd. kept: a row holds the tenant or link. failed: the DELETE
 * threw. skipped: never examined, because the loop stopped (`stopped` says why):
 * a held-check failure (fail closed) or a provider throttle (the remaining
 * DELETEs would only hit the same limit). skipped links stay at the provider.
 */
export interface ReleaseUnchosenResult {
  removed: number; kept: number; failed: number; skipped: number;
  stopped: 'held_check_failed' | 'rate_limited' | null;
}

export async function releaseUnchosenTenants(input: {
  provider: AccountingProviderId; accessToken: string; tenants: readonly ProviderTenant[];
  keepConnectionRef: string | null; context: 'callback' | 'select' | 'cancel' | 'reaped';
}): Promise<ReleaseUnchosenResult> {
  assertNoAmbientDbContext('releaseUnchosenTenants');
  const selection = findAccountingProvider(input.provider)?.tenantSelection;
  const candidates = input.tenants.filter((t) => t.connectionRef !== input.keepConnectionRef);
  const result: ReleaseUnchosenResult = { removed: 0, kept: 0, failed: 0, skipped: 0, stopped: null };
  if (!selection || candidates.length === 0) return result;

  for (const [index, t] of candidates.entries()) {
    // The held check runs PER LINK, immediately before its DELETE (review A): a
    // claim that commits while earlier DELETEs are in flight is still seen. Each
    // check is its own closed system context; none is held across the DELETE.
    // What remains is the window between this check and this one DELETE.
    let held: { heldTenantIds: Set<string>; heldConnectionRefs: Set<string> };
    try {
      held = await withSystemDbAccessContext(
        () => listHeldTenantKeys(db, input.provider, [t]),
        'accountingTenantSelection.heldCheck',
      );
    } catch (err) {
      // Fail CLOSED: without the held check we cannot prove a link is ours to remove.
      captureException(err instanceof Error ? err : new Error(String(err)), undefined, { service: 'accountingTenantSelection' });
      console.warn('[accountingTenantSelection] held check failed; removing no further links', { provider: input.provider, context: input.context });
      result.skipped = candidates.length - index;
      result.stopped = 'held_check_failed';
      break;
    }
    if (held.heldTenantIds.has(t.tenantId) || held.heldConnectionRefs.has(t.connectionRef)) { result.kept++; continue; }
    try {
      await selection.removeTenantConnection(input.accessToken, t.connectionRef);
      result.removed++;
    } catch (err) {
      result.failed++;
      console.warn('[accountingTenantSelection] unchosen link removal failed (best-effort)', {
        provider: input.provider, context: input.context, error: err instanceof Error ? err.message : String(err),
      });
      // A throttle applies to every remaining DELETE too (review B): stop here.
      // It is not an incident (warn-only); a genuine failure IS one.
      if (rateLimitRetryAfterMs(err) !== null) {
        result.skipped = candidates.length - index - 1;
        result.stopped = 'rate_limited';
        break;
      }
      captureException(err instanceof Error ? err : new Error(String(err)), undefined, { service: 'accountingTenantSelection' });
    }
  }
  console.info('[accountingTenantSelection] unchosen links released', { provider: input.provider, context: input.context, ...result });
  return result;
}

/**
 * `discarded: true` carries the owed payment deletes the cascade just dropped
 * (#7289), already warned + Sentry-captured by the store; the ROUTE writes the
 * `accounting.connection.owed_deletes_discarded` audit, as for a disconnect.
 * `keptOwedPaymentDeletes` is the reaper's refusal: the row was left in place.
 */
export type DiscardPendingResult =
  | { discarded: true; connectionId: string; owedPaymentDeletes: OwedPaymentDeletes }
  | { discarded: false; keptOwedPaymentDeletes?: OwedPaymentDeletes };

export async function discardPendingTenantSelection(input: {
  partnerId: string; provider: AccountingProviderId; connectionId?: string; olderThan?: Date;
  reason: 'cancel' | 'reaped'; runInDbContext: DbContextRunner;
  /** Local disconnect bookkeeping; runs in the deletion transaction, before remote cleanup. */
  onDeleted?: (connectionId: string) => Promise<void>;
}): Promise<DiscardPendingResult> {
  assertNoAmbientDbContext('discardPendingTenantSelection');
  // Row FIRST: a select racing this cancel/reap then finds nothing to claim,
  // rather than claiming a tenant whose link we are about to remove.
  //
  // A re-parked former `connected` row can still owe payment deletes (#7289).
  // An operator's cancel discards them (never blocked, reported and audited
  // like deleteConnection). The reaper is a timer, not a decision: it KEEPS
  // such a row, because a discarded payment delete is unrecoverable (the
  // Payment Breeze voided stays in the books) while a kept row only holds the
  // partner's connection slot until someone cancels, disconnects or re-picks.
  const deleted = await input.runInDbContext(async () => {
    const row = await deletePendingTenantRow(db, {
      partnerId: input.partnerId, provider: input.provider, connectionId: input.connectionId, olderThan: input.olderThan,
      reason: input.reason, keepIfOwedPaymentDeletes: input.reason === 'reaped',
    });
    if (row?.kind === 'deleted') await input.onDeleted?.(row.id);
    return row;
  });
  if (!deleted) return { discarded: false };
  if (deleted.kind === 'kept_owed_payment_deletes') {
    const { count, remoteEntityIds } = deleted.owedPaymentDeletes;
    console.warn('[accountingTenantSelection] stale pending connection NOT reaped: it still owes payment delete(s); '
      + 'cancel or disconnect it to discard them, or pick the same organisation to keep them', {
      connectionId: deleted.id, partnerId: input.partnerId, provider: input.provider, count, remoteEntityIds,
    });
    captureException(
      new Error('accountingTenantSelection: stale pending connection kept because it still owes payment deletes'),
      undefined,
      { service: 'accountingTenantSelection', accounting_connection_id: deleted.id },
    );
    return { discarded: false, keptOwedPaymentDeletes: deleted.owedPaymentDeletes };
  }
  const discarded: DiscardPendingResult = { discarded: true, connectionId: deleted.id, owedPaymentDeletes: deleted.owedPaymentDeletes };

  const impl = findAccountingProvider(input.provider);
  const selection = impl?.tenantSelection;
  if (!impl || !selection || !deleted.accessToken) return discarded;
  // The ORIGINAL token: pending rows are never refreshed, so its claim is this flow's.
  const authEventId = selection.authEventIdOf(deleted.accessToken);
  if (!authEventId) return discarded;

  try {
    let accessToken = deleted.accessToken;
    const expiresAt = deleted.accessTokenExpiresAt?.getTime() ?? 0;
    if (expiresAt <= Date.now() + TENANT_PICK_TOKEN_MARGIN_MS) {
      if (!deleted.refreshToken) return discarded;
      // The row is gone; the rotated tokens are used once for cleanup and dropped.
      accessToken = (await impl.refresh(deleted.refreshToken)).accessToken;
    }
    const tenants = await selection.listGrantTenants(accessToken, authEventId);
    await releaseUnchosenTenants({ provider: input.provider, accessToken, tenants, keepConnectionRef: null, context: input.reason });
  } catch (err) {
    console.warn('[accountingTenantSelection] remote cleanup after discard failed (best-effort)', {
      provider: input.provider, reason: input.reason, error: err instanceof Error ? err.message : String(err),
    });
    // A throttle is not an incident (matches the per-link guard above); a
    // genuine failure IS one.
    if (rateLimitRetryAfterMs(err) === null) {
      captureException(err instanceof Error ? err : new Error(String(err)), undefined, { service: 'accountingTenantSelection' });
    }
  }
  return discarded;
}

/** `kept`: stale rows left in place because they still owe payment deletes (#7289); each is warned + captured per sweep. */
export async function reapStalePendingTenants(now: Date = new Date()): Promise<{ stale: number; reaped: number; kept: number }> {
  assertNoAmbientDbContext('reapStalePendingTenants');
  const cutoff = new Date(now.getTime() - PENDING_TENANT_TTL_MS);
  const stale = await withSystemDbAccessContext(
    () => listStalePendingTenantConnections(db, cutoff),
    'accountingTenantSelection.reap.list',
  );
  let reaped = 0;
  let kept = 0;
  for (const row of stale) {
    try {
      const result = await discardPendingTenantSelection({
        partnerId: row.partnerId, provider: row.provider, connectionId: row.id, olderThan: cutoff, reason: 'reaped',
        runInDbContext: (fn) => withSystemDbAccessContext(fn, 'accountingTenantSelection.reap'),
      });
      if (result.discarded) reaped++;
      else if (result.keptOwedPaymentDeletes) kept++;
    } catch (err) {
      captureException(err instanceof Error ? err : new Error(String(err)), undefined, { service: 'accountingTenantSelection' });
    }
  }
  return { stale: stale.length, reaped, kept };
}
