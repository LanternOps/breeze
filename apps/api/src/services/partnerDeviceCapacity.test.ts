import { describe, expect, it, vi } from 'vitest';
import {
  admitPartnerDeviceCapacity,
} from './partnerDeviceCapacity';

function transactionFixture(input: {
  orgPartnerId?: string | null;
  maxDevices?: number | null;
  activeCount?: number;
}) {
  const calls: string[] = [];
  let selectIndex = 0;
  const whereArgs: unknown[] = [];
  const tx = {
    execute: vi.fn(async () => { calls.push('timeout'); }),
    select: vi.fn(() => {
      const index = selectIndex++;
      if (index === 0) {
        return { from: () => ({ where: () => ({
          limit: () => ({ for: async (mode: string) => {
            calls.push(`org:${mode}`);
            return input.orgPartnerId === null ? [] : [{ partnerId: input.orgPartnerId ?? 'partner-1' }];
          } }),
        }) }) };
      }
      if (index === 1) {
        return { from: () => ({ where: () => ({
          limit: () => ({ for: async (mode: string) => {
            calls.push(`partner:${mode}`);
            return [{ maxDevices: input.maxDevices ?? null }];
          } }),
        }) }) };
      }
      if (index === 2) {
        return { from: () => ({ where: (arg: unknown) => {
          calls.push('org-subquery');
          whereArgs.push(arg);
          return {};
        } }) };
      }
      return { from: () => ({ where: async (arg: unknown) => {
        calls.push('count');
        whereArgs.push(arg);
        return [{ count: input.activeCount ?? 0 }];
      } }) };
    }),
  };
  return { tx: tx as any, calls, whereArgs };
}

describe('admitPartnerDeviceCapacity', () => {
  it('locks the validated org mapping and partner before counting', async () => {
    const f = transactionFixture({ maxDevices: 5, activeCount: 4 });
    await expect(admitPartnerDeviceCapacity(f.tx, {
      orgId: 'org-1', expectedPartnerId: 'partner-1',
    })).resolves.toEqual({
      allowed: true, partnerId: 'partner-1', maxDevices: 5, activeCount: 4,
    });
    expect(f.calls).toEqual(['timeout', 'org:share', 'partner:update', 'org-subquery', 'count']);
    expect(f.whereArgs).toHaveLength(2);
  });

  it('returns a denial under the lock at the live cap', async () => {
    const f = transactionFixture({ maxDevices: 2, activeCount: 2 });
    await expect(admitPartnerDeviceCapacity(f.tx, {
      orgId: 'org-1', expectedPartnerId: 'partner-1',
    })).resolves.toEqual({
      allowed: false, partnerId: 'partner-1', maxDevices: 2, activeCount: 2,
    });
  });

  it('does not count when the locked live cap is null', async () => {
    const f = transactionFixture({ maxDevices: null });
    await expect(admitPartnerDeviceCapacity(f.tx, {
      orgId: 'org-1', expectedPartnerId: 'partner-1',
    })).resolves.toMatchObject({ allowed: true, maxDevices: null, activeCount: null });
    expect(f.calls).toEqual(['timeout', 'org:share', 'partner:update']);
  });

  it('fails closed before the partner lock when org ownership changed', async () => {
    const f = transactionFixture({ orgPartnerId: 'partner-2', maxDevices: 5 });
    await expect(admitPartnerDeviceCapacity(f.tx, {
      orgId: 'org-1', expectedPartnerId: 'partner-1',
    })).rejects.toEqual(expect.objectContaining({
      code: 'ORG_PARTNER_CHANGED',
    }));
    expect(f.calls).toEqual(['timeout', 'org:share']);
  });
});
