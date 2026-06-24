import { describe, expect, it, vi } from 'vitest';
import { decryptSecret } from '../secretCrypto';

function makeMockDb(captured: { row?: any; insertValues?: any; updateSet?: any }) {
  const ID = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
  return {
    insert: vi.fn(() => ({
      values: vi.fn((row: any) => {
        captured.insertValues = row;
        captured.row = {
          id: ID,
          createdAt: new Date('2026-06-23T00:00:00Z'),
          updatedAt: row.updatedAt,
          homeCurrency: null,
          defaultIncomeAccountRef: null,
          defaultTaxCodeRef: null,
          lastError: null,
          ...row,
        };
        return {
          onConflictDoUpdate: vi.fn((arg: any) => {
            captured.updateSet = arg?.set;
            return { returning: vi.fn(async () => [captured.row]) };
          }),
        };
      }),
    })),
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => ({
          limit: vi.fn(async () => captured.row ? [captured.row] : []),
        })),
      })),
    })),
    update: vi.fn(() => ({
      set: vi.fn(() => ({
        where: vi.fn(() => ({
          returning: vi.fn(async () => [{ id: ID }]),
        })),
      })),
    })),
    delete: vi.fn(() => ({
      where: vi.fn(() => ({
        returning: vi.fn(async () => [{ id: ID }]),
      })),
    })),
  };
}

describe('accountingConnectionService', () => {
  it('encrypts tokens on upsert and returns decrypted on read', async () => {
    const captured: { row?: any } = {};
    const db = makeMockDb(captured);
    const { upsertConnection, getConnection } = await import('./accountingConnectionService');

    await upsertConnection(db, '11111111-1111-1111-1111-111111111111', 'quickbooks', {
      realmId: 'realm-123',
      accessToken: 'at-secret',
      refreshToken: 'rt-secret',
      accessTokenExpiresAt: new Date('2026-06-23T01:00:00Z'),
      refreshTokenExpiresAt: new Date('2026-09-30T00:00:00Z'),
      environment: 'production',
    });

    expect(captured.row?.accessTokenEncrypted).not.toBe('at-secret');
    expect(decryptSecret(captured.row?.accessTokenEncrypted)).toBe('at-secret');
    expect(decryptSecret(captured.row?.refreshTokenEncrypted)).toBe('rt-secret');

    const read = await getConnection(db, '11111111-1111-1111-1111-111111111111', 'quickbooks');
    expect(read?.accessToken).toBe('at-secret');
    expect(read?.refreshToken).toBe('rt-secret');
    expect(read?.realmId).toBe('realm-123');
  }, 20_000); // real encryptSecret KDF is ~0.6s/call; guard against CI-load flakiness

  it('reconnect (token-only, as the OAuth callback does) preserves pushMode', async () => {
    const captured: { row?: any; insertValues?: any; updateSet?: any } = {};
    const db = makeMockDb(captured);
    const { upsertConnection } = await import('./accountingConnectionService');

    // Mirrors the callback payload: tokens + environment + status, but NO pushMode.
    await upsertConnection(db, '11111111-1111-1111-1111-111111111111', 'quickbooks', {
      realmId: 'realm-123',
      accessToken: 'at',
      refreshToken: 'rt',
      accessTokenExpiresAt: new Date('2026-06-23T01:00:00Z'),
      refreshTokenExpiresAt: new Date('2026-09-30T00:00:00Z'),
      environment: 'production',
      status: 'connected',
      connectedBy: null,
    });

    // INSERT defaults pushMode for a brand-new row...
    expect(captured.insertValues.pushMode).toBe('auto');
    // ...but the on-conflict UPDATE set must NOT carry pushMode, so reconnecting
    // an existing 'manual' connection does not silently flip it back to 'auto'.
    expect(captured.updateSet).toBeDefined();
    expect('pushMode' in captured.updateSet).toBe(false);
    // Fields the caller DID pass are present on the update.
    expect(captured.updateSet.environment).toBe('production');
    expect(captured.updateSet.accessTokenEncrypted).toBeDefined();
    expect(decryptSecret(captured.updateSet.accessTokenEncrypted)).toBe('at');
  }, 20_000);
});
