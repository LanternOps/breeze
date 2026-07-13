import { describe, expect, it, vi } from 'vitest';
import {
  organizationUsers,
  organizations,
  partners,
  partnerUsers,
  refreshTokenFamilies,
  users,
} from '../db/schema';
import { lockPartnerLifecycleRows } from './partnerLifecycleLock';

describe('lockPartnerLifecycleRows', () => {
  it('locks sorted users, then sorted active families, then the partner row', async () => {
    const events: string[] = [];
    let userSelectCount = 0;
    const tx = {
      select: vi.fn().mockReturnValue({
        from: vi.fn((table: unknown) => {
          if (table === organizations) {
            return { where: vi.fn().mockResolvedValue([{ id: 'org-1' }]) };
          }
          if (table === partnerUsers) {
            return { where: vi.fn().mockResolvedValue([
              { userId: '00000000-0000-4000-8000-000000000003' },
            ]) };
          }
          if (table === organizationUsers) {
            return { where: vi.fn().mockResolvedValue([
              { userId: '00000000-0000-4000-8000-000000000001' },
            ]) };
          }
          if (table === users) {
            userSelectCount += 1;
            if (userSelectCount === 1) {
              return { where: vi.fn().mockResolvedValue([
                { id: '00000000-0000-4000-8000-000000000002', isPlatformAdmin: false },
              ]) };
            }
            return {
              where: vi.fn().mockReturnValue({
                orderBy: vi.fn().mockReturnValue({
                  for: vi.fn(async () => {
                    events.push('users');
                    return [
                      { id: '00000000-0000-4000-8000-000000000001', isPlatformAdmin: false },
                      { id: '00000000-0000-4000-8000-000000000002', isPlatformAdmin: false },
                      { id: '00000000-0000-4000-8000-000000000003', isPlatformAdmin: true },
                    ];
                  }),
                }),
              }),
            };
          }
          if (table === refreshTokenFamilies) {
            return {
              where: vi.fn().mockReturnValue({
                orderBy: vi.fn().mockReturnValue({
                  for: vi.fn(async () => {
                    events.push('families');
                    return [{ familyId: '10000000-0000-4000-8000-000000000001' }];
                  }),
                }),
              }),
            };
          }
          if (table === partners) {
            return {
              where: vi.fn().mockReturnValue({
                limit: vi.fn().mockReturnValue({
                  for: vi.fn(async () => {
                    events.push('partner');
                    return [{
                      id: 'partner-1',
                      status: 'pending',
                      emailVerifiedAt: null,
                      paymentMethodAttachedAt: null,
                    }];
                  }),
                }),
              }),
            };
          }
          throw new Error('unexpected table');
        }),
      }),
    } as any;

    await expect(lockPartnerLifecycleRows(tx, 'partner-1')).resolves.toMatchObject({
      orgIds: ['org-1'],
      userIds: [
        '00000000-0000-4000-8000-000000000001',
        '00000000-0000-4000-8000-000000000002',
        '00000000-0000-4000-8000-000000000003',
      ],
      partner: { id: 'partner-1', status: 'pending' },
    });
    expect(events).toEqual(['users', 'families', 'partner']);
  });
});
