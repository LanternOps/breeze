import { describe, expect, it } from 'vitest';
import { normalizeMatchName, resolveDeviceMatches } from './resolve';

const ORG = '11111111-1111-4111-8111-111111111111';
const OTHER_ORG = '22222222-2222-4222-8222-222222222222';
const dev = (deviceId: string, matchName: string, macs: string[] = [], claimed = false) =>
  ({ deviceId, matchName, orgId: ORG, macAddresses: macs, claimed });

describe('resolveDeviceMatches', () => {
  it('links on a unique hostname match', () => {
    const out = resolveDeviceMatches(
      [{ id: 'p1', orgId: ORG, matchName: 'srv-01', macAddresses: [] }],
      [dev('d1', 'srv-01')],
    );
    expect(out.links).toEqual([{ rowId: 'p1', deviceId: 'd1', source: 'auto_hostname' }]);
    expect(out.ambiguous).toEqual([]);
  });

  it('breaks a two-candidate tie on MAC, case-insensitively', () => {
    const out = resolveDeviceMatches(
      [{ id: 'p1', orgId: ORG, matchName: 'srv-01', macAddresses: ['AA:BB:CC:DD:EE:FF'] }],
      [dev('d1', 'srv-01', ['00:11:22:33:44:55']), dev('d2', 'srv-01', ['aa:bb:cc:dd:ee:ff'])],
    );
    expect(out.links).toEqual([{ rowId: 'p1', deviceId: 'd2', source: 'auto_mac' }]);
    expect(out.ambiguous).toEqual([]);
  });

  it('leaves the row unlinked and ambiguous when two candidates BOTH match on MAC', () => {
    const out = resolveDeviceMatches(
      [{ id: 'p1', orgId: ORG, matchName: 'srv-01', macAddresses: ['aa:bb:cc:dd:ee:ff'] }],
      [dev('d1', 'srv-01', ['aa:bb:cc:dd:ee:ff']), dev('d2', 'srv-01', ['aa:bb:cc:dd:ee:ff'])],
    );
    expect(out.links).toEqual([]);
    expect(out.ambiguous).toEqual(['p1']);
  });

  it('leaves the row unlinked and ambiguous when two candidates match and neither carries the MAC', () => {
    const out = resolveDeviceMatches(
      [{ id: 'p1', orgId: ORG, matchName: 'srv-01', macAddresses: ['aa:bb:cc:dd:ee:ff'] }],
      [dev('d1', 'srv-01'), dev('d2', 'srv-01')],
    );
    expect(out.links).toEqual([]);
    expect(out.ambiguous).toEqual(['p1']);
  });

  it('records auto_hostname when several devices match the name but only one is free', () => {
    const out = resolveDeviceMatches(
      [{ id: 'p1', orgId: ORG, matchName: 'srv-01', macAddresses: ['aa:bb:cc:dd:ee:ff'] }],
      [dev('d1', 'srv-01', [], true), dev('d2', 'srv-01')],
    );
    expect(out.links).toEqual([{ rowId: 'p1', deviceId: 'd2', source: 'auto_hostname' }]);
  });

  it('counts a row as ambiguous when its only candidate is already claimed by another row', () => {
    const out = resolveDeviceMatches(
      [{ id: 'p1', orgId: ORG, matchName: 'srv-01', macAddresses: [] }],
      [dev('d1', 'srv-01', [], true)],
    );
    expect(out.links).toEqual([]);
    expect(out.ambiguous).toEqual(['p1']);
  });

  it('gives a contested device to exactly one row, deterministically, and calls the loser ambiguous', () => {
    const out = resolveDeviceMatches(
      [
        { id: 'p2', orgId: ORG, matchName: 'srv-01', macAddresses: [] },
        { id: 'p1', orgId: ORG, matchName: 'srv-01', macAddresses: [] },
      ],
      [dev('d1', 'srv-01')],
    );
    expect(out.links).toEqual([{ rowId: 'p1', deviceId: 'd1', source: 'auto_hostname' }]);
    expect(out.ambiguous).toEqual(['p2']);
  });

  it('never crosses orgs', () => {
    const out = resolveDeviceMatches(
      [{ id: 'p1', orgId: ORG, matchName: 'srv-01', macAddresses: [] }],
      [{ deviceId: 'd1', matchName: 'srv-01', orgId: OTHER_ORG, macAddresses: [], claimed: false }],
    );
    expect(out.links).toEqual([]);
    expect(out.ambiguous).toEqual([]);
  });

  it('is a no-op for a row with no usable match name', () => {
    const out = resolveDeviceMatches(
      [{ id: 'p1', orgId: ORG, matchName: null, macAddresses: ['aa:bb:cc:dd:ee:ff'] }],
      [dev('d1', 'srv-01', ['aa:bb:cc:dd:ee:ff'])],
    );
    expect(out.links).toEqual([]);
    expect(out.ambiguous).toEqual([]);
  });

  it('does not report a row with no candidate at all as ambiguous', () => {
    const out = resolveDeviceMatches(
      [{ id: 'p1', orgId: ORG, matchName: 'nothing-here', macAddresses: [] }],
      [dev('d1', 'srv-01')],
    );
    expect(out.links).toEqual([]);
    expect(out.ambiguous).toEqual([]);
  });

  it('identifier-poor rows with a same-org name collision stay ambiguous (no fuzzy fallback)', () => {
    const r = resolveDeviceMatches(
      [{ id: 'r1', orgId: 'o', matchName: 'pc', macAddresses: [] }],
      [
        { deviceId: 'd1', orgId: 'o', matchName: 'pc', macAddresses: [], claimed: false },
        { deviceId: 'd2', orgId: 'o', matchName: 'pc', macAddresses: [], claimed: false },
      ],
    );
    expect(r).toEqual({ links: [], ambiguous: ['r1'] });
  });
});

describe('normalizeMatchName', () => {
  it('compares the short name of an FQDN against hostname and display name', () => {
    expect(normalizeMatchName('WS-01.corp.example.com')).toBe('ws-01');
    expect(normalizeMatchName('  ws-01 ')).toBe('ws-01');
    expect(normalizeMatchName('')).toBeNull();
    expect(normalizeMatchName(null)).toBeNull();
    expect(normalizeMatchName('.corp')).toBeNull();
  });
});
