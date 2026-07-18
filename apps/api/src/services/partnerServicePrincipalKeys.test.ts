import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import {
  PartnerServicePrincipalKeyError,
  issuePartnerServicePrincipalKey,
  rotatePartnerServicePrincipalKey,
} from './partnerServicePrincipalKeys';

const PARTNER_ID = '11111111-1111-4111-8111-111111111111';
const PRINCIPAL_ID = '22222222-2222-4222-8222-222222222222';
const KEY_ID = '33333333-3333-4333-8333-333333333333';
const USER_ID = '44444444-4444-4444-8444-444444444444';

function makeTx(selectRows: unknown[][]) {
  const inserted: Record<string, unknown>[] = [];
  const updated: Record<string, unknown>[] = [];
  const select = vi.fn(() => ({
    from: vi.fn(() => ({
      where: vi.fn(() => ({
        limit: vi.fn(async () => selectRows.shift() ?? []),
      })),
    })),
  }));
  const insert = vi.fn(() => ({
    values: vi.fn((value: Record<string, unknown>) => {
      inserted.push(value);
      return {
        returning: vi.fn(async () => [{ id: '55555555-5555-4555-8555-555555555555', ...value }]),
      };
    }),
  }));
  const update = vi.fn(() => ({
    set: vi.fn((value: Record<string, unknown>) => {
      updated.push(value);
      return {
        where: vi.fn(() => ({ returning: vi.fn(async () => [{ id: KEY_ID }]) })),
      };
    }),
  }));
  return { tx: { select, insert, update } as any, inserted, updated };
}

describe('service principal key lifecycle', () => {
  it('returns plaintext once while persisting only its SHA-256 hash and masked prefix', async () => {
    const { tx, inserted } = makeTx([[
      { id: PRINCIPAL_ID, status: 'active', expiresAt: null },
    ]]);

    const issued = await issuePartnerServicePrincipalKey(tx, {
      partnerServicePrincipalId: PRINCIPAL_ID,
      partnerId: PARTNER_ID,
      name: 'Production',
      actorId: USER_ID,
    });

    expect(issued.rawKey).toMatch(/^brz_sp_[A-Za-z0-9_-]{43}$/);
    expect(issued.rawKey.startsWith(issued.keyPrefix)).toBe(true);
    expect(inserted[0]).toMatchObject({
      partnerId: PARTNER_ID,
      partnerServicePrincipalId: PRINCIPAL_ID,
      name: 'Production',
      keyPrefix: issued.keyPrefix,
      createdBy: USER_ID,
    });
    expect(inserted[0]?.keyHash).toBe(
      createHash('sha256').update(issued.rawKey).digest('hex'),
    );
    expect(JSON.stringify(inserted[0])).not.toContain(issued.rawKey);
  });

  it.each([
    ['disabled', { status: 'disabled', expiresAt: null }, 'disabled'],
    ['expired', { status: 'active', expiresAt: new Date('2020-01-01') }, 'expired'],
  ])('rejects issuance for a %s principal', async (_name, principal, code) => {
    const { tx } = makeTx([[{ id: PRINCIPAL_ID, ...principal }]]);
    await expect(issuePartnerServicePrincipalKey(tx, {
      partnerServicePrincipalId: PRINCIPAL_ID,
      partnerId: PARTNER_ID,
      name: 'Production',
      actorId: USER_ID,
    })).rejects.toMatchObject({ code });
  });

  it('rejects a key expiry in the past', async () => {
    const { tx } = makeTx([[{ id: PRINCIPAL_ID, status: 'active', expiresAt: null }]]);
    await expect(issuePartnerServicePrincipalKey(tx, {
      partnerServicePrincipalId: PRINCIPAL_ID,
      partnerId: PARTNER_ID,
      name: 'Expired',
      actorId: USER_ID,
      expiresAt: new Date('2020-01-01'),
    })).rejects.toBeInstanceOf(PartnerServicePrincipalKeyError);
  });

  it('rotates by inserting a successor and revoking the predecessor in the same transaction', async () => {
    const { tx, inserted, updated } = makeTx([
      [{ id: PRINCIPAL_ID, status: 'active', expiresAt: null }],
      [{
        id: KEY_ID,
        name: 'Production',
        status: 'active',
        expiresAt: null,
        rateLimit: 600,
      }],
    ]);

    const rotated = await rotatePartnerServicePrincipalKey(tx, {
      partnerServicePrincipalId: PRINCIPAL_ID,
      keyId: KEY_ID,
      partnerId: PARTNER_ID,
      actorId: USER_ID,
    });

    expect(rotated.rawKey).toMatch(/^brz_sp_/);
    expect(inserted[0]).toMatchObject({ rotatedFromId: KEY_ID, name: 'Production' });
    expect(updated[0]).toMatchObject({ status: 'revoked' });
    expect(updated[0]?.revokedAt).toBeInstanceOf(Date);
  });

  it('does not rotate a key owned by another partner', async () => {
    const { tx, inserted } = makeTx([
      [{ id: PRINCIPAL_ID, status: 'active', expiresAt: null }],
      [],
    ]);
    await expect(rotatePartnerServicePrincipalKey(tx, {
      partnerServicePrincipalId: PRINCIPAL_ID,
      keyId: KEY_ID,
      partnerId: PARTNER_ID,
      actorId: USER_ID,
    })).rejects.toMatchObject({ code: 'not_found' });
    expect(inserted).toHaveLength(0);
  });

  it('leaves no active successor when a concurrent revoke wins the conditional update', async () => {
    const committed: Record<string, unknown>[] = [];
    const attempted: Record<string, unknown>[] = [];
    const transaction = async <T>(callback: (tx: any) => Promise<T>): Promise<T> => {
      const staged: Record<string, unknown>[] = [];
      const selectRows = [
        [{ id: PRINCIPAL_ID, status: 'active', expiresAt: null }],
        [{ id: KEY_ID, name: 'Production', status: 'active', expiresAt: null, rateLimit: 600 }],
      ];
      const tx = {
        select: vi.fn(() => ({ from: vi.fn(() => ({ where: vi.fn(() => ({ limit: vi.fn(async () => selectRows.shift() ?? []) })) })) })),
        insert: vi.fn(() => ({ values: vi.fn((value: Record<string, unknown>) => ({
          returning: vi.fn(async () => { attempted.push(value); staged.push(value); return [{ id: 'successor-id' }]; }),
        })) })),
        update: vi.fn(() => ({ set: vi.fn(() => ({ where: vi.fn(() => ({ returning: vi.fn(async () => []) })) })) })),
      };
      try {
        const result = await callback(tx);
        committed.push(...staged);
        return result;
      } catch (error) {
        throw error;
      }
    };

    await expect(transaction((tx) => rotatePartnerServicePrincipalKey(tx, {
      partnerServicePrincipalId: PRINCIPAL_ID,
      keyId: KEY_ID,
      partnerId: PARTNER_ID,
      actorId: USER_ID,
    }))).rejects.toMatchObject({ code: 'conflict' });
    expect(attempted).toHaveLength(1);
    expect(committed).toEqual([]);
  });
});
