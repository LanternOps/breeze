import { beforeEach, describe, expect, it, vi } from 'vitest';

const whereMock = vi.fn();

vi.mock('../../db', () => ({
  db: {
    select: () => ({ from: () => ({ innerJoin: () => ({ where: (...a: unknown[]) => whereMock(...a) }) }) }),
  },
}));
vi.mock('../../db/schema', () => ({
  organizations: { id: 'o.id', settings: 'o.settings', partnerId: 'o.partner_id' },
  partners: { id: 'p.id', settings: 'p.settings' },
}));

import {
  loadCustomerAdminsNotified,
  readStoredCustomerAdminsNotified,
  resolveCustomerAdminsNotifiedFrom,
} from './customerDelivery';

const block = (v: unknown) => ({ connectionHealth: { customerAdminsNotified: v } });

describe('resolveCustomerAdminsNotifiedFrom', () => {
  it('defaults to off with nothing stored', () => {
    expect(resolveCustomerAdminsNotifiedFrom({}, {})).toEqual({
      enabled: false, source: 'default', inheritedEnabled: false, inheritedSource: 'default',
    });
    expect(resolveCustomerAdminsNotifiedFrom(null, undefined).enabled).toBe(false);
  });

  it('inherits the partner default when the org has no override', () => {
    expect(resolveCustomerAdminsNotifiedFrom(block(true), { other: 1 })).toEqual({
      enabled: true, source: 'partner', inheritedEnabled: true, inheritedSource: 'partner',
    });
  });

  it('org override wins over the partner default, both ways', () => {
    expect(resolveCustomerAdminsNotifiedFrom(block(true), block(false))).toEqual({
      enabled: false, source: 'org', inheritedEnabled: true, inheritedSource: 'partner',
    });
    expect(resolveCustomerAdminsNotifiedFrom(block(false), block(true))).toMatchObject({
      enabled: true, source: 'org', inheritedEnabled: false, inheritedSource: 'partner',
    });
    expect(resolveCustomerAdminsNotifiedFrom({}, block(true))).toMatchObject({
      enabled: true, source: 'org', inheritedSource: 'default',
    });
  });

  it('ignores a non-boolean stored value and falls through to the next level', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(resolveCustomerAdminsNotifiedFrom(block(true), block('yes'))).toMatchObject({ enabled: true, source: 'partner' });
    expect(resolveCustomerAdminsNotifiedFrom(block(1), block(null))).toMatchObject({ enabled: false, source: 'default' });
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('treats a missing or malformed connectionHealth block as unset', () => {
    expect(readStoredCustomerAdminsNotified({ connectionHealth: 'x' })).toBeNull();
    expect(readStoredCustomerAdminsNotified({ connectionHealth: null })).toBeNull();
    expect(readStoredCustomerAdminsNotified([])).toBeNull();
    expect(readStoredCustomerAdminsNotified(block(false))).toBe(false);
  });
});

describe('loadCustomerAdminsNotified', () => {
  beforeEach(() => whereMock.mockReset());

  it('resolves each org against its own partner in one query', async () => {
    whereMock.mockResolvedValue([
      { orgId: 'A', orgSettings: {}, partnerSettings: block(true) },
      { orgId: 'B', orgSettings: block(false), partnerSettings: block(true) },
    ]);
    const m = await loadCustomerAdminsNotified(['A', 'B', 'A', 'C']);
    expect(whereMock).toHaveBeenCalledTimes(1);
    expect(m.get('A')).toBe(true);
    expect(m.get('B')).toBe(false);
    // An org that no longer exists resolves off (fail closed to W1 behaviour).
    expect(m.get('C')).toBe(false);
  });

  it('does no query for an empty list', async () => {
    expect((await loadCustomerAdminsNotified([])).size).toBe(0);
    expect(whereMock).not.toHaveBeenCalled();
  });
});
