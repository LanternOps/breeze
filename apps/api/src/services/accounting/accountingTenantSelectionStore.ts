/**
 * DB half of Xero W02 tenant selection. No HTTP here. Every function takes the
 * executor it is handed: request paths pass the caller's partner-scoped runner,
 * EXCEPT listHeldTenantKeys, which the orchestration always runs in SYSTEM scope
 * (other partners' rows are invisible under partner RLS, and "not visible" must
 * never read as "not held").
 */
import { and, eq, inArray, lt, or } from 'drizzle-orm';
import { accountingConnections } from '../../db/schema';
import { decryptSecret, encryptSecret, hmacFingerprint } from '../secretCrypto';
import { isPgUniqueViolation } from '../../utils/pgErrors';
import {
  AccountingTenantHeldError, mapConnection, PENDING_TENANT_STATUS, REALM_FINGERPRINT_UNIQUE_INDEX,
  type AccountingConnection, type DbExecutor,
} from './accountingConnectionService';
import type { AccountingProviderId, ProviderTenant } from './types';

export async function loadPendingTenantRow(dbc: DbExecutor, partnerId: string, provider: AccountingProviderId): Promise<AccountingConnection | null> {
  const [row] = await dbc.select().from(accountingConnections).where(and(
    eq(accountingConnections.partnerId, partnerId),
    eq(accountingConnections.provider, provider),
    eq(accountingConnections.status, PENDING_TENANT_STATUS),
  )).limit(1);
  return row ? mapConnection(row) : null;
}

/**
 * Fail-safe (a claim → grant_superseded, a discard → no remote cleanup), but
 * never silent (review D): a key or ciphertext problem would otherwise show the
 * user a repeating 409 with nothing in the logs. Logs ids only, never the value.
 */
function decryptOrNull(
  value: string | null,
  where: { connectionId: string; provider: AccountingProviderId; field: 'access_token' | 'refresh_token' },
): string | null {
  if (!value) return null;
  try {
    return decryptSecret(value);
  } catch (err) {
    console.warn('[accountingTenantSelectionStore] could not decrypt a pending connection token; treating it as absent', {
      ...where, error: err instanceof Error ? err.message : 'unknown',
    });
    return null;
  }
}

/**
 * Identity of one pending grant. A second callback for the same partner (the
 * user started another connect in a new tab) REUSES the row id and overwrites
 * the tokens (upsertConnection conflicts on partner_id). Without this, a pick
 * made from grant A's picker could commit A's tenant onto grant B's
 * credentials. Pending rows are never refreshed, so the ORIGINAL refresh token
 * is stable for exactly one grant. Keyed HMAC, never the raw token.
 */
export function pendingGrantFingerprint(refreshToken: string): string {
  return hmacFingerprint(`pending-grant:${refreshToken}`);
}

export type ClaimResult =
  | { kind: 'claimed'; connection: AccountingConnection }
  | { kind: 'not_pending' }
  | { kind: 'grant_superseded' };

/**
 * The picker's commit. MUST run inside a transaction (every runner does): it
 * locks the row, re-checks status AND grant identity under the lock, then
 * updates. So a select racing a cancel / the reaper / a second select has
 * exactly one winner, and a select racing a NEWER callback on the same row
 * loses with grant_superseded instead of mixing grants. A tenant another
 * partner holds trips the global (provider, realm_id_fingerprint) unique index
 * → AccountingTenantHeldError, and the row stays pending (Review Focus 1).
 */
export async function claimPendingTenant(dbc: DbExecutor, input: {
  connectionId: string; partnerId: string; provider: AccountingProviderId;
  realmId: string; providerConnectionRef: string; resetRealmFacts: boolean;
  grantFingerprint: string;
}): Promise<ClaimResult> {
  const [locked] = await dbc.select({
    status: accountingConnections.status,
    refreshTokenEncrypted: accountingConnections.refreshTokenEncrypted,
  }).from(accountingConnections).where(and(
    eq(accountingConnections.id, input.connectionId),
    eq(accountingConnections.partnerId, input.partnerId),
  )).limit(1).for('update');
  if (!locked || locked.status !== PENDING_TENANT_STATUS) return { kind: 'not_pending' };
  const currentRefresh = decryptOrNull(locked.refreshTokenEncrypted, {
    connectionId: input.connectionId, provider: input.provider, field: 'refresh_token',
  });
  if (!currentRefresh || pendingGrantFingerprint(currentRefresh) !== input.grantFingerprint) {
    return { kind: 'grant_superseded' };
  }
  try {
    const [row] = await dbc.update(accountingConnections).set({
      realmIdEncrypted: encryptSecret(input.realmId),
      realmIdFingerprint: hmacFingerprint(input.realmId),
      providerConnectionRef: input.providerConnectionRef,
      status: 'connected',
      lastError: null,
      // A different tenant than the row last held: its captured facts are the
      // old tenant's and must not survive (same rule as the callback's realm change).
      ...(input.resetRealmFacts ? { homeCurrency: null, multiCurrencyEnabled: null } : {}),
      updatedAt: new Date(),
    }).where(and(
      eq(accountingConnections.id, input.connectionId),
      eq(accountingConnections.partnerId, input.partnerId),
      eq(accountingConnections.status, PENDING_TENANT_STATUS),
    )).returning();
    // The row is locked and was pending a moment ago, so a miss here is not expected; treat it as lost.
    return row ? { kind: 'claimed', connection: mapConnection(row) } : { kind: 'not_pending' };
  } catch (err) {
    if (isPgUniqueViolation(err, REALM_FINGERPRINT_UNIQUE_INDEX)) throw new AccountingTenantHeldError(input.provider);
    throw err;
  }
}

export interface DeletedPendingRow {
  id: string;
  accessToken: string | null;
  refreshToken: string | null;
  accessTokenExpiresAt: Date | null;
}

/** Deletes the partner's pending row (optionally only if older than `olderThan`) and hands back its tokens for remote cleanup. */
export async function deletePendingTenantRow(dbc: DbExecutor, input: {
  partnerId: string; provider: AccountingProviderId; connectionId?: string; olderThan?: Date;
}): Promise<DeletedPendingRow | null> {
  const conditions = [
    eq(accountingConnections.partnerId, input.partnerId),
    eq(accountingConnections.provider, input.provider),
    eq(accountingConnections.status, PENDING_TENANT_STATUS),
  ];
  if (input.connectionId) conditions.push(eq(accountingConnections.id, input.connectionId));
  if (input.olderThan) conditions.push(lt(accountingConnections.updatedAt, input.olderThan));
  const [row] = await dbc.delete(accountingConnections).where(and(...conditions)).returning({
    id: accountingConnections.id,
    accessTokenEncrypted: accountingConnections.accessTokenEncrypted,
    refreshTokenEncrypted: accountingConnections.refreshTokenEncrypted,
    accessTokenExpiresAt: accountingConnections.accessTokenExpiresAt,
  });
  if (!row) return null;
  return {
    id: row.id,
    accessToken: decryptOrNull(row.accessTokenEncrypted, { connectionId: row.id, provider: input.provider, field: 'access_token' }),
    refreshToken: decryptOrNull(row.refreshTokenEncrypted, { connectionId: row.id, provider: input.provider, field: 'refresh_token' }),
    accessTokenExpiresAt: row.accessTokenExpiresAt ?? null,
  };
}

/** Which of these tenants / links ANY accounting_connections row holds. SYSTEM scope only (see file header). */
export async function listHeldTenantKeys(
  dbc: DbExecutor,
  provider: AccountingProviderId,
  tenants: readonly ProviderTenant[],
): Promise<{ heldTenantIds: Set<string>; heldConnectionRefs: Set<string> }> {
  if (tenants.length === 0) return { heldTenantIds: new Set(), heldConnectionRefs: new Set() };
  const fingerprintToTenant = new Map(tenants.map((t) => [hmacFingerprint(t.tenantId), t.tenantId]));
  const refs = tenants.map((t) => t.connectionRef);
  const rows = await dbc.select({
    fingerprint: accountingConnections.realmIdFingerprint,
    ref: accountingConnections.providerConnectionRef,
  }).from(accountingConnections).where(and(
    eq(accountingConnections.provider, provider),
    or(
      inArray(accountingConnections.realmIdFingerprint, [...fingerprintToTenant.keys()]),
      inArray(accountingConnections.providerConnectionRef, refs),
    ),
  ));
  const heldTenantIds = new Set<string>();
  const heldConnectionRefs = new Set<string>();
  for (const r of rows as Array<{ fingerprint: string | null; ref: string | null }>) {
    const tenantId = r.fingerprint ? fingerprintToTenant.get(r.fingerprint) : undefined;
    if (tenantId) heldTenantIds.add(tenantId);
    if (r.ref) heldConnectionRefs.add(r.ref);
  }
  return { heldTenantIds, heldConnectionRefs };
}

export async function listStalePendingTenantConnections(dbc: DbExecutor, cutoff: Date): Promise<Array<{ id: string; partnerId: string; provider: AccountingProviderId }>> {
  const rows = await dbc.select({
    id: accountingConnections.id, partnerId: accountingConnections.partnerId, provider: accountingConnections.provider,
  }).from(accountingConnections).where(and(
    eq(accountingConnections.status, PENDING_TENANT_STATUS),
    lt(accountingConnections.updatedAt, cutoff),
  ));
  return (rows as Array<{ id: string; partnerId: string; provider: string }>)
    .map((r) => ({ id: r.id, partnerId: r.partnerId, provider: r.provider as AccountingProviderId }));
}
