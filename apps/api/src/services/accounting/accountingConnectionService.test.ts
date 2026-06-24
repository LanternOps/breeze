import { describe, expect, it, vi } from 'vitest';
import { decryptSecret } from '../secretCrypto';

function makeMockDb(captured: { row?: any }) {
  return {
    insert: vi.fn(() => ({
      values: vi.fn((row: any) => {
        captured.row = {
          id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
          createdAt: new Date('2026-06-23T00:00:00Z'),
          updatedAt: row.updatedAt,
          homeCurrency: null,
          defaultIncomeAccountRef: null,
          defaultTaxCodeRef: null,
          lastError: null,
          ...row,
        };
        return {
          onConflictDoUpdate: vi.fn(() => ({
            returning: vi.fn(async () => [captured.row]),
          })),
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
        where: vi.fn(async () => undefined),
      })),
    })),
    delete: vi.fn(() => ({
      where: vi.fn(async () => undefined),
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
  });
});
