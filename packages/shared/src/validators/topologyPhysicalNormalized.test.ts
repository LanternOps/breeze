import { describe, expect, it } from 'vitest';
import vectors from '../testing/topology-fdb-normalization-v1.json';
import { adjacencyFdbSectionSchema } from './topologyPhysical';
import {
  FDB_SHARED_PORT_MAC_THRESHOLD,
  fdbSharedPortBucket,
  isEligibleFdbRow,
  normalizeFdbSection,
  normalizedFdbSectionSchema,
  physicalSourceSectionSchema,
} from './topologyPhysicalNormalized';

describe('FDB normalization (D13) shared vectors', () => {
  it('pins the threshold and size buckets the Go mirror must reproduce', () => {
    expect(FDB_SHARED_PORT_MAC_THRESHOLD).toBe(vectors.threshold);
    for (const [count, bucket] of vectors.buckets) expect(fdbSharedPortBucket(count as number)).toBe(bucket);
  });
  for (const vector of vectors.vectors) {
    it(`normalizes ${vector.name}`, () => {
      const section = adjacencyFdbSectionSchema.parse(vector.input);
      const normalized = normalizeFdbSection(section);
      expect(normalized).toEqual(vector.expected);
      expect(normalizedFdbSectionSchema.parse(normalized)).toEqual(vector.expected);
    });
  }
  it('is order-independent and deterministic', () => {
    const input = adjacencyFdbSectionSchema.parse(vectors.vectors[0]!.input);
    const reversed = { ...input, rows: [...input.rows].reverse() };
    expect(normalizeFdbSection(reversed)).toEqual(normalizeFdbSection(input));
  });
  it('treats only learned unicast non-zero MACs as eligible', () => {
    const base = adjacencyFdbSectionSchema.parse(vectors.vectors[1]!.input).rows[0]!;
    expect(isEligibleFdbRow(base)).toBe(true);
    expect(isEligibleFdbRow({ ...base, status: 'self' })).toBe(false);
    expect(isEligibleFdbRow({ ...base, mac: '03:00:00:00:00:01' })).toBe(false);
    expect(isEligibleFdbRow({ ...base, mac: '00:00:00:00:00:00' })).toBe(false);
  });
});

describe('normalized physical source sections', () => {
  it('rejects a shared_port row whose key does not match its port', () => {
    const expected = structuredClone(vectors.vectors[0]!.expected) as { rows: { rowType?: string; rowKey: string }[] };
    const shared = expected.rows.find(r => r.rowType === 'shared_port')!;
    shared.rowKey = 'shared_port|default|999';
    expect(normalizedFdbSectionSchema.safeParse(expected).success).toBe(false);
  });
  it('rejects a port with both per-MAC and shared_port rows', () => {
    const expected = structuredClone(vectors.vectors[0]!.expected) as { rows: unknown[]; rowCount: number };
    const extra = { rowType: 'shared_port', rowKey: 'shared_port|default|7', bridgeContext: 'default', bridgePort: 7, ifIndex: 107, sizeBucket: '17-64' };
    expected.rows.push(extra); expected.rowCount += 1;
    expect(normalizedFdbSectionSchema.safeParse(expected).success).toBe(false);
  });
  it('rejects more than 16 per-MAC eligible MACs on one port (must be shared)', () => {
    const expected = structuredClone(vectors.vectors[0]!.expected) as { rows: Record<string, unknown>[]; rowCount: number };
    const template = expected.rows.find(r => r.bridgePort === 7)!;
    const mac = '02:00:00:07:aa:aa';
    expected.rows.push({ ...template, mac, rowKey: `default|700|${mac}|7` }); expected.rowCount += 1;
    expect(normalizedFdbSectionSchema.safeParse(expected).success).toBe(false);
  });
  it('uses a distinct snmp_interfaces kind so M1 OS interfaces are never shadowed', () => {
    const parsed = physicalSourceSectionSchema.safeParse({ kind: 'interfaces', contextKey: 'x', contentDigest: 'a'.repeat(64), outcome: 'complete', rowCount: 0, rows: [] });
    expect(parsed.success).toBe(false);
    expect(physicalSourceSectionSchema.parse({ kind: 'snmp_interfaces', contextKey: 'x', contentDigest: 'a'.repeat(64), outcome: 'complete', rowCount: 0, rows: [] }).kind).toBe('snmp_interfaces');
    expect(physicalSourceSectionSchema.parse({ kind: 'unifi_client_list', contextKey: 'c:s', contentDigest: 'a'.repeat(64), outcome: 'failed', rowCount: 0, rows: [] }).kind).toBe('unifi_client_list');
  });
});
