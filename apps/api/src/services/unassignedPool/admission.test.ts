import { describe, expect, it, vi } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';
import { admitParkedEnrollment, declareParkedDeviceAdmission, ParkedCapReachedError } from './admission';
import { PARKED_DEVICES_PER_PARTNER_MAX } from './limits';

describe('declareParkedDeviceAdmission', () => {
  it('sets the admission declaration transaction-locally (is_local = true)', async () => {
    const execute = vi.fn(async (_query: SQL) => undefined);
    await declareParkedDeviceAdmission({ execute });
    expect(execute).toHaveBeenCalledTimes(1);
    const rendered = new PgDialect().sqlToQuery(execute.mock.calls[0]![0]);
    expect(rendered.sql).toMatch(/^select set_config\(\$1, \$2, true\)$/i);
    expect(rendered.params).toEqual(['breeze.parked_device_admission', 'enrollment']);
  });
});

describe('admitParkedEnrollment', () => {
  function fakeTx(input: { holdingOrg?: { partnerId: string; type: string } | null; parkedCount?: number }) {
    const calls: string[] = [];
    const executed: SQL[] = [];
    let selectIndex = 0;
    const tx = {
      execute: vi.fn(async (query: SQL) => {
        executed.push(query);
        const text = new PgDialect().sqlToQuery(query).sql;
        calls.push(text.includes('pg_advisory_xact_lock') ? 'lock' : text.includes('set_config') ? 'declare' : 'other');
      }),
      select: vi.fn(() => {
        const index = selectIndex++;
        if (index === 0) {
          return { from: () => ({ where: () => ({ limit: async () => {
            calls.push('holdingOrg');
            return input.holdingOrg === null ? [] : [input.holdingOrg ?? { partnerId: 'partner-1', type: 'unassigned_pool' }];
          } }) }) };
        }
        return { from: () => ({ where: async () => { calls.push('count'); return [{ count: input.parkedCount ?? 0 }]; } }) };
      }),
    };
    return { tx: tx as any, calls, executed };
  }

  it('locks the partner holding area, counts, then declares the admission', async () => {
    const f = fakeTx({ parkedCount: PARKED_DEVICES_PER_PARTNER_MAX - 1 });
    await expect(admitParkedEnrollment(f.tx, { partnerId: 'partner-1', holdingOrgId: 'pool-1' }))
      .resolves.toEqual({ parkedCount: PARKED_DEVICES_PER_PARTNER_MAX - 1 });
    expect(f.calls).toEqual(['lock', 'holdingOrg', 'count', 'declare']);
    const lock = new PgDialect().sqlToQuery(f.executed[0]!);
    expect(lock.params).toEqual(['unassigned_pool:partner-1']);
  });

  it('refuses at the cap without declaring the admission', async () => {
    const f = fakeTx({ parkedCount: PARKED_DEVICES_PER_PARTNER_MAX });
    await expect(admitParkedEnrollment(f.tx, { partnerId: 'partner-1', holdingOrgId: 'pool-1' }))
      .rejects.toBeInstanceOf(ParkedCapReachedError);
    expect(f.calls).not.toContain('declare');
  });

  it.each([
    ['missing', null],
    ['another partner', { partnerId: 'partner-2', type: 'unassigned_pool' }],
    ['not a holding org', { partnerId: 'partner-1', type: 'customer' }],
  ])('refuses a holding org that is %s', async (_label, holdingOrg) => {
    const f = fakeTx({ holdingOrg });
    await expect(admitParkedEnrollment(f.tx, { partnerId: 'partner-1', holdingOrgId: 'pool-1' }))
      .rejects.toThrow('not this partner');
    expect(f.calls).not.toContain('declare');
  });
});
