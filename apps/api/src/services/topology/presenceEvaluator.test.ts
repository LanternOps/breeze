import { describe, expect, it } from 'vitest';
import type { DevicePresence, PresenceAttachment } from './presenceClassifier';
import type { AnchorEvidence } from './presenceInputs';
import { buildSiteFingerprints, PRESENCE_FRESH_CAP_MS, presenceFreshUntil, presenceInputDigest } from './presenceEvaluator';

const A = '00000000-0000-4000-8000-00000000000a';
const B = '00000000-0000-4000-8000-00000000000b';
const NOW = new Date('2026-12-26T12:00:00.000Z');
const ev = (observer: string, gateway: string, mac: string | null = null, prefix = '10.1.5.0/24'): AnchorEvidence =>
  ({ prefix, gateway, observerDeviceId: observer, mac, confirmedAt: '2026-12-26T11:00:00.000Z' });
const decl = (...prefixes: string[]) => new Map(prefixes.map((p) => [p, [{ kind: 'discovery_profile' as const, id: 'p1' }]]));

describe('buildSiteFingerprints', () => {
  it('one anchored row per gateway the site\'s own observers report, with MAC observer sets', () => {
    const rows = buildSiteFingerprints({
      siteId: B, declarations: decl('10.1.5.0/24'), declarers: new Map([['10.1.5.0/24', [B]]]), neighborCoverage: 'complete',
      evidence: [ev('o1', '10.1.5.1', 'aa:aa:aa:aa:aa:01'), ev('o2', '10.1.5.1', 'aa:aa:aa:aa:aa:01'), ev('o3', '10.1.5.254')],
    });
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ gatewayAddress: '10.1.5.1', status: 'anchored', observerDeviceIds: ['o1', 'o2'],
      gatewayMacs: [{ mac: 'aa:aa:aa:aa:aa:01', observerDeviceIds: ['o1', 'o2'] }], consumerDefault: false, declaredBy: ['discovery_profile'] });
    expect(rows[1]).toMatchObject({ gatewayAddress: '10.1.5.254', observerDeviceIds: ['o3'], gatewayMacs: [] });
  });

  it('no evidence → one unconfirmed row with no gateway; two declarers → ambiguous', () => {
    expect(buildSiteFingerprints({ siteId: B, declarations: decl('10.1.5.0/24'), declarers: new Map([['10.1.5.0/24', [B]]]),
      neighborCoverage: 'complete', evidence: [] })).toEqual([expect.objectContaining({ gatewayAddress: null, status: 'unconfirmed' })]);
    expect(buildSiteFingerprints({ siteId: B, declarations: decl('192.168.1.0/24'), declarers: new Map([['192.168.1.0/24', [A, B]]]),
      neighborCoverage: 'complete', evidence: [ev('o1', '192.168.1.1', null, '192.168.1.0/24')] }))
      .toEqual([expect.objectContaining({ gatewayAddress: '192.168.1.1', status: 'ambiguous', consumerDefault: true })]);
  });

  it('limited neighbour coverage records no MACs (C undefined)', () => {
    const rows = buildSiteFingerprints({ siteId: B, declarations: decl('10.1.5.0/24'), declarers: new Map([['10.1.5.0/24', [B]]]),
      neighborCoverage: 'limited', evidence: [ev('o1', '10.1.5.1', 'aa:aa:aa:aa:aa:01'), ev('o2', '10.1.5.1', 'aa:aa:aa:aa:aa:01')] });
    expect(rows[0]).toMatchObject({ neighborCoverage: 'limited', gatewayMacs: [] });
  });

  it('caps observers at 64 and MACs at 16', () => {
    const evidence = Array.from({ length: 80 }, (_, i) => ev(`o${String(i).padStart(3, '0')}`, '10.1.5.1', `aa:aa:aa:aa:aa:${(i % 20).toString(16).padStart(2, '0')}`));
    const [row] = buildSiteFingerprints({ siteId: B, declarations: decl('10.1.5.0/24'), declarers: new Map([['10.1.5.0/24', [B]]]), neighborCoverage: 'complete', evidence });
    expect(row!.observerDeviceIds).toHaveLength(64);
    expect(row!.gatewayMacs).toHaveLength(16);
  });
});

describe('presenceFreshUntil', () => {
  const att = (freshUntil: string): PresenceAttachment => ({ prefix: '10.1.5.0/24', gateway: '10.1.5.1', mac: null, confirmedAt: NOW.toISOString(),
    freshUntil, relationshipIds: [], observerNodeId: 'n', interfaceName: null });
  const presence = (state: DevicePresence['state'], attachment: PresenceAttachment | null, evidence: PresenceAttachment[] = []): DevicePresence => ({
    state, reason: null, matchedSiteId: null, declaringSiteIds: [], attachment, macCorroborated: false,
    evidence: evidence.map((e) => ({ ...e, classification: 'unrecognized', siteId: null, reason: null, declaringSiteIds: [], macCorroborated: false })),
  });

  it('never exceeds now + 75 min', () => {
    const later = new Date(NOW.getTime() + 5 * 3_600_000).toISOString();
    expect(presenceFreshUntil(presence('visiting', att(later)), NOW).getTime()).toBe(NOW.getTime() + PRESENCE_FRESH_CAP_MS);
    expect(presenceFreshUntil(presence('stale', null), NOW).getTime()).toBe(NOW.getTime() + PRESENCE_FRESH_CAP_MS);
  });

  it('never exceeds the supporting evidence', () => {
    const soon = new Date(NOW.getTime() + 5 * 60_000).toISOString();
    expect(presenceFreshUntil(presence('home', att(soon)), NOW).toISOString()).toBe(soon);
    const evidence = [att(new Date(NOW.getTime() + 50 * 60_000).toISOString()), att(soon)];
    expect(presenceFreshUntil(presence('unrecognized', evidence[0]!, evidence), NOW).toISOString()).toBe(soon);
  });
});

describe('presenceInputDigest', () => {
  it('is stable under map order and changes with the inputs', () => {
    const one = new Map([[A, decl('10.1.2.0/24')], [B, decl('10.1.5.0/24')]]);
    const two = new Map([[B, decl('10.1.5.0/24')], [A, decl('10.1.2.0/24')]]);
    expect(presenceInputDigest(one, [])).toBe(presenceInputDigest(two, []));
    expect(presenceInputDigest(one, [])).not.toBe(presenceInputDigest(new Map([[A, decl('10.1.3.0/24')]]), []));
  });
});
