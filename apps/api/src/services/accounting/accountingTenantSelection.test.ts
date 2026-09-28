import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({
  store: {
    loadPendingTenantRow: vi.fn(),
    deletePendingTenantRow: vi.fn(),
    listHeldTenantKeys: vi.fn(),
    listStalePendingTenantConnections: vi.fn(),
    pendingGrantFingerprint: vi.fn((rt: string) => `fp:${rt}`),
  },
  selection: {
    connectableTenantType: 'ORGANISATION',
    authEventIdOf: vi.fn(),
    listGrantTenants: vi.fn(),
    listAllTenants: vi.fn(),
    removeTenantConnection: vi.fn(),
  },
  refresh: vi.fn(),
  systemCtxCalls: [] as string[],
}));
vi.mock('./accountingTenantSelectionStore', () => m.store);
vi.mock('./providerRegistry', () => ({
  getAccountingProvider: () => ({ provider: 'xero', displayName: 'Xero', tenantSelection: m.selection, refresh: m.refresh }),
  findAccountingProvider: () => ({ provider: 'xero', displayName: 'Xero', tenantSelection: m.selection, refresh: m.refresh }),
}));
vi.mock('../../db', () => ({
  db: {},
  hasDbAccessContext: () => false,
  withSystemDbAccessContext: async (fn: () => unknown, label?: string) => { m.systemCtxCalls.push(label ?? ''); return fn(); },
}));
vi.mock('../sentry', () => ({ captureException: vi.fn() }));

import {
  AccountingTenantSelectionError, discardPendingTenantSelection, loadPendingGrant, reapStalePendingTenants, releaseUnchosenTenants,
} from './accountingTenantSelection';
import { AccountingProviderError } from './accountingProviderError';
import { captureException } from '../sentry';

const runner = async <T>(fn: () => Promise<T>) => fn();
const tenant = (id: string, type = 'ORGANISATION') => ({ tenantId: `ten-${id}`, connectionRef: `conn-${id}`, name: id, tenantType: type, authEventId: 'evt-1' });
const pendingRow = (over: Record<string, unknown> = {}) => ({
  id: 'row-1', partnerId: 'p1', provider: 'xero', status: 'pending_tenant', realmId: null,
  accessToken: 'ORIGINAL-at', refreshToken: 'rt', accessTokenExpiresAt: new Date(Date.now() + 20 * 60_000), ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  m.systemCtxCalls.length = 0;
  m.store.listHeldTenantKeys.mockResolvedValue({ heldTenantIds: new Set(), heldConnectionRefs: new Set() });
  m.selection.authEventIdOf.mockReturnValue('evt-1');
  m.selection.removeTenantConnection.mockResolvedValue(undefined);
});

// "/connections only read filtered by the flow's auth event": this module has no
// reconnect path, so the unfiltered list must never be read from it (review N).
afterEach(() => {
  expect(m.selection.listAllTenants).not.toHaveBeenCalled();
});

describe('releaseUnchosenTenants (spec W02: only same-authEvent links no row holds)', () => {
  it('removes every unchosen link, keeps the chosen one', async () => {
    const out = await releaseUnchosenTenants({ provider: 'xero', accessToken: 'at', tenants: [tenant('A'), tenant('B'), tenant('C')], keepConnectionRef: 'conn-A', context: 'callback' });
    expect(m.selection.removeTenantConnection.mock.calls.map((c) => c[1])).toEqual(['conn-B', 'conn-C']);
    expect(out).toEqual({ removed: 2, kept: 0, failed: 0, skipped: 0, stopped: null });
  });

  it('keeps a tenant another partner holds — Review Focus 2 — and checks in SYSTEM scope', async () => {
    m.store.listHeldTenantKeys.mockResolvedValue({ heldTenantIds: new Set(['ten-B']), heldConnectionRefs: new Set() });
    const out = await releaseUnchosenTenants({ provider: 'xero', accessToken: 'at', tenants: [tenant('A'), tenant('B')], keepConnectionRef: null, context: 'callback' });
    expect(m.selection.removeTenantConnection.mock.calls.map((c) => c[1])).toEqual(['conn-A']);
    expect(out).toEqual({ removed: 1, kept: 1, failed: 0, skipped: 0, stopped: null });
    expect(m.systemCtxCalls).toContain('accountingTenantSelection.heldCheck');
  });

  it('keeps a link whose connection id another row stores', async () => {
    m.store.listHeldTenantKeys.mockResolvedValue({ heldTenantIds: new Set(), heldConnectionRefs: new Set(['conn-A']) });
    await releaseUnchosenTenants({ provider: 'xero', accessToken: 'at', tenants: [tenant('A')], keepConnectionRef: null, context: 'cancel' });
    expect(m.selection.removeTenantConnection).not.toHaveBeenCalled();
  });

  it('removes NOTHING when the held check itself fails (fail closed), and says so distinctly from "held" (review C)', async () => {
    m.store.listHeldTenantKeys.mockRejectedValue(new Error('db down'));
    const out = await releaseUnchosenTenants({ provider: 'xero', accessToken: 'at', tenants: [tenant('A'), tenant('B')], keepConnectionRef: null, context: 'cancel' });
    expect(m.selection.removeTenantConnection).not.toHaveBeenCalled();
    // `kept` counts only links a row HOLDS; links never examined are `skipped`, with the reason.
    expect(out).toEqual({ removed: 0, kept: 0, failed: 0, skipped: 2, stopped: 'held_check_failed' });
  });

  it('re-checks "held" for each link immediately before its DELETE (review A: a claim that commits mid-loop is seen)', async () => {
    const order: string[] = [];
    let claimCommitted = false;
    m.store.listHeldTenantKeys.mockImplementation(async (_db: unknown, _p: unknown, ts: Array<{ tenantId: string }>) => {
      order.push(`held:${ts.map((x) => x.tenantId).join(',')}`);
      // Another partner's claim of ten-B commits after the loop has started.
      return claimCommitted
        ? { heldTenantIds: new Set(['ten-B']), heldConnectionRefs: new Set() }
        : { heldTenantIds: new Set(), heldConnectionRefs: new Set() };
    });
    m.selection.removeTenantConnection.mockImplementation(async (_at: string, ref: string) => {
      order.push(`delete:${ref}`);
      claimCommitted = true;
    });
    const out = await releaseUnchosenTenants({ provider: 'xero', accessToken: 'at', tenants: [tenant('A'), tenant('B')], keepConnectionRef: null, context: 'select' });
    expect(order).toEqual(['held:ten-A', 'delete:conn-A', 'held:ten-B']);
    expect(out).toEqual({ removed: 1, kept: 1, failed: 0, skipped: 0, stopped: null });
    // Every check is its own closed system context: none is held across a DELETE.
    expect(m.systemCtxCalls).toEqual(['accountingTenantSelection.heldCheck', 'accountingTenantSelection.heldCheck']);
  });

  it('stops issuing DELETEs after a throttle; the rest are reported as not released (review B)', async () => {
    m.selection.removeTenantConnection.mockRejectedValueOnce(new AccountingProviderError({
      kind: 'rate_limited', provider: 'xero', operation: 'Xero connection delete', message: '429', retryAfterMs: 30_000,
    }));
    const out = await releaseUnchosenTenants({ provider: 'xero', accessToken: 'at', tenants: [tenant('A'), tenant('B'), tenant('C')], keepConnectionRef: null, context: 'cancel' });
    expect(m.selection.removeTenantConnection).toHaveBeenCalledTimes(1);
    expect(out).toEqual({ removed: 0, kept: 0, failed: 1, skipped: 2, stopped: 'rate_limited' });
  });

  it('a failed DELETE is counted and never thrown', async () => {
    m.selection.removeTenantConnection.mockRejectedValueOnce(new Error('503'));
    await expect(releaseUnchosenTenants({ provider: 'xero', accessToken: 'at', tenants: [tenant('A'), tenant('B')], keepConnectionRef: null, context: 'cancel' }))
      .resolves.toEqual({ removed: 1, kept: 0, failed: 1, skipped: 0, stopped: null });
  });

  it('a genuine (non-throttle) DELETE failure is Sentry-captured', async () => {
    m.selection.removeTenantConnection.mockRejectedValueOnce(new Error('503'));
    await releaseUnchosenTenants({ provider: 'xero', accessToken: 'at', tenants: [tenant('A'), tenant('B')], keepConnectionRef: null, context: 'cancel' });
    expect(captureException).toHaveBeenCalledTimes(1);
  });

  it('a throttled DELETE failure stays warn-only (no Sentry capture)', async () => {
    m.selection.removeTenantConnection.mockRejectedValueOnce(new AccountingProviderError({
      kind: 'rate_limited', provider: 'xero', operation: 'Xero connection delete', retryAfterMs: 30_000,
    }));
    await releaseUnchosenTenants({ provider: 'xero', accessToken: 'at', tenants: [tenant('A'), tenant('B'), tenant('C')], keepConnectionRef: null, context: 'cancel' });
    expect(captureException).not.toHaveBeenCalled();
  });
});

describe('loadPendingGrant', () => {
  it('lists this auth event\'s tenants with the ORIGINAL token', async () => {
    m.store.loadPendingTenantRow.mockResolvedValue(pendingRow());
    m.selection.listGrantTenants.mockResolvedValue([tenant('A'), tenant('P', 'PRACTICEMANAGER')]);
    const grant = await loadPendingGrant('p1', 'xero', runner);
    expect(m.selection.authEventIdOf).toHaveBeenCalledWith('ORIGINAL-at');
    expect(m.selection.listGrantTenants).toHaveBeenCalledWith('ORIGINAL-at', 'evt-1');
    expect(grant.tenants).toHaveLength(2);
    // Captured BEFORE the HTTP lookup, from the row's own refresh token — the claim compares it.
    expect(grant.grantFingerprint).toBe('fp:rt');
  });

  it.each([
    ['no pending row', () => m.store.loadPendingTenantRow.mockResolvedValue(null), 'no_pending_selection', 404],
    ['token inside the 60s margin', () => m.store.loadPendingTenantRow.mockResolvedValue(pendingRow({ accessTokenExpiresAt: new Date(Date.now() + 30_000) })), 'tenant_selection_expired', 409],
    ['no refresh token (no grant identity)', () => m.store.loadPendingTenantRow.mockResolvedValue(pendingRow({ refreshToken: null })), 'tenant_selection_expired', 409],
    ['claim missing', () => { m.store.loadPendingTenantRow.mockResolvedValue(pendingRow()); m.selection.authEventIdOf.mockReturnValue(null); }, 'auth_event_missing', 409],
  ])('%s → %s', async (_label, arrange, code, status) => {
    arrange();
    const err = await loadPendingGrant('p1', 'xero', runner).catch((e) => e);
    expect(err).toBeInstanceOf(AccountingTenantSelectionError);
    expect(err).toMatchObject({ code, status });
    expect(m.selection.listGrantTenants).not.toHaveBeenCalled();
  });
});

describe('discardPendingTenantSelection (cancel + reaper)', () => {
  it('deletes the row FIRST, then removes every same-authEvent link not held', async () => {
    const order: string[] = [];
    m.store.deletePendingTenantRow.mockImplementation(async () => { order.push('delete-row'); return { id: 'row-1', accessToken: 'ORIGINAL-at', refreshToken: 'rt', accessTokenExpiresAt: new Date(Date.now() + 20 * 60_000) }; });
    m.selection.listGrantTenants.mockImplementation(async () => { order.push('list'); return [tenant('A'), tenant('B')]; });
    await expect(discardPendingTenantSelection({ partnerId: 'p1', provider: 'xero', reason: 'cancel', runInDbContext: runner })).resolves.toEqual({ discarded: true });
    expect(order).toEqual(['delete-row', 'list']);
    expect(m.selection.removeTenantConnection).toHaveBeenCalledTimes(2);
  });

  it('refreshes an expired token for cleanup but decodes the auth event from the ORIGINAL token', async () => {
    m.store.deletePendingTenantRow.mockResolvedValue({ id: 'row-1', accessToken: 'ORIGINAL-at', refreshToken: 'rt', accessTokenExpiresAt: new Date(Date.now() - 1) });
    m.refresh.mockResolvedValue({ accessToken: 'FRESH-at' });
    m.selection.listGrantTenants.mockResolvedValue([tenant('A')]);
    await discardPendingTenantSelection({ partnerId: 'p1', provider: 'xero', reason: 'reaped', runInDbContext: runner });
    expect(m.selection.authEventIdOf).toHaveBeenCalledWith('ORIGINAL-at');
    expect(m.selection.listGrantTenants).toHaveBeenCalledWith('FRESH-at', 'evt-1');
  });

  it('nothing to discard → discarded false, no HTTP', async () => {
    m.store.deletePendingTenantRow.mockResolvedValue(null);
    await expect(discardPendingTenantSelection({ partnerId: 'p1', provider: 'xero', reason: 'cancel', runInDbContext: runner })).resolves.toEqual({ discarded: false });
    expect(m.selection.listGrantTenants).not.toHaveBeenCalled();
  });

  it('an original token with no auth-event claim: row discarded, nothing listed or deleted (never an unfiltered read) (review N)', async () => {
    m.store.deletePendingTenantRow.mockResolvedValue({ id: 'row-1', accessToken: 'ORIGINAL-at', refreshToken: 'rt', accessTokenExpiresAt: new Date(Date.now() + 20 * 60_000) });
    m.selection.authEventIdOf.mockReturnValue(null);
    await expect(discardPendingTenantSelection({ partnerId: 'p1', provider: 'xero', reason: 'cancel', runInDbContext: runner })).resolves.toEqual({ discarded: true });
    expect(m.selection.listGrantTenants).not.toHaveBeenCalled();
    expect(m.selection.listAllTenants).not.toHaveBeenCalled();
    expect(m.selection.removeTenantConnection).not.toHaveBeenCalled();
    expect(m.refresh).not.toHaveBeenCalled();
  });

  it('a remote failure never undoes the discard', async () => {
    m.store.deletePendingTenantRow.mockResolvedValue({ id: 'row-1', accessToken: 'ORIGINAL-at', refreshToken: 'rt', accessTokenExpiresAt: new Date(Date.now() + 20 * 60_000) });
    m.selection.listGrantTenants.mockRejectedValue(new Error('xero down'));
    await expect(discardPendingTenantSelection({ partnerId: 'p1', provider: 'xero', reason: 'cancel', runInDbContext: runner })).resolves.toEqual({ discarded: true });
  });

  it('a genuine (non-throttle) remote cleanup failure is Sentry-captured', async () => {
    m.store.deletePendingTenantRow.mockResolvedValue({ id: 'row-1', accessToken: 'ORIGINAL-at', refreshToken: 'rt', accessTokenExpiresAt: new Date(Date.now() + 20 * 60_000) });
    m.selection.listGrantTenants.mockRejectedValue(new Error('xero down'));
    await discardPendingTenantSelection({ partnerId: 'p1', provider: 'xero', reason: 'cancel', runInDbContext: runner });
    expect(captureException).toHaveBeenCalledTimes(1);
  });

  it('a throttled remote cleanup failure stays warn-only (no Sentry capture)', async () => {
    m.store.deletePendingTenantRow.mockResolvedValue({ id: 'row-1', accessToken: 'ORIGINAL-at', refreshToken: 'rt', accessTokenExpiresAt: new Date(Date.now() + 20 * 60_000) });
    m.selection.listGrantTenants.mockRejectedValue(new AccountingProviderError({
      kind: 'rate_limited', provider: 'xero', operation: 'listGrantTenants', retryAfterMs: 30_000,
    }));
    await discardPendingTenantSelection({ partnerId: 'p1', provider: 'xero', reason: 'cancel', runInDbContext: runner });
    expect(captureException).not.toHaveBeenCalled();
  });
});

describe('reapStalePendingTenants', () => {
  it('discards every row older than 1 hour, each in its own system context, and survives one failure', async () => {
    const now = new Date('2026-10-01T12:00:00Z');
    m.store.listStalePendingTenantConnections.mockResolvedValue([
      { id: 'r1', partnerId: 'p1', provider: 'xero' }, { id: 'r2', partnerId: 'p2', provider: 'xero' },
    ]);
    m.store.deletePendingTenantRow
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValueOnce({ id: 'r2', accessToken: null, refreshToken: null, accessTokenExpiresAt: null });
    await expect(reapStalePendingTenants(now)).resolves.toEqual({ stale: 2, reaped: 1 });
    expect(m.store.listStalePendingTenantConnections).toHaveBeenCalledWith(expect.anything(), new Date('2026-10-01T11:00:00Z'));
    expect(m.store.deletePendingTenantRow).toHaveBeenLastCalledWith(expect.anything(), expect.objectContaining({ connectionId: 'r2', olderThan: new Date('2026-10-01T11:00:00Z') }));
    // One system context for the listing, then one per reaped row (review M).
    expect(m.systemCtxCalls).toEqual([
      'accountingTenantSelection.reap.list', 'accountingTenantSelection.reap', 'accountingTenantSelection.reap',
    ]);
  });
});
