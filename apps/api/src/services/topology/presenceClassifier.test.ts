import { describe, expect, it } from 'vitest';
import {
  buildFingerprintIndex,
  classifyAttachment,
  classifyDevicePresence,
  corroboratedMacs,
  type AttachmentClass,
  type FingerprintRow,
  type PresenceAttachment,
} from './presenceClassifier';

const A = 'site-a', B = 'site-b', C = 'site-c', D = 'dev-1';
const T0 = '2026-10-12T10:00:00.000Z';
const T1 = '2026-10-12T11:00:00.000Z';
const NOW = new Date('2026-10-12T10:30:00.000Z');

const fp = (o: Partial<FingerprintRow> & Pick<FingerprintRow, 'siteId' | 'prefix'>): FingerprintRow => ({
  gatewayAddress: null, status: 'anchored', consumerDefault: false,
  observerDeviceIds: ['o1'], gatewayMacs: [], neighborCoverage: 'complete', ...o,
});
const att = (prefix: string, gateway: string, mac: string | null = null, freshUntil = T1): PresenceAttachment => ({
  prefix, gateway, mac, confirmedAt: T0, freshUntil, relationshipIds: ['r1'], observerNodeId: 'n1', interfaceName: 'eth0',
});
const index = (rows: FingerprintRow[], coverage: 'complete' | 'limited' = 'complete') => buildFingerprintIndex(rows, coverage);

describe('buildFingerprintIndex', () => {
  it('maps prefix to sorted unique declaring sites and keys rows by site|prefix', () => {
    const idx = index([
      fp({ siteId: C, prefix: '10.1.5.0/24' }),
      fp({ siteId: B, prefix: '10.1.5.0/24', gatewayAddress: '10.1.5.1' }),
      fp({ siteId: B, prefix: '10.1.5.0/24', gatewayAddress: '10.1.5.2' }),
    ]);
    expect(idx.declarers.get('10.1.5.0/24')).toEqual([B, C]);
    expect(idx.rows.get(`${B}|10.1.5.0/24`)).toHaveLength(2);
    expect(idx.coverage).toBe('complete');
  });
});

it.each<[string, FingerprintRow[], PresenceAttachment, Partial<AttachmentClass>]>([
  ['undeclared → unrecognized', [], att('10.1.5.0/24', '10.1.5.1'), { classification: 'unrecognized', reason: 'not_declared' }],
  ['own declared + own gateway → home', [fp({ siteId: A, prefix: '10.1.2.0/24', gatewayAddress: '10.1.2.100', observerDeviceIds: [D] })], att('10.1.2.0/24', '10.1.2.100'), { classification: 'home', siteId: A }],
  ['own declared, other gateway → unrecognized own_gateway_mismatch', [fp({ siteId: A, prefix: '10.1.2.0/24', gatewayAddress: '10.1.2.100' })], att('10.1.2.0/24', '10.1.2.254'), { classification: 'unrecognized', reason: 'own_gateway_mismatch' }],
  ['own gateway but MAC conflicts with A\'s corroborated set → own_gateway_mac_conflict', [fp({ siteId: A, prefix: '10.1.2.0/24', gatewayAddress: '10.1.2.100', gatewayMacs: [{ mac: 'aa:aa:aa:aa:aa:01', observerDeviceIds: ['o1', 'o2'] }] })], att('10.1.2.0/24', '10.1.2.100', 'bb:bb:bb:bb:bb:02'), { classification: 'unrecognized', reason: 'own_gateway_mac_conflict', siteId: A }],
  ['B declared + B gateway (non-consumer) → visiting B', [fp({ siteId: B, prefix: '10.1.5.0/24', gatewayAddress: '10.1.5.1' })], att('10.1.5.0/24', '10.1.5.1'), { classification: 'visiting', siteId: B, macCorroborated: false }],
  ['B declared, no B observer → declared_unconfirmed', [fp({ siteId: B, prefix: '10.1.5.0/24', status: 'unconfirmed', observerDeviceIds: [] })], att('10.1.5.0/24', '10.1.5.1'), { classification: 'unrecognized', reason: 'declared_unconfirmed', siteId: B }],
  ['B declared, other gateway → gateway_mismatch', [fp({ siteId: B, prefix: '10.1.5.0/24', gatewayAddress: '10.1.5.1' })], att('10.1.5.0/24', '10.1.5.254'), { classification: 'unrecognized', reason: 'gateway_mismatch' }],
  ['non-consumer MAC conflict vetoes', [fp({ siteId: B, prefix: '10.1.5.0/24', gatewayAddress: '10.1.5.1', gatewayMacs: [{ mac: 'aa:aa:aa:aa:aa:01', observerDeviceIds: ['o1', 'o2'] }] })], att('10.1.5.0/24', '10.1.5.1', 'bb:bb:bb:bb:bb:02'), { classification: 'unrecognized', reason: 'gateway_mac_conflict' }],
  ['non-consumer, matching MAC → visiting, corroborated', [fp({ siteId: B, prefix: '10.1.5.0/24', gatewayAddress: '10.1.5.1', gatewayMacs: [{ mac: 'aa:aa:aa:aa:aa:01', observerDeviceIds: ['o1', 'o2'] }] })], att('10.1.5.0/24', '10.1.5.1', 'aa:aa:aa:aa:aa:01'), { classification: 'visiting', siteId: B, macCorroborated: true }],
  ['consumer prefix needs MAC from ≥2 B observers', [fp({ siteId: B, prefix: '192.168.1.0/24', gatewayAddress: '192.168.1.1', consumerDefault: true, gatewayMacs: [{ mac: 'aa:aa:aa:aa:aa:01', observerDeviceIds: ['o1'] }] })], att('192.168.1.0/24', '192.168.1.1', 'aa:aa:aa:aa:aa:01'), { classification: 'unrecognized', reason: 'consumer_uncorroborated' }],
  ['consumer prefix with 2-observer MAC → visiting', [fp({ siteId: B, prefix: '192.168.1.0/24', gatewayAddress: '192.168.1.1', consumerDefault: true, gatewayMacs: [{ mac: 'aa:aa:aa:aa:aa:01', observerDeviceIds: ['o1', 'o2'] }] })], att('192.168.1.0/24', '192.168.1.1', 'aa:aa:aa:aa:aa:01'), { classification: 'visiting', siteId: B, macCorroborated: true }],
  ['consumer prefix, B neighbour coverage limited → uncorroborated', [fp({ siteId: B, prefix: '192.168.1.0/24', gatewayAddress: '192.168.1.1', consumerDefault: true, neighborCoverage: 'limited', gatewayMacs: [{ mac: 'aa:aa:aa:aa:aa:01', observerDeviceIds: ['o1', 'o2'] }] })], att('192.168.1.0/24', '192.168.1.1', 'aa:aa:aa:aa:aa:01'), { classification: 'unrecognized', reason: 'consumer_uncorroborated' }],
  ['consumer prefix, device MAC unknown → uncorroborated', [fp({ siteId: B, prefix: '192.168.1.0/24', gatewayAddress: '192.168.1.1', consumerDefault: true, gatewayMacs: [{ mac: 'aa:aa:aa:aa:aa:01', observerDeviceIds: ['o1', 'o2'] }] })], att('192.168.1.0/24', '192.168.1.1', null), { classification: 'unrecognized', reason: 'consumer_uncorroborated' }],
  ['consumer default detected from the prefix even when the row flag is false', [fp({ siteId: B, prefix: '192.168.1.0/24', gatewayAddress: '192.168.1.1', consumerDefault: false })], att('192.168.1.0/24', '192.168.1.1'), { classification: 'unrecognized', reason: 'consumer_uncorroborated' }],
  ['declared by B and C → ambiguous', [fp({ siteId: B, prefix: '192.168.1.0/24', status: 'ambiguous' }), fp({ siteId: C, prefix: '192.168.1.0/24', status: 'ambiguous' })], att('192.168.1.0/24', '192.168.1.1'), { classification: 'ambiguous', reason: 'multiply_declared', declaringSiteIds: [B, C] }],
  ['declared by A and C, own gateway, no conflict → home (refinement)', [fp({ siteId: A, prefix: '192.168.1.0/24', gatewayAddress: '192.168.1.1', status: 'ambiguous', consumerDefault: true }), fp({ siteId: C, prefix: '192.168.1.0/24', status: 'ambiguous' })], att('192.168.1.0/24', '192.168.1.1'), { classification: 'home', siteId: A }],
  ['declared by A and C, A gateway mismatch → ambiguous', [fp({ siteId: A, prefix: '192.168.1.0/24', gatewayAddress: '192.168.1.1', status: 'ambiguous' }), fp({ siteId: C, prefix: '192.168.1.0/24', status: 'ambiguous' })], att('192.168.1.0/24', '192.168.1.254'), { classification: 'ambiguous', reason: 'multiply_declared' }],
])('%s', (_name, rows, a, expected) => {
  expect(classifyAttachment(a, D, A, index(rows))).toMatchObject(expected);
});

describe('corroboratedMacs', () => {
  const rows = [fp({ siteId: B, prefix: '10.1.5.0/24', gatewayAddress: '10.1.5.1', gatewayMacs: [
    { mac: 'aa:aa:aa:aa:aa:01', observerDeviceIds: ['o1', 'o2'] },
    { mac: 'aa:aa:aa:aa:aa:02', observerDeviceIds: ['o1'] },
  ] })];
  it('keeps only MACs seen by at least two other observers', () => {
    expect([...corroboratedMacs(index(rows), B, '10.1.5.0/24', '10.1.5.1', D)!]).toEqual(['aa:aa:aa:aa:aa:01']);
  });
  it('is null when the gateway has no row or coverage is limited', () => {
    expect(corroboratedMacs(index(rows), B, '10.1.5.0/24', '10.1.5.9', D)).toBeNull();
    expect(corroboratedMacs(index([{ ...rows[0]!, neighborCoverage: 'limited' }]), B, '10.1.5.0/24', '10.1.5.1', D)).toBeNull();
  });
});

it('excludes the subject device from MAC corroboration (leave-one-out)', () => {
  const rows = [fp({ siteId: B, prefix: '192.168.1.0/24', gatewayAddress: '192.168.1.1', consumerDefault: true, gatewayMacs: [{ mac: 'aa:aa:aa:aa:aa:01', observerDeviceIds: [D, 'o1'] }] })];
  expect(classifyAttachment(att('192.168.1.0/24', '192.168.1.1', 'aa:aa:aa:aa:aa:01'), D, A, index(rows)).classification).toBe('unrecognized');
});

it('org coverage limited turns a would-be visit into unknown', () => {
  const rows = [fp({ siteId: B, prefix: '10.1.5.0/24', gatewayAddress: '10.1.5.1' })];
  expect(classifyAttachment(att('10.1.5.0/24', '10.1.5.1'), D, A, index(rows, 'limited'))).toMatchObject({ classification: 'unknown', reason: 'coverage_limited' });
});

describe('classifyDevicePresence', () => {
  const lanA = fp({ siteId: A, prefix: '10.1.2.0/24', gatewayAddress: '10.1.2.100' });
  const lanB = fp({ siteId: B, prefix: '10.1.5.0/24', gatewayAddress: '10.1.5.1' });
  const lanC = fp({ siteId: C, prefix: '10.1.6.0/24', gatewayAddress: '10.1.6.1' });
  const idx = index([lanA, lanB, lanC]);
  const run = (attachments: PresenceAttachment[], i = idx) =>
    classifyDevicePresence({ deviceId: D, assignedSiteId: A, attachments, index: i, now: NOW });

  it('org coverage limited and no home attachment → unknown/coverage_limited, whatever the attachments say (S§4.2 override)', () => {
    const limited = index([lanA, lanB, lanC], 'limited');
    expect(run([att('192.168.1.0/24', '192.168.1.1'), att('10.1.2.0/24', '10.1.2.254')], limited))
      .toMatchObject({ state: 'unknown', reason: 'coverage_limited', matchedSiteId: null });
    expect(run([att('10.1.2.0/24', '10.1.2.100')], limited)).toMatchObject({ state: 'home' });
  });
  it('no attachments → stale/no_fresh_observation', () => {
    expect(run([])).toMatchObject({ state: 'stale', reason: 'no_fresh_observation', matchedSiteId: null, attachment: null, evidence: [] });
  });
  it('home wins over a simultaneous visit (multi-homed)', () => {
    const r = run([att('10.1.5.0/24', '10.1.5.1'), att('10.1.2.0/24', '10.1.2.100')]);
    expect(r).toMatchObject({ state: 'home', reason: null, matchedSiteId: null });
    expect(r.attachment?.prefix).toBe('10.1.2.0/24');
  });
  it('visiting one site plus an unrecognized side network → visiting', () => {
    const r = run([att('172.30.0.0/24', '172.30.0.1'), att('10.1.5.0/24', '10.1.5.1')]);
    expect(r).toMatchObject({ state: 'visiting', reason: null, matchedSiteId: B, macCorroborated: false });
    expect(r.attachment?.prefix).toBe('10.1.5.0/24');
  });
  it('visiting two sites → ambiguous', () => {
    const r = run([att('10.1.5.0/24', '10.1.5.1'), att('10.1.6.0/24', '10.1.6.1')]);
    expect(r).toMatchObject({ state: 'ambiguous', reason: 'multiply_declared', matchedSiteId: null });
    expect(r.declaringSiteIds).toEqual([B, C]);
  });
  it('visiting plus an ambiguous attachment → ambiguous', () => {
    const shared = index([lanB, fp({ siteId: B, prefix: '192.168.9.0/24' }), fp({ siteId: C, prefix: '192.168.9.0/24' })]);
    const r = run([att('10.1.5.0/24', '10.1.5.1'), att('192.168.9.0/24', '192.168.9.1')], shared);
    expect(r).toMatchObject({ state: 'ambiguous', reason: 'multiply_declared' });
    expect(r.declaringSiteIds).toEqual([B, C]);
  });
  it('expired attachment (freshUntil <= now) is ignored', () => {
    const expired = att('10.1.5.0/24', '10.1.5.1', null, NOW.toISOString());
    expect(run([expired])).toMatchObject({ state: 'stale', reason: 'no_fresh_observation' });
    const r = run([expired, att('10.1.6.0/24', '10.1.6.1')]);
    expect(r).toMatchObject({ state: 'visiting', matchedSiteId: C });
    expect(r.evidence).toHaveLength(1);
  });
  it('only unrecognized attachments → unrecognized with the deciding reason', () => {
    const r = run([att('172.30.0.0/24', '172.30.0.1')]);
    expect(r).toMatchObject({ state: 'unrecognized', reason: 'not_declared', matchedSiteId: null });
    expect(r.attachment?.prefix).toBe('172.30.0.0/24');
  });
  it('unrecognized carries the declaring site of the deciding attachment', () => {
    const r = run([att('10.1.5.0/24', '10.1.5.254')]);
    expect(r).toMatchObject({ state: 'unrecognized', reason: 'gateway_mismatch', declaringSiteIds: [B] });
  });
  it('all attachments unknown → unknown/coverage_limited', () => {
    const r = run([att('10.1.5.0/24', '10.1.5.1'), att('10.1.6.0/24', '10.1.6.1')], index([lanA, lanB, lanC], 'limited'));
    expect(r).toMatchObject({ state: 'unknown', reason: 'coverage_limited', matchedSiteId: null });
  });
  it('is independent of attachment input order', () => {
    const list = [
      att('172.30.0.0/24', '172.30.0.1'),
      att('172.31.0.0/24', '172.31.0.1'),
      att('10.1.5.0/24', '10.1.5.1'),
      att('10.1.5.0/24', '10.1.5.254'),
    ];
    const forward = run(list);
    expect(run([...list].reverse())).toEqual(forward);
    expect(run([list[2]!, list[0]!, list[3]!, list[1]!])).toEqual(forward);
    const noVisit = list.filter((a) => a.prefix !== '10.1.5.0/24' || a.gateway !== '10.1.5.1');
    expect(run(noVisit)).toEqual(run([...noVisit].reverse()));
  });
  it('caps evidence at 8 and sorts it by (prefix, gateway)', () => {
    const many = Array.from({ length: 12 }, (_, i) => att(`172.30.${String(11 - i).padStart(2, '0')}.0/24`, `172.30.${String(11 - i).padStart(2, '0')}.1`));
    const r = run(many);
    expect(r.evidence).toHaveLength(8);
    const keys = r.evidence.map((e) => `${e.prefix}|${e.gateway}`);
    expect(keys).toEqual([...keys].sort());
    expect(r.evidence[0]).toMatchObject({ classification: 'unrecognized', reason: 'not_declared' });
  });
});
