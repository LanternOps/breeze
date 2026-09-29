import { describe, expect, it, vi } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';
import {
  admitPartnerDeviceCapacity,
  previewPartnerDeviceCapacity,
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

  it('leaves devices parked in a holding org out of the licensed count', async () => {
    const f = transactionFixture({ maxDevices: 5, activeCount: 4 });
    await admitPartnerDeviceCapacity(f.tx, { orgId: 'org-1', expectedPartnerId: 'partner-1' });
    const orgSubquery = new PgDialect().sqlToQuery(f.whereArgs[0] as SQL);
    expect(orgSubquery.sql).toContain('"organizations"."type" <> $');
    expect(orgSubquery.params).toContain('unassigned_pool');
  });

  it('leaves out a device the caller already moved into a counted org', async () => {
    const f = transactionFixture({ maxDevices: 5, activeCount: 4 });
    await admitPartnerDeviceCapacity(f.tx, { orgId: 'org-1', expectedPartnerId: 'partner-1', excludeDeviceId: 'device-9' });
    const count = new PgDialect().sqlToQuery(f.whereArgs[1] as SQL);
    expect(count.sql).toContain('"devices"."id" <> $');
    expect(count.params).toContain('device-9');
  });
});

describe('previewPartnerDeviceCapacity', () => {
  function unlockedFixture(input: { maxDevices: number | null; activeCount: number }) {
    const locks: string[] = [];
    let index = 0;
    const tx = {
      execute: vi.fn(),
      select: vi.fn(() => {
        const i = index++;
        const rows = i === 0 ? [{ partnerId: 'partner-1' }] : i === 1 ? [{ maxDevices: input.maxDevices }] : null;
        if (rows) {
          const limited = Object.assign(Promise.resolve(rows), { for: (mode: string) => { locks.push(mode); return Promise.resolve(rows); } });
          return { from: () => ({ where: () => ({ limit: () => limited }) }) };
        }
        if (i === 2) return { from: () => ({ where: () => ({}) }) };
        return { from: () => ({ where: async () => [{ count: input.activeCount }] }) };
      }),
    };
    return { tx: tx as any, locks };
  }

  it('answers like the admission but takes no row lock and sets no lock timeout', async () => {
    const f = unlockedFixture({ maxDevices: 3, activeCount: 3 });
    await expect(previewPartnerDeviceCapacity(f.tx, { orgId: 'org-1', expectedPartnerId: 'partner-1' }))
      .resolves.toEqual({ allowed: false, partnerId: 'partner-1', maxDevices: 3, activeCount: 3 });
    expect(f.locks).toEqual([]);
    expect(f.tx.execute).not.toHaveBeenCalled();
  });
});
