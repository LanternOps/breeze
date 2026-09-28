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

import { claimPendingTenant, deletePendingTenantRow } from './accountingTenantSelectionStore';

const CIPHER = 'v3:CIPHERTEXT-MUST-NOT-BE-LOGGED';

afterEach(() => { vi.restoreAllMocks(); });

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
  });

  it('discard: undecryptable tokens → null tokens (no remote cleanup), with a warning per field', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const dbc = {
      delete: () => ({ where: () => ({
        returning: async () => [{ id: 'row-2', accessTokenEncrypted: CIPHER, refreshTokenEncrypted: CIPHER, accessTokenExpiresAt: null }],
      }) }),
    };
    const out = await deletePendingTenantRow(dbc as never, { partnerId: 'p1', provider: 'xero' });
    expect(out).toEqual({ id: 'row-2', accessToken: null, refreshToken: null, accessTokenExpiresAt: null });
    const fields = warn.mock.calls.map((call) => (call[1] as { field?: string }).field);
    expect(fields.sort()).toEqual(['access_token', 'refresh_token']);
    for (const call of warn.mock.calls) {
      expect(call[1]).toMatchObject({ connectionId: 'row-2', provider: 'xero' });
    }
    expect(JSON.stringify(warn.mock.calls)).not.toContain('CIPHERTEXT');
  });
});
