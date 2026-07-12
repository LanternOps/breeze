import { describe, expect, it, vi } from 'vitest';
import {
  organizationUsers,
  partnerUsers,
  userPasskeys,
  userSsoIdentities,
  users,
} from '../db/schema';
import { findExistingInviteUser } from './inviteUserReuse';

function transactionWithRows(rows: Map<unknown, unknown[]>) {
  return {
    select: vi.fn(() => ({
      from: vi.fn((table: unknown) => ({
        where: vi.fn(() => ({
          limit: vi.fn(async () => rows.get(table) ?? []),
        })),
      })),
    })),
  } as any;
}

const removedTombstone = {
  id: '11111111-1111-4111-8111-111111111111',
  partnerId: '22222222-2222-4222-8222-222222222222',
  email: 'removed@example.com',
  status: 'disabled',
  passwordHash: null,
  disabledReason: 'removed',
};

describe('findExistingInviteUser', () => {
  it('blocks a manually disabled SSO-only account without removal provenance', async () => {
    const manualUser = { ...removedTombstone, disabledReason: null };
    const tx = transactionWithRows(new Map<unknown, unknown[]>([
      [users, [manualUser]],
      [userSsoIdentities, [{ id: 'identity-1' }]],
    ]));

    await expect(findExistingInviteUser(tx, manualUser.email, 'new-partner')).resolves.toEqual({
      kind: 'blocked',
      user: null,
    });
  });

  it('blocks a removed user that still has a tenant membership', async () => {
    const tx = transactionWithRows(new Map<unknown, unknown[]>([
      [users, [removedTombstone]],
      [partnerUsers, [{ id: 'membership-1' }]],
    ]));

    await expect(findExistingInviteUser(tx, removedTombstone.email, 'new-partner')).resolves.toEqual({
      kind: 'blocked',
      user: null,
    });
  });

  it('blocks a removed user that retains an SSO identity', async () => {
    const tx = transactionWithRows(new Map<unknown, unknown[]>([
      [users, [removedTombstone]],
      [userSsoIdentities, [{ id: 'identity-1' }]],
    ]));

    await expect(findExistingInviteUser(tx, removedTombstone.email, 'new-partner')).resolves.toEqual({
      kind: 'blocked',
      user: null,
    });
  });

  it('blocks a removed user that retains a passkey authenticator', async () => {
    const tx = transactionWithRows(new Map<unknown, unknown[]>([
      [users, [removedTombstone]],
      [userPasskeys, [{ id: 'passkey-1' }]],
    ]));

    await expect(findExistingInviteUser(tx, removedTombstone.email, 'new-partner')).resolves.toEqual({
      kind: 'blocked',
      user: null,
    });
  });

  it('blocks an otherwise-clean removed platform-admin tombstone', async () => {
    const platformAdmin = { ...removedTombstone, isPlatformAdmin: true };
    const tx = transactionWithRows(new Map<unknown, unknown[]>([
      [users, [platformAdmin]],
      [partnerUsers, []],
      [organizationUsers, []],
      [userSsoIdentities, []],
      [userPasskeys, []],
    ]));

    await expect(findExistingInviteUser(tx, platformAdmin.email, 'new-partner')).resolves.toEqual({
      kind: 'blocked',
      user: null,
    });
  });

  it('reuses only a removed orphan with no memberships or external authenticators', async () => {
    const tx = transactionWithRows(new Map<unknown, unknown[]>([
      [users, [removedTombstone]],
      [partnerUsers, []],
      [organizationUsers, []],
      [userSsoIdentities, []],
      [userPasskeys, []],
    ]));

    await expect(findExistingInviteUser(tx, removedTombstone.email, 'new-partner')).resolves.toEqual({
      kind: 'reusable',
      user: removedTombstone,
    });
  });
});
