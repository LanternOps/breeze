/**
 * Xero W02 against real Postgres: the races and the held-tenant rules that the
 * mocked suites can only simulate (the tenant-selection store has no unit tests
 * of its own; this suite is its proof).
 *
 *  - Review Focus 1: two partners racing for one tenant. Exactly one row holds
 *    it; the loser gets AccountingTenantHeldError (409 accounting_tenant_held)
 *    and, from the picker, its row stays pending_tenant.
 *  - Review Focus 2: the held check sees ANOTHER partner's row because it runs in
 *    system scope, so that partner's link is never deleted.
 *  - Partner isolation of the store: a partner-scoped claim / delete / cancel
 *    can never touch another partner's pending row.
 *  - Review Focus 3: a stale pending row blocks QuickBooks until the reaper
 *    removes it after 1 hour; a fresh one is never reaped.
 *  - Review Focus 5 / #7189: a revoked Xero grant PERSISTS reauth_required; a
 *    peer's rotation is not mistaken for a revocation.
 *
 * Every store call on a request path runs under the caller's partner-scoped RLS
 * context, so the claim/delete cases below use that context, not system scope.
 */
import './setup';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { and, eq, sql } from 'drizzle-orm';
import {
  db, withDbAccessContext, withSystemDbAccessContext, type DbAccessContext,
} from '../../db';
import { accountingConnections } from '../../db/schema';
import { createPartner } from './db-utils';
import {
  AccountingProviderConflictError, AccountingTenantHeldError, upsertConnection,
} from '../../services/accounting/accountingConnectionService';
import {
  claimPendingTenant, deletePendingTenantRow, listHeldTenantKeys, listStalePendingTenantConnections,
  loadPendingTenantRow, pendingGrantFingerprint,
} from '../../services/accounting/accountingTenantSelectionStore';
import {
  discardPendingTenantSelection, reapStalePendingTenants, releaseUnchosenTenants,
} from '../../services/accounting/accountingTenantSelection';
import { getValidAccessToken, ReauthRequiredError } from '../../services/accounting/accountingTokens';
import { hmacFingerprint } from '../../services/secretCrypto';
import { findAccountingProvider } from '../../services/accounting/providerRegistry';
import type { ProviderTenant } from '../../services/accounting/types';

const runDb = it.runIf(!!process.env.DATABASE_URL);

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

function partnerCtx(partnerId: string): DbAccessContext {
  return {
    scope: 'partner',
    orgId: null,
    accessibleOrgIds: null,
    accessiblePartnerIds: [partnerId],
    userId: null,
  };
}

const asPartner = <T>(partnerId: string, fn: () => Promise<T>) => withDbAccessContext(partnerCtx(partnerId), fn);
const asSystem = <T>(fn: () => Promise<T>) => withSystemDbAccessContext(fn);

function tenant(tenantId: string, connectionRef = `conn-${tenantId}`): ProviderTenant {
  return { tenantId, connectionRef, name: tenantId, tenantType: 'ORGANISATION', authEventId: 'evt-00001' };
}

/** A Xero row parked by a multi-organisation callback: tokens, no tenant yet. */
async function parkPending(partnerId: string, refreshToken = 'rt-pending', accessToken = 'at-pending') {
  return asSystem(() => upsertConnection(db, partnerId, 'xero', {
    accessToken, refreshToken,
    accessTokenExpiresAt: new Date(Date.now() + 30 * MINUTE),
    refreshTokenExpiresAt: new Date(Date.now() + 60 * DAY),
    status: 'pending_tenant', environment: 'production',
  }));
}

async function readRow(id: string) {
  const [row] = await asSystem(() => db.select().from(accountingConnections).where(eq(accountingConnections.id, id)));
  return row ?? null;
}

async function rowsHoldingTenant(provider: 'xero' | 'quickbooks', tenantId: string) {
  return asSystem(() => db.select({ id: accountingConnections.id, partnerId: accountingConnections.partnerId })
    .from(accountingConnections)
    .where(and(eq(accountingConnections.provider, provider), eq(accountingConnections.realmIdFingerprint, hmacFingerprint(tenantId)))));
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe('Xero W02 connection races (real DB)', () => {
  runDb('harness: Xero is registered and the code-under-test pool is non-BYPASSRLS breeze_app', async () => {
    expect(findAccountingProvider('xero')?.tenantSelection).toBeTruthy();
    const partner = await createPartner();
    const rows = await asPartner(partner.id, () => db.execute(
      sql`SELECT current_user AS who, rolbypassrls FROM pg_roles WHERE rolname = current_user`,
    ));
    const row = (rows as unknown as Array<{ who: string; rolbypassrls: boolean }>)[0];
    expect(row?.who).toBe('breeze_app');
    expect(row?.rolbypassrls).toBe(false);
  });

  // ---------------------------------------------------------------- Review Focus 1
  runDb('Review Focus 1 (callback): two partners racing to persist one tenant — exactly one wins, the other is tenant-held', async () => {
    const [a, b] = [await createPartner(), await createPartner()];
    const results = await Promise.allSettled([a, b].map((p) => asSystem(() => upsertConnection(db, p.id, 'xero', {
      realmId: 'race-tenant-1', providerConnectionRef: `conn-${p.id}`, status: 'connected', environment: 'production',
    }))));
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const loser = results.find((r) => r.status === 'rejected') as PromiseRejectedResult;
    expect(loser.reason).toBeInstanceOf(AccountingTenantHeldError);
    expect(loser.reason).toMatchObject({ code: 'accounting_tenant_held', status: 409 });
    expect((loser.reason as Error).message).toBe('This Xero organisation is connected to another Breeze account');
    expect(await rowsHoldingTenant('xero', 'race-tenant-1')).toHaveLength(1);
  });

  runDb('Review Focus 1 (picker): two partners concurrently claiming one tenant under their OWN RLS — one claimed, the loser is held and stays pending', async () => {
    const [a, b] = [await createPartner(), await createPartner()];
    const [pendingA, pendingB] = [await parkPending(a.id, 'rt-a'), await parkPending(b.id, 'rt-b')];
    const claim = (partnerId: string, connectionId: string, rt: string) => asPartner(partnerId, () => claimPendingTenant(db, {
      connectionId, partnerId, provider: 'xero', realmId: 'race-tenant-2', providerConnectionRef: `conn-${partnerId}`,
      resetRealmFacts: true, grantFingerprint: pendingGrantFingerprint(rt),
    }));
    const results = await Promise.allSettled([claim(a.id, pendingA.id, 'rt-a'), claim(b.id, pendingB.id, 'rt-b')]);

    const won = results.filter((r) => r.status === 'fulfilled') as Array<PromiseFulfilledResult<Awaited<ReturnType<typeof claimPendingTenant>>>>;
    expect(won).toHaveLength(1);
    expect(won[0]!.value.kind).toBe('claimed');
    const lost = results.find((r) => r.status === 'rejected') as PromiseRejectedResult;
    expect(lost.reason).toBeInstanceOf(AccountingTenantHeldError);
    expect(lost.reason).toMatchObject({ code: 'accounting_tenant_held', status: 409 });

    const holders = await rowsHoldingTenant('xero', 'race-tenant-2');
    expect(holders).toHaveLength(1);
    const winnerId = holders[0]!.id;
    const loserId = winnerId === pendingA.id ? pendingB.id : pendingA.id;
    expect((await readRow(winnerId))?.status).toBe('connected');
    const loserRow = await readRow(loserId);
    expect(loserRow?.status).toBe('pending_tenant');
    expect(loserRow?.realmIdFingerprint).toBeNull();
    expect(loserRow?.realmIdEncrypted).toBeNull();

    // The loser's row is still usable: it can pick a different organisation.
    const loserPartnerId = loserId === pendingA.id ? a.id : b.id;
    const loserRt = loserId === pendingA.id ? 'rt-a' : 'rt-b';
    const retry = await asPartner(loserPartnerId, () => claimPendingTenant(db, {
      connectionId: loserId, partnerId: loserPartnerId, provider: 'xero', realmId: `other-tenant-${loserPartnerId}`,
      providerConnectionRef: `conn-other-${loserPartnerId}`, resetRealmFacts: true, grantFingerprint: pendingGrantFingerprint(loserRt),
    }));
    expect(retry.kind).toBe('claimed');
  });

  runDb('a picker claim of a tenant another partner already holds is refused, and the row STAYS pending', async () => {
    const [holder, picker] = [await createPartner(), await createPartner()];
    await asSystem(() => upsertConnection(db, holder.id, 'xero', { realmId: 'held-tenant-1', providerConnectionRef: 'conn-held-1', status: 'connected' }));
    const pending = await parkPending(picker.id, 'r');
    await expect(asPartner(picker.id, () => claimPendingTenant(db, {
      connectionId: pending.id, partnerId: picker.id, provider: 'xero', realmId: 'held-tenant-1', providerConnectionRef: 'conn-x',
      resetRealmFacts: true, grantFingerprint: pendingGrantFingerprint('r'),
    }))).rejects.toBeInstanceOf(AccountingTenantHeldError);
    const row = await readRow(pending.id);
    expect(row?.status).toBe('pending_tenant');
    expect(row?.realmIdFingerprint).toBeNull();
    const holders = await rowsHoldingTenant('xero', 'held-tenant-1');
    expect(holders.map((h) => h.partnerId)).toEqual([holder.id]);
  });

  runDb('two concurrent claims of one pending row — exactly one succeeds, the other is not_pending', async () => {
    const partner = await createPartner();
    const pending = await parkPending(partner.id, 'r');
    const claims = await Promise.all([`claim-t-A-${partner.id}`, `claim-t-B-${partner.id}`].map((t) => asPartner(partner.id, () => claimPendingTenant(db, {
      connectionId: pending.id, partnerId: partner.id, provider: 'xero', realmId: t, providerConnectionRef: `conn-${t}`,
      resetRealmFacts: true, grantFingerprint: pendingGrantFingerprint('r'),
    }))));
    expect(claims.map((c) => c.kind).sort()).toEqual(['claimed', 'not_pending']);
    expect((await readRow(pending.id))?.status).toBe('connected');
  });

  runDb('a second pending callback landing between load and claim → grant_superseded; grant B\'s credentials are untouched', async () => {
    const partner = await createPartner();
    const pendingA = await parkPending(partner.id, 'rt-A', 'at-A');
    const loaded = await asPartner(partner.id, () => loadPendingTenantRow(db, partner.id, 'xero'));
    const fingerprintA = pendingGrantFingerprint(loaded!.refreshToken!);
    // Grant B's callback lands on the SAME row id (upsert conflicts on partner_id).
    const pendingB = await parkPending(partner.id, 'rt-B', 'at-B');
    expect(pendingB.id).toBe(pendingA.id);
    const claim = await asPartner(partner.id, () => claimPendingTenant(db, {
      connectionId: pendingA.id, partnerId: partner.id, provider: 'xero', realmId: `ten-from-A-${partner.id}`,
      providerConnectionRef: 'conn-from-A', resetRealmFacts: true, grantFingerprint: fingerprintA,
    }));
    expect(claim).toEqual({ kind: 'grant_superseded' });
    const after = await asPartner(partner.id, () => loadPendingTenantRow(db, partner.id, 'xero'));
    expect(after?.status).toBe('pending_tenant');
    expect(after?.realmId).toBeNull();
    expect(after?.refreshToken).toBe('rt-B');
    expect(after?.accessToken).toBe('at-B');
  });

  // ---------------------------------------------------------------- Review Focus 2
  runDb('Review Focus 2: the held check sees ANOTHER partner\'s row only because it runs in system scope', async () => {
    const [holder, linkHolder, viewer] = [await createPartner(), await createPartner(), await createPartner()];
    await asSystem(() => upsertConnection(db, holder.id, 'xero', { realmId: 'scope-tenant-1', providerConnectionRef: 'conn-holder', status: 'connected' }));
    // A SEPARATE row holding only a link id, so each half of the check is proven on its own.
    await asSystem(() => upsertConnection(db, linkHolder.id, 'xero', { realmId: 'link-holder-tenant', providerConnectionRef: 'conn-scope-1', status: 'connected' }));
    const probe = [tenant('scope-tenant-1', 'conn-other'), tenant('other-tenant', 'conn-scope-1'), tenant('free-tenant')];
    const system = await asSystem(() => listHeldTenantKeys(db, 'xero', probe));
    expect([...system.heldTenantIds]).toEqual(['scope-tenant-1']);
    expect([...system.heldConnectionRefs].sort()).toEqual(['conn-holder', 'conn-scope-1']);
    // Control: the same query under the viewer partner's RLS context is blind to
    // it — which is exactly why releaseUnchosenTenants must not run it there.
    const partnerScoped = await asPartner(viewer.id, () => listHeldTenantKeys(db, 'xero', probe));
    expect(partnerScoped.heldTenantIds.size).toBe(0);
    expect(partnerScoped.heldConnectionRefs.size).toBe(0);
  });

  runDb('Review Focus 2: releaseUnchosenTenants never deletes a link another partner\'s row holds; it removes only the free one', async () => {
    const [holder, linkHolder] = [await createPartner(), await createPartner()];
    await asSystem(() => upsertConnection(db, holder.id, 'xero', { realmId: 'held-by-tenant', providerConnectionRef: 'conn-holder', status: 'connected' }));
    await asSystem(() => upsertConnection(db, linkHolder.id, 'xero', { realmId: 'link-holder-tenant', providerConnectionRef: 'conn-held-by-ref', status: 'connected' }));
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(null, { status: 204 }));
    const out = await releaseUnchosenTenants({
      provider: 'xero', accessToken: 'at-release', keepConnectionRef: null, context: 'select',
      tenants: [tenant('held-by-tenant', 'conn-link-1'), tenant('unrelated', 'conn-held-by-ref'), tenant('free-tenant', 'conn-free')],
    });
    expect(out).toEqual({ removed: 1, kept: 2, failed: 0 });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0]!;
    expect(String(url)).toBe('https://api.xero.com/connections/conn-free');
    expect((init as RequestInit).method).toBe('DELETE');
  });

  // ------------------------------------------------- partner isolation of the store
  runDb('a partner-scoped claim / delete / cancel cannot touch another partner\'s pending row', async () => {
    const [a, b] = [await createPartner(), await createPartner()];
    const pendingA = await parkPending(a.id, 'rt-a');
    const pendingB = await parkPending(b.id, 'rt-b');
    const fetchSpy = vi.spyOn(globalThis, 'fetch');

    // Forged partnerId = B, under A's RLS context.
    expect(await asPartner(a.id, () => deletePendingTenantRow(db, { partnerId: b.id, provider: 'xero' }))).toBeNull();
    // A's own partnerId, but B's row id.
    expect(await asPartner(a.id, () => deletePendingTenantRow(db, { partnerId: a.id, provider: 'xero', connectionId: pendingB.id }))).toBeNull();
    expect(await asPartner(a.id, () => loadPendingTenantRow(db, b.id, 'xero'))).toBeNull();
    expect(await asPartner(a.id, () => claimPendingTenant(db, {
      connectionId: pendingB.id, partnerId: b.id, provider: 'xero', realmId: 'forged-tenant', providerConnectionRef: 'conn-forged',
      resetRealmFacts: true, grantFingerprint: pendingGrantFingerprint('rt-b'),
    }))).toEqual({ kind: 'not_pending' });
    // The cancel orchestration with A's runner, aimed at B.
    expect(await discardPendingTenantSelection({
      partnerId: b.id, provider: 'xero', connectionId: pendingB.id, reason: 'cancel',
      runInDbContext: (fn) => asPartner(a.id, fn),
    })).toEqual({ discarded: false });
    expect(fetchSpy).not.toHaveBeenCalled();

    const rowB = await readRow(pendingB.id);
    expect(rowB?.status).toBe('pending_tenant');
    expect(rowB?.realmIdFingerprint).toBeNull();

    // Non-vacuity: the same runner DOES delete A's own pending row.
    expect(await discardPendingTenantSelection({
      partnerId: a.id, provider: 'xero', connectionId: pendingA.id, reason: 'cancel',
      runInDbContext: (fn) => asPartner(a.id, fn),
    })).toEqual({ discarded: true });
    expect(await readRow(pendingA.id)).toBeNull();
    expect((await readRow(pendingB.id))?.status).toBe('pending_tenant');
  });

  runDb('the pending-row delete never removes a CONNECTED row, even the partner\'s own', async () => {
    const partner = await createPartner();
    const conn = await asSystem(() => upsertConnection(db, partner.id, 'xero', { realmId: `own-${partner.id}`, status: 'connected' }));
    expect(await asPartner(partner.id, () => deletePendingTenantRow(db, { partnerId: partner.id, provider: 'xero' }))).toBeNull();
    expect((await readRow(conn.id))?.status).toBe('connected');
  });

  // ---------------------------------------------------------------- Review Focus 3
  runDb('Review Focus 3: a stale pending row blocks QuickBooks, is reaped after 1 hour, and QuickBooks can then connect', async () => {
    const partner = await createPartner();
    const pending = await asSystem(() => upsertConnection(db, partner.id, 'xero', { accessToken: 'not-a-jwt', refreshToken: 'r', status: 'pending_tenant' }));
    const blocked = await asSystem(() => upsertConnection(db, partner.id, 'quickbooks', { realmId: `qbo-before-reap-${partner.id}` })).catch((e) => e);
    expect(blocked).toBeInstanceOf(AccountingProviderConflictError);
    expect((blocked as Error).message).toBe('Finish or cancel the Xero connection before connecting QuickBooks');

    await asSystem(() => db.update(accountingConnections)
      .set({ updatedAt: new Date(Date.now() - 2 * HOUR) }).where(eq(accountingConnections.id, pending.id)));
    const fetchSpy = vi.spyOn(globalThis, 'fetch'); // the token has no auth-event claim → no HTTP at all
    const stale = await asSystem(() => listStalePendingTenantConnections(db, new Date(Date.now() - HOUR)));
    expect(stale.map((s) => s.id)).toContain(pending.id);
    const out = await reapStalePendingTenants();
    expect(out.reaped).toBeGreaterThanOrEqual(1);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(await readRow(pending.id)).toBeNull();

    const qbo = await asSystem(() => upsertConnection(db, partner.id, 'quickbooks', { realmId: `qbo-after-reap-${partner.id}` }));
    expect(qbo.provider).toBe('quickbooks');
    expect(qbo.status).toBe('connected');
  });

  runDb('a FRESH pending row is not reaped', async () => {
    const partner = await createPartner();
    const pending = await parkPending(partner.id, 'r', 'x');
    // Both halves: the listing's cutoff AND the DELETE's own olderThan re-check.
    expect(await asSystem(() => listStalePendingTenantConnections(db, new Date(Date.now() - HOUR)))).toEqual([]);
    const out = await reapStalePendingTenants();
    expect(out).toEqual({ stale: 0, reaped: 0 });
    expect((await readRow(pending.id))?.status).toBe('pending_tenant');
  });

  runDb('a row a NEW callback refreshed after the stale listing is not reaped (olderThan re-checked in the DELETE)', async () => {
    const partner = await createPartner();
    const pending = await asSystem(() => upsertConnection(db, partner.id, 'xero', { accessToken: 'not-a-jwt', refreshToken: 'r', status: 'pending_tenant' }));
    await asSystem(() => db.update(accountingConnections)
      .set({ updatedAt: new Date(Date.now() - 2 * HOUR) }).where(eq(accountingConnections.id, pending.id)));
    const cutoff = new Date(Date.now() - HOUR);
    const stale = await asSystem(() => listStalePendingTenantConnections(db, cutoff));
    expect(stale.map((s) => s.id)).toContain(pending.id);
    // The user starts a fresh connect: a new callback re-parks the same row now.
    await parkPending(partner.id, 'rt-new', 'at-new');
    const result = await discardPendingTenantSelection({
      partnerId: partner.id, provider: 'xero', connectionId: pending.id, olderThan: cutoff, reason: 'reaped',
      runInDbContext: (fn) => asSystem(fn),
    });
    expect(result).toEqual({ discarded: false });
    expect((await readRow(pending.id))?.status).toBe('pending_tenant');
  });

  // ---------------------------------------------------- Review Focus 5 / #7189
  async function seedExpiringXero(partnerId: string) {
    return asSystem(() => upsertConnection(db, partnerId, 'xero', {
      realmId: `revoked-${partnerId}`, accessToken: 'stale-at', refreshToken: 'revoked-rt',
      accessTokenExpiresAt: new Date(Date.now() - 1_000), refreshTokenExpiresAt: new Date(Date.now() + DAY),
      status: 'connected', environment: 'production',
    }));
  }

  runDb('Task 4 + precondition 3: a Xero revoked-grant refresh PERSISTS reauth_required (not rolled back)', async () => {
    // F16: requestXeroTokens refuses before any fetch when the client id/secret are unset.
    vi.stubEnv('XERO_CLIENT_ID', 'test-xero-client');
    vi.stubEnv('XERO_CLIENT_SECRET', 'test-xero-secret');
    const partner = await createPartner();
    const conn = await seedExpiringXero(partner.id);
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response(JSON.stringify({ error: 'invalid_grant' }), { status: 400 }));
    vi.spyOn(console, 'error').mockImplementation(() => {});
    // No ambient context: getValidAccessToken opens its own short transactions.
    await expect(getValidAccessToken(db, conn)).rejects.toBeInstanceOf(ReauthRequiredError);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(String(fetchSpy.mock.calls[0]![0])).toBe('https://identity.xero.com/connect/token');
    const row = await readRow(conn.id);
    expect(row?.status).toBe('reauth_required');
    expect(row?.lastError).toBe('Xero refresh token is invalid or expired');
  });

  runDb('control (F16): an instance with no Xero client credentials never flips a partner to reauth_required', async () => {
    vi.stubEnv('XERO_CLIENT_ID', '');
    vi.stubEnv('XERO_CLIENT_SECRET', '');
    const partner = await createPartner();
    const conn = await seedExpiringXero(partner.id);
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const err = await getValidAccessToken(db, conn).catch((e) => e);
    expect(err).not.toBeInstanceOf(ReauthRequiredError);
    expect(err).toMatchObject({ kind: 'transient' });
    expect(fetchSpy).not.toHaveBeenCalled();
    expect((await readRow(conn.id))?.status).toBe('connected');
  });

  runDb('Review Focus 5: invalid_grant after a PEER already rotated is not a revocation — the peer\'s token is returned, status stays connected', async () => {
    vi.stubEnv('XERO_CLIENT_ID', 'test-xero-client');
    vi.stubEnv('XERO_CLIENT_SECRET', 'test-xero-secret');
    const partner = await createPartner();
    const conn = await seedExpiringXero(partner.id);
    vi.spyOn(globalThis, 'fetch').mockImplementationOnce(async () => {
      // A peer worker commits its rotation while our refresh is in flight.
      await asSystem(() => upsertConnection(db, partner.id, 'xero', {
        accessToken: 'peer-at', refreshToken: 'peer-rt',
        accessTokenExpiresAt: new Date(Date.now() + 30 * MINUTE), refreshTokenExpiresAt: new Date(Date.now() + 60 * DAY),
      }));
      return new Response(JSON.stringify({ error: 'invalid_grant' }), { status: 400 });
    });
    await expect(getValidAccessToken(db, conn)).resolves.toBe('peer-at');
    const row = await readRow(conn.id);
    expect(row?.status).toBe('connected');
    expect(row?.lastError).toBeNull();
  });
});
