import { describe, expect, it } from 'vitest';
import { planChildRowSync, planMemoryModuleSync, toMemoryModuleRows } from './inventoryChildSync';

type Stored = { id: string; key: string; exact: string };
type Reported = { key: string; exact: string };

const identity = {
  storedKey: (s: Stored) => s.key,
  reportedKey: (r: Reported) => r.key,
  storedExact: (s: Stored) => s.exact,
  reportedExact: (r: Reported) => r.exact,
};

describe('planChildRowSync', () => {
  it('matches an identical report entirely to updates', () => {
    const stored = [{ id: 'b', key: '/', exact: 'x' }, { id: 'a', key: '/data', exact: 'y' }];
    const reported = [{ key: '/data', exact: 'y' }, { key: '/', exact: 'x' }];
    expect(planChildRowSync(stored, reported, identity)).toEqual({
      updates: [{ id: 'a', row: reported[0] }, { id: 'b', row: reported[1] }],
      inserts: [],
      deleteIds: [],
    });
  });

  it('keeps the id when only non-identity fields changed', () => {
    const plan = planChildRowSync([{ id: 'a', key: '/', exact: 'old' }], [{ key: '/', exact: 'new' }], identity);
    expect(plan).toEqual({ updates: [{ id: 'a', row: { key: '/', exact: 'new' } }], inserts: [], deleteIds: [] });
  });

  it('inserts only the rows that appeared and deletes only the rows that disappeared', () => {
    const plan = planChildRowSync(
      [{ id: 'a', key: '/', exact: 'x' }, { id: 'b', key: '/old', exact: 'x' }],
      [{ key: '/', exact: 'x' }, { key: '/new', exact: 'x' }],
      identity,
    );
    expect(plan).toEqual({
      updates: [{ id: 'a', row: { key: '/', exact: 'x' } }],
      inserts: [{ key: '/new', exact: 'x' }],
      deleteIds: ['b'],
    });
  });

  it('pairs duplicate keys exact-first, then leftovers in id order', () => {
    // eth0 carries an ipv4 and an ipv6 row; the ipv4 address changed.
    const stored = [
      { id: 'b', key: 'eth0', exact: 'ipv4:10.0.0.5' },
      { id: 'a', key: 'eth0', exact: 'ipv6:fe80::1' },
    ];
    const reported = [{ key: 'eth0', exact: 'ipv4:10.0.0.9' }, { key: 'eth0', exact: 'ipv6:fe80::1' }];
    expect(planChildRowSync(stored, reported, identity)).toEqual({
      updates: [{ id: 'a', row: reported[1] }, { id: 'b', row: reported[0] }],
      inserts: [],
      deleteIds: [],
    });
  });

  it('handles surplus rows on either side of a duplicated key', () => {
    const plan = planChildRowSync(
      [{ id: 'c', key: 'eth0', exact: '1' }, { id: 'a', key: 'eth0', exact: '2' }, { id: 'b', key: 'eth0', exact: '3' }],
      [{ key: 'eth0', exact: '3' }],
      identity,
    );
    expect(plan).toEqual({ updates: [{ id: 'b', row: { key: 'eth0', exact: '3' } }], inserts: [], deleteIds: ['a', 'c'] });

    const grown = planChildRowSync([{ id: 'a', key: 'eth0', exact: '1' }], [{ key: 'eth0', exact: '2' }, { key: 'eth0', exact: '1' }], identity);
    expect(grown).toEqual({ updates: [{ id: 'a', row: { key: 'eth0', exact: '1' } }], inserts: [{ key: 'eth0', exact: '2' }], deleteIds: [] });
  });

  it('handles empty sides', () => {
    expect(planChildRowSync([], [{ key: '/', exact: 'x' }], identity)).toEqual({ updates: [], inserts: [{ key: '/', exact: 'x' }], deleteIds: [] });
    expect(planChildRowSync([{ id: 'a', key: '/', exact: 'x' }], [], identity)).toEqual({ updates: [], inserts: [], deleteIds: ['a'] });
  });
});

describe('memory module sync planning (#5351)', () => {
  const report = (slotKey: string, overrides: Record<string, unknown> = {}) => ({
    slotKey, locator: slotKey.toUpperCase(), populated: true, capacityMb: 8192, ...overrides,
  });

  it('matches slots by slotKey so a DIMM swap in the same slot keeps the row id', () => {
    const stored = [{ id: 'row-a', slotKey: 'smbios:0x1100' }, { id: 'row-b', slotKey: 'smbios:0x1101' }];
    const rows = toMemoryModuleRows([
      report('smbios:0x1101', { capacityMb: 32768, serialNumber: 'NEW' }),
      report('smbios:0x1100'),
    ]);
    const plan = planMemoryModuleSync(stored, rows);
    expect(plan.inserts).toEqual([]);
    expect(plan.deleteIds).toEqual([]);
    expect(plan.updates.map((u) => [u.id, u.row.slotKey, u.row.slotIndex])).toEqual([
      ['row-a', 'smbios:0x1100', 1],
      ['row-b', 'smbios:0x1101', 0],
    ]);
    expect(plan.updates[1]!.row).toMatchObject({ capacityMb: 32768, serialNumber: 'NEW' });
  });

  it('never matches across slotKeys: a slot that vanished is deleted, a new one inserted', () => {
    const plan = planMemoryModuleSync(
      [{ id: 'row-a', slotKey: 'smbios:0x1100' }],
      toMemoryModuleRows([report('smbios:0x2200')]),
    );
    expect(plan).toMatchObject({ updates: [], deleteIds: ['row-a'] });
    expect(plan.inserts.map((r) => r.slotKey)).toEqual(['smbios:0x2200']);
  });

  it('stores absent optional fields as NULL (never "keep the old value") and indexes slots in report order', () => {
    const [empty, full] = toMemoryModuleRows([
      { slotKey: 'a', locator: 'A', populated: false },
      report('b', { bankLabel: '', manufacturer: 'Samsung' }),
    ]);
    expect(empty).toEqual({
      slotKey: 'a', slotIndex: 0, locator: 'A', bankLabel: null, populated: false, capacityMb: null,
      memoryType: null, formFactor: null, speedMts: null, configuredSpeedMts: null,
      manufacturer: null, partNumber: null, serialNumber: null,
    });
    expect(full).toMatchObject({ slotIndex: 1, bankLabel: null, manufacturer: 'Samsung', capacityMb: 8192 });
  });
});
