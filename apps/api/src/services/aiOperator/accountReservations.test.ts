import { describe, expect, it } from 'vitest';
import { describeReservationConflict, sortAccountKeys, type AccountReservationConflict } from './accountReservations';

describe('sortAccountKeys (#9981 lock order)', () => {
  it('returns one global order whatever the input order, so two lockers never take the same locks crosswise', () => {
    const a = { provider: 'm365' as const, externalId: 'b-oid' };
    const b = { provider: 'google' as const, externalId: '200' };
    const c = { provider: 'm365' as const, externalId: 'a-oid' };
    const expected = [b, c, a];
    expect(sortAccountKeys([a, b, c])).toEqual(expected);
    expect(sortAccountKeys([c, a, b])).toEqual(expected);
    expect(sortAccountKeys([b, a, c])).toEqual(expected);
  });

  it('orders by code unit, not locale, and drops duplicates', () => {
    const upper = { provider: 'google' as const, externalId: 'Z' };
    const lower = { provider: 'google' as const, externalId: 'a' };
    expect(sortAccountKeys([lower, upper, lower])).toEqual([upper, lower]);
  });
});

describe('describeReservationConflict', () => {
  const base: AccountReservationConflict = {
    taskId: 'task-1', orgId: 'org-1', provider: 'm365', externalId: 'oid', principalLabel: 'dana@customer.example',
    taskState: 'running', taskOutcome: null, fromMergedOrg: false,
  };

  it('names the account, the holding task and its state', () => {
    expect(describeReservationConflict(base))
      .toBe('the Microsoft 365 account dana@customer.example is reserved by task task-1: that task is running.');
  });

  it('a terminal holder says the action may still land and how to free it', () => {
    const msg = describeReservationConflict({ ...base, provider: 'google', taskState: 'handed_off', taskOutcome: 'unknown_effect' });
    expect(msg).toContain('Google Workspace account dana@customer.example is reserved by task task-1');
    expect(msg).toContain('may still land');
    expect(msg).toContain('release the account from that task');
  });

  it('a holder in a merged-away org says so', () => {
    expect(describeReservationConflict({ ...base, orgId: 'org-loser', fromMergedOrg: true }))
      .toContain('in an organization that was merged into this one (org-loser)');
  });
});
