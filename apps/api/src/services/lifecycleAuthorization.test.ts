import { describe, expect, it, vi } from 'vitest';
import { organizationUsers, organizations, partnerUsers, users } from '../db/schema';
import { authorizeOrganizationLifecycleWrite } from './lifecycleAuthorization';

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

const target = { id: 'org-1', partnerId: 'partner-1' };

describe('authorizeOrganizationLifecycleWrite', () => {
  it('denies an organization actor after its exact live membership is removed', async () => {
    const tx = transactionWithRows(new Map([
      [organizations, [target]],
      [organizationUsers, []],
    ]));

    await expect(authorizeOrganizationLifecycleWrite(tx, {
      scope: 'organization',
      userId: 'user-1',
      partnerId: target.partnerId,
      orgId: target.id,
    }, target.id)).resolves.toEqual({ authorized: false });
  });

  it.each([
    ['none', null],
    ['selected', ['org-2']],
  ] as const)('denies changed partner orgAccess=%s', async (orgAccess, orgIds) => {
    const tx = transactionWithRows(new Map([
      [organizations, [target]],
      [partnerUsers, [{ id: 'membership-1', orgAccess, orgIds }]],
    ]));

    await expect(authorizeOrganizationLifecycleWrite(tx, {
      scope: 'partner',
      userId: 'user-1',
      partnerId: target.partnerId,
      orgId: null,
    }, target.id)).resolves.toEqual({ authorized: false });
  });

  it.each([
    ['all', null],
    ['selected', ['org-2', target.id]],
  ] as const)('allows live partner orgAccess=%s', async (orgAccess, orgIds) => {
    const tx = transactionWithRows(new Map([
      [organizations, [target]],
      [partnerUsers, [{ id: 'membership-1', orgAccess, orgIds }]],
    ]));

    await expect(authorizeOrganizationLifecycleWrite(tx, {
      scope: 'partner',
      userId: 'user-1',
      partnerId: target.partnerId,
      orgId: null,
    }, target.id)).resolves.toEqual({
      authorized: true,
      targetPartnerId: target.partnerId,
    });
  });

  it('allows a live organization membership for the exact target', async () => {
    const tx = transactionWithRows(new Map([
      [organizations, [target]],
      [organizationUsers, [{ id: 'membership-1' }]],
    ]));

    await expect(authorizeOrganizationLifecycleWrite(tx, {
      scope: 'organization',
      userId: 'user-1',
      partnerId: target.partnerId,
      orgId: target.id,
    }, target.id)).resolves.toEqual({
      authorized: true,
      targetPartnerId: target.partnerId,
    });
  });

  it('requires current active platform-admin authority for system actors', async () => {
    const authorizedTx = transactionWithRows(new Map([
      [organizations, [target]],
      [users, [{ id: 'platform-admin' }]],
    ]));
    const unauthorizedTx = transactionWithRows(new Map([
      [organizations, [target]],
      [users, []],
    ]));
    const actor = {
      scope: 'system' as const,
      userId: 'platform-admin',
      partnerId: null,
      orgId: null,
    };

    await expect(authorizeOrganizationLifecycleWrite(authorizedTx, actor, target.id)).resolves.toEqual({
      authorized: true,
      targetPartnerId: target.partnerId,
    });
    await expect(authorizeOrganizationLifecycleWrite(unauthorizedTx, actor, target.id)).resolves.toEqual({
      authorized: false,
    });
  });

  it('rejects a system actor carrying synthetic tenant fields without consulting admin authority', async () => {
    const tx = transactionWithRows(new Map([
      [organizations, [target]],
      [users, [{ id: 'platform-admin' }]],
    ]));

    await expect(authorizeOrganizationLifecycleWrite(tx, {
      scope: 'system',
      userId: 'platform-admin',
      partnerId: target.partnerId,
      orgId: target.id,
    }, target.id)).resolves.toEqual({ authorized: false });
  });
});
