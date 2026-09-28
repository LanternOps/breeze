/**
 * Unit coverage for the store's decrypt handling only (review D). Its SQL
 * semantics are proven against real Postgres in
 * __tests__/integration/accountingXeroConnection.integration.test.ts.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../secretCrypto', () => ({
  decryptSecret: vi.fn(() => { throw new Error('Malformed encrypted secret'); }),
  encryptSecret: (v: string) => `enc:${v}`,
  hmacFingerprint: (v: string) => `fp:${v}`,
}));
vi.mock('../sentry', () => ({ captureException: vi.fn() }));

import { claimPendingTenant, deletePendingTenantRow } from './accountingTenantSelectionStore';
import { captureException } from '../sentry';
import { accountingConnections, accountingEntityMappings } from '../../db/schema';

const CIPHER = 'v3:CIPHERTEXT-MUST-NOT-BE-LOGGED';

afterEach(() => { vi.restoreAllMocks(); vi.clearAllMocks(); });

describe('undecryptable token ciphertext is reported, never silent, never logged (review D)', () => {
  it('claim: a refresh token that cannot be decrypted → grant_superseded, with a warning naming the row and provider', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const dbc = {
      select: () => ({ from: () => ({ where: () => ({ limit: () => ({
        for: async () => [{ status: 'pending_tenant', refreshTokenEncrypted: CIPHER }],
      }) }) }) }),
      update: vi.fn(),
    };
    const out = await claimPendingTenant(dbc as never, {
      connectionId: 'row-1', partnerId: 'p1', provider: 'xero', realmId: 'ten-A', providerConnectionRef: 'conn-A',
      resetRealmFacts: false, grantFingerprint: 'fp:whatever',
    });
    expect(out).toEqual({ kind: 'grant_superseded' });
    expect(dbc.update).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('could not decrypt'),
      expect.objectContaining({ connectionId: 'row-1', provider: 'xero', field: 'refresh_token' }),
    );
    expect(JSON.stringify(warn.mock.calls)).not.toContain('CIPHERTEXT');
    expect(captureException).toHaveBeenCalledTimes(1);
  });

  it('discard: undecryptable tokens → null tokens (no remote cleanup), with a warning per field', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const dbc = {
      select: () => ({ from: (table: unknown) => ({ where: () => (table === accountingConnections
        ? { limit: () => ({ for: async () => [{ id: 'row-2' }] }) }
        : Promise.resolve([])) }) }),
      delete: () => ({ where: () => ({
        returning: async () => [{ id: 'row-2', accessTokenEncrypted: CIPHER, refreshTokenEncrypted: CIPHER, accessTokenExpiresAt: null }],
      }) }),
    };
    const out = await deletePendingTenantRow(dbc as never, { partnerId: 'p1', provider: 'xero', reason: 'cancel' });
    expect(out).toEqual({
      kind: 'deleted', id: 'row-2', accessToken: null, refreshToken: null, accessTokenExpiresAt: null,
      owedPaymentDeletes: { count: 0, remoteEntityIds: [] },
    });
    const fields = warn.mock.calls.map((call) => (call[1] as { field?: string }).field);
    expect(fields.sort()).toEqual(['access_token', 'refresh_token']);
    for (const call of warn.mock.calls) {
      expect(call[1]).toMatchObject({ connectionId: 'row-2', provider: 'xero' });
    }
    expect(JSON.stringify(warn.mock.calls)).not.toContain('CIPHERTEXT');
    expect(captureException).toHaveBeenCalledTimes(2);
  });
});

/**
 * #7289: a RE-PARKED former `connected` row can carry accounting_entity_mappings,
 * and ON DELETE CASCADE takes them with the row. The owed payment deletes among
 * them must get the same count / warn / Sentry treatment as `deleteConnection`,
 * read BEFORE the delete, and the unattended reaper must keep such a row rather
 * than discard the debt.
 */
describe('owed payment deletes on a re-parked pending row (#7289)', () => {
  const OWED = [
    { id: 'map-1', remoteEntityId: 'P-181/INV-145' },
    { id: 'map-2', remoteEntityId: 'P-182/INV-146' },
  ];

  function fakeDb(opts: { locked: Array<{ id: string }>; owed: Array<{ id: string; remoteEntityId: string | null }> }) {
    const order: string[] = [];
    const dbc = {
      select: () => ({
        from: (table: unknown) => ({
          where: () => {
            if (table === accountingConnections) {
              return { limit: () => ({ for: async (mode: string) => { order.push(`lock:${mode}`); return opts.locked; } }) };
            }
            if (table === accountingEntityMappings) {
              order.push('read-owed');
              return Promise.resolve(opts.owed);
            }
            throw new Error('unexpected table');
          },
        }),
      }),
      delete: vi.fn(() => ({ where: () => ({
        returning: async () => {
          order.push('delete');
          return [{ id: 'row-3', accessTokenEncrypted: null, refreshTokenEncrypted: null, accessTokenExpiresAt: null }];
        },
      }) })),
    };
    return { dbc, order };
  }

  it('cancel of a row with owed deletes: counts them BEFORE the delete, warns, captures, and returns the count', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { dbc, order } = fakeDb({ locked: [{ id: 'row-3' }], owed: OWED });
    const out = await deletePendingTenantRow(dbc as never, { partnerId: 'p1', provider: 'xero', reason: 'cancel' });
    expect(out).toEqual({
      kind: 'deleted', id: 'row-3', accessToken: null, refreshToken: null, accessTokenExpiresAt: null,
      owedPaymentDeletes: { count: 2, remoteEntityIds: ['P-181/INV-145', 'P-182/INV-146'] },
    });
    expect(order).toEqual(['lock:update', 'read-owed', 'delete']);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('owed QuickBooks payment delete'),
      expect.objectContaining({ connectionId: 'row-3', partnerId: 'p1', provider: 'xero', reason: 'pending_tenant_cancel', count: 2 }),
    );
    expect(captureException).toHaveBeenCalledTimes(1);
  });

  it('a pending row with no mappings is unchanged: no warn, no capture, count 0', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { dbc, order } = fakeDb({ locked: [{ id: 'row-3' }], owed: [] });
    const out = await deletePendingTenantRow(dbc as never, { partnerId: 'p1', provider: 'xero', reason: 'cancel' });
    expect(out).toMatchObject({ kind: 'deleted', id: 'row-3', owedPaymentDeletes: { count: 0, remoteEntityIds: [] } });
    expect(order).toEqual(['lock:update', 'read-owed', 'delete']);
    expect(warn).not.toHaveBeenCalled();
    expect(captureException).not.toHaveBeenCalled();
  });

  it('reaper: a row that owes payment deletes is KEPT — no delete, no discard warning (the caller reports the refusal)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { dbc, order } = fakeDb({ locked: [{ id: 'row-3' }], owed: OWED });
    const out = await deletePendingTenantRow(dbc as never, {
      partnerId: 'p1', provider: 'xero', connectionId: 'row-3', olderThan: new Date(), reason: 'reaped', keepIfOwedPaymentDeletes: true,
    });
    expect(out).toEqual({
      kind: 'kept_owed_payment_deletes', id: 'row-3',
      owedPaymentDeletes: { count: 2, remoteEntityIds: ['P-181/INV-145', 'P-182/INV-146'] },
    });
    expect(dbc.delete).not.toHaveBeenCalled();
    expect(order).toEqual(['lock:update', 'read-owed']);
    expect(warn).not.toHaveBeenCalled();
    expect(captureException).not.toHaveBeenCalled();
  });

  it('reaper: a row that owes nothing is still reaped', async () => {
    const { dbc, order } = fakeDb({ locked: [{ id: 'row-3' }], owed: [] });
    const out = await deletePendingTenantRow(dbc as never, {
      partnerId: 'p1', provider: 'xero', connectionId: 'row-3', olderThan: new Date(), reason: 'reaped', keepIfOwedPaymentDeletes: true,
    });
    expect(out).toMatchObject({ kind: 'deleted', id: 'row-3' });
    expect(order).toEqual(['lock:update', 'read-owed', 'delete']);
  });

  it('no matching pending row → null, nothing counted or deleted', async () => {
    const { dbc, order } = fakeDb({ locked: [], owed: OWED });
    expect(await deletePendingTenantRow(dbc as never, { partnerId: 'p1', provider: 'xero', reason: 'cancel' })).toBeNull();
    expect(order).toEqual(['lock:update']);
    expect(dbc.delete).not.toHaveBeenCalled();
  });
});
