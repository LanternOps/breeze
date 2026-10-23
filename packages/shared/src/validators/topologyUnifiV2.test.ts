import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import v1Vectors from '../testing/topology-unifi-v1.json';
import v2Vectors from '../testing/topology-unifi-v2.json';
import { parseUnifiTopologyV1 } from './topologyPhysical';
import { canonicalizeUnifiResource } from './topologyPhysicalCanonical';
import { physicalSourceSectionSchema } from './topologyPhysicalNormalized';
import { parseUnifiTopologyV2, unifiResourceV2Schema, unifiTopologyV2Schema } from './topologyUnifiV2';
import { canonicalizeUnifiResourceV2 } from './topologyUnifiV2Canonical';
import type { UnifiResourceV2 } from '../types/topologyUnifiV2';

const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');
const vector = v2Vectors.vectors[0]!;
const identity = { sourceIdentity: vector.sourceIdentity, producerEpoch: vector.report.producerEpoch };
const clone = <T>(value: T): T => structuredClone(value);
const resourceOf = (kind: string) => clone(vector.report.resources.find(r => r.kind === kind)!) as unknown as UnifiResourceV2;
type Row = Record<string, unknown>;
const rowsOf = (resource: UnifiResourceV2) => resource.rows as unknown as Row[];
const rowOf = (resource: UnifiResourceV2, id: string) => rowsOf(resource).find(r => r.rowKey === id)!;

describe('UniFi topology v2: shared fixture (real-evidence derived)', () => {
  it('parses through the wire guard', () => {
    const parsed = parseUnifiTopologyV2(vector.report);
    expect(parsed.accepted).toBe(true);
  });

  it('every resource digest equals sha256 of its canonical bytes, and the canonical bytes match the vector', () => {
    for (const [index, resource] of vector.report.resources.entries()) {
      const canonical = canonicalizeUnifiResourceV2(identity, resource as unknown as UnifiResourceV2);
      expect(canonical).toBe(vector.expected.resources[index]!.canonical);
      expect(sha256(canonical)).toBe(resource.contentDigest);
    }
  });

  it('covers the evidence classes the spec requires', () => {
    const detail = resourceOf('device_details');
    const stats = resourceOf('statistics');
    const frequencies = new Set(rowsOf(detail).flatMap(r => ((r.radios as { frequencyGHz: number }[] | null) ?? []).map(radio => radio.frequencyGHz)));
    expect([...frequencies].sort()).toEqual([2.4, 5, 6]);
    const overview = rowsOf(detail).flatMap(r => (r.radios as { channel: number | null; wlanStandard: string | null }[] | null) ?? []);
    expect(overview.some(radio => radio.channel === null)).toBe(true);
    expect(overview.some(radio => radio.channel !== null)).toBe(true);
    expect(new Set(overview.map(radio => radio.wlanStandard))).toEqual(new Set(['802.11n', '802.11ax', '802.11be']));
    const retries = rowsOf(stats).flatMap(r => (r.radios as { txRetriesPct: number | null }[] | null) ?? []).map(radio => radio.txRetriesPct);
    expect(retries).toContain(0);
    expect(retries.some(value => value !== null && value > 0)).toBe(true);
    expect(retries).toContain(null);
    const rates = rowsOf(stats).map(r => r.uplinkRxRateBps);
    expect(rates).toContain(null);
    expect(rates).toContain(0);
    expect(rates.some(value => typeof value === 'number' && value > 0)).toBe(true);
    expect(rowsOf(stats).some(r => r.lastHeartbeatAt === null)).toBe(true);
    expect(rowsOf(stats).some(r => typeof r.lastHeartbeatAt === 'string')).toBe(true);
    const offline = rowOf(stats, 'ap-u6lite-offline');
    expect(offline.cpuUtilizationPct).toBeNull();
    expect(offline.uplinkTxRateBps as number).toBeGreaterThan(0);
  });
});

describe('UniFi topology v2: canonicalization', () => {
  it('uses the v2 contract, so a v1 and a v2 digest can never collide', () => {
    const canonical = canonicalizeUnifiResourceV2(identity, resourceOf('statistics'));
    expect(canonical).toContain('"contract":"unifi_topology_v2"');
    expect(canonical).toContain('"version":2');
  });

  it('nested radio ordering cannot change the digest', () => {
    const base = resourceOf('device_details');
    const shuffled = resourceOf('device_details');
    const row = rowOf(shuffled, 'ap-e7-online');
    row.radios = [...(row.radios as unknown[])].reverse();
    expect(canonicalizeUnifiResourceV2(identity, shuffled)).toBe(canonicalizeUnifiResourceV2(identity, base));
  });

  it('statistics radio ordering cannot change the digest either', () => {
    const base = resourceOf('statistics');
    const shuffled = resourceOf('statistics');
    const row = rowOf(shuffled, 'ap-e7-online');
    row.radios = [...(row.radios as unknown[])].reverse();
    expect(canonicalizeUnifiResourceV2(identity, shuffled)).toBe(canonicalizeUnifiResourceV2(identity, base));
  });

  it('capability set ordering cannot change the digest', () => {
    const base = resourceOf('device_list');
    const swapped = resourceOf('device_list');
    rowOf(swapped, 'ap-u6lr-online').interfaces = ['radios', 'ports'];
    expect(canonicalizeUnifiResourceV2(identity, swapped)).toBe(canonicalizeUnifiResourceV2(identity, base));
  });

  it('row order cannot change the digest', () => {
    const base = resourceOf('statistics');
    const reversed = resourceOf('statistics');
    reversed.rows = [...rowsOf(reversed)].reverse() as never;
    expect(canonicalizeUnifiResourceV2(identity, reversed)).toBe(canonicalizeUnifiResourceV2(identity, base));
  });

  it('a missing radios key normalizes to null while an explicit empty array stays empty, and they digest differently', () => {
    const asNull = resourceOf('device_details');
    const asEmpty = resourceOf('device_details');
    rowOf(asNull, 'legacy-1').radios = null;
    expect(rowOf(asEmpty, 'legacy-1').radios).toEqual([]);
    const nullCanonical = canonicalizeUnifiResourceV2(identity, asNull);
    const emptyCanonical = canonicalizeUnifiResourceV2(identity, asEmpty);
    expect(nullCanonical).not.toBe(emptyCanonical);
    expect(nullCanonical).toContain('"radios":null');
    expect(emptyCanonical).toContain('"radios":[]');
  });

  it('a measured zero stays zero and differs from an omitted value', () => {
    const measured = resourceOf('statistics');
    const omitted = resourceOf('statistics');
    const radios = rowOf(omitted, 'ap-u6lite-online').radios as { frequencyGHz: number; txRetriesPct: number | null }[];
    radios.find(radio => radio.frequencyGHz === 5)!.txRetriesPct = null;
    const measuredCanonical = canonicalizeUnifiResourceV2(identity, measured);
    expect(measuredCanonical).toContain('"txRetriesPct":0');
    expect(canonicalizeUnifiResourceV2(identity, omitted)).not.toBe(measuredCanonical);
    const parsed = unifiResourceV2Schema.parse(measured);
    const stats = rowOf(parsed as UnifiResourceV2, 'sw-1');
    expect(stats.cpuUtilizationPct).toBe(0);
    expect(stats.uplinkRxRateBps).toBe(0);
  });

  it('keeps the v1 canonicalizer and fixture untouched', () => {
    const v1 = v1Vectors.vectors[0]!;
    expect(parseUnifiTopologyV1(v1.report).accepted).toBe(true);
    for (const [index, resource] of v1.report.resources.entries()) {
      const id = { sourceIdentity: v1.sourceIdentity, producerEpoch: v1.report.producerEpoch };
      expect(canonicalizeUnifiResource(id, resource as never)).toBe(v1.expected.resources[index]!.canonical);
    }
  });
});

describe('UniFi topology v2: validation', () => {
  const parseStatistics = (mutate: (row: Row) => void) => {
    const resource = resourceOf('statistics');
    mutate(rowOf(resource, 'ap-u6lr-online'));
    return unifiResourceV2Schema.safeParse(resource).success;
  };

  it('rejects malformed percentages, rates and timestamps', () => {
    expect(parseStatistics(() => undefined)).toBe(true);
    expect(parseStatistics(row => { row.cpuUtilizationPct = 100.5; })).toBe(false);
    expect(parseStatistics(row => { row.memoryUtilizationPct = -1; })).toBe(false);
    expect(parseStatistics(row => { row.uplinkRxRateBps = -1; })).toBe(false);
    expect(parseStatistics(row => { row.uplinkTxRateBps = 1.5; })).toBe(false);
    expect(parseStatistics(row => { row.uplinkTxRateBps = Number.MAX_SAFE_INTEGER + 1; })).toBe(false);
    expect(parseStatistics(row => { row.lastHeartbeatAt = 'yesterday'; })).toBe(false);
    expect(parseStatistics(row => { row.radios = [{ frequencyGHz: 5, txRetriesPct: 101 }]; })).toBe(false);
    expect(parseStatistics(row => { row.radios = [{ frequencyGHz: 0, txRetriesPct: 1 }]; })).toBe(false);
  });

  it('requires the v2 keys: an omitted radios or rate key is not silently zero or null', () => {
    expect(parseStatistics(row => { delete row.radios; })).toBe(false);
    expect(parseStatistics(row => { delete row.uplinkRxRateBps; })).toBe(false);
    const detail = resourceOf('device_details');
    delete rowOf(detail, 'ap-u6lr-online').radios;
    expect(unifiResourceV2Schema.safeParse(detail).success).toBe(false);
    const list = resourceOf('device_list');
    delete rowOf(list, 'ap-u6lr-online').features;
    expect(unifiResourceV2Schema.safeParse(list).success).toBe(false);
  });

  it('rejects a row key that is not the controller device id', () => {
    expect(parseStatistics(row => { row.rowKey = 'someone-else'; })).toBe(false);
  });

  it('bounds the radio list and rejects unknown or duplicated capability values', () => {
    expect(parseStatistics(row => { row.radios = Array.from({ length: 17 }, () => ({ frequencyGHz: 5, txRetriesPct: 0 })); })).toBe(false);
    const list = resourceOf('device_list');
    rowOf(list, 'ap-u6lr-online').features = ['accessPoint', 'accessPoint'];
    expect(unifiResourceV2Schema.safeParse(list).success).toBe(false);
    rowOf(list, 'ap-u6lr-online').features = ['toaster'];
    expect(unifiResourceV2Schema.safeParse(list).success).toBe(false);
  });

  it('keeps duplicate-frequency radios as raw entries instead of rejecting them', () => {
    const detail = resourceOf('device_details');
    rowOf(detail, 'ap-u6lr-online').radios = [
      { frequencyGHz: 5, channel: 36, channelWidthMHz: 80, wlanStandard: '802.11ax' },
      { frequencyGHz: 5, channel: 149, channelWidthMHz: 80, wlanStandard: '802.11ax' },
    ];
    expect(unifiResourceV2Schema.safeParse(detail).success).toBe(true);
  });

  it('is version-bound: v2 rejects a v1 report and v1 rejects a v2 report', () => {
    expect(parseUnifiTopologyV2(v1Vectors.vectors[0]!.report)).toEqual({ accepted: false, reason: 'unsupported_major_version' });
    expect(parseUnifiTopologyV1(vector.report)).toEqual({ accepted: false, reason: 'unsupported_major_version' });
    expect(unifiTopologyV2Schema.safeParse({ ...clone(vector.report), version: 1 }).success).toBe(false);
  });

  it('rejects a duplicate controller-site resource', () => {
    const report = clone(vector.report);
    report.resources.push(clone(report.resources[0]!));
    expect(unifiTopologyV2Schema.safeParse(report).success).toBe(false);
  });
});

describe('UniFi topology v2: retained normalized sections accept the v2 | v1 row union', () => {
  const endpointKey = 'unifi:host-1:site-1:device:ap-1';
  const sectionOf = (kind: string, rows: Row[]) => ({ kind, contextKey: 'collector-1:site-1', contentDigest: 'a'.repeat(64), outcome: 'complete', rowCount: rows.length, rows });
  const v1StatisticsRow = { rowKey: 'ap-1', deviceId: 'ap-1', uptimeSeconds: 10, cpuUtilizationPct: 1, memoryUtilizationPct: 2, endpointKey };
  const v2StatisticsRow = { ...v1StatisticsRow, uplinkRxRateBps: 5, uplinkTxRateBps: 0, lastHeartbeatAt: null, nextHeartbeatAt: null, radios: [{ frequencyGHz: 5, txRetriesPct: 0 }] };

  it('keeps every v2 field on a retained v2 row (no silent stripping before the digest)', () => {
    const parsed = physicalSourceSectionSchema.parse(sectionOf('unifi_statistics', [v2StatisticsRow]));
    expect(parsed.rows[0]).toEqual(v2StatisticsRow);
  });

  it('still accepts a retained v1 row unchanged', () => {
    const parsed = physicalSourceSectionSchema.parse(sectionOf('unifi_statistics', [v1StatisticsRow]));
    expect(parsed.rows[0]).toEqual(v1StatisticsRow);
  });

  it('retains v2 device and detail rows too', () => {
    const device = { rowKey: 'ap-1', deviceId: 'ap-1', mac: null, name: null, model: null, ipAddress: null, state: 'ONLINE', endpointKey, inventoryDeviceId: null, features: ['accessPoint'], interfaces: ['radios'] };
    expect(physicalSourceSectionSchema.parse(sectionOf('unifi_device_list', [device])).rows[0]).toEqual(device);
    const detail = { rowKey: 'ap-1', deviceId: 'ap-1', uplinkDeviceId: null, uplinkPortIndex: null, ports: [], endpointKey, uplinkEndpointKey: null,
      radios: [{ frequencyGHz: 2.4, channel: null, channelWidthMHz: 20, wlanStandard: null }] };
    expect(physicalSourceSectionSchema.parse(sectionOf('unifi_device_details', [detail])).rows[0]).toEqual(detail);
  });
});
