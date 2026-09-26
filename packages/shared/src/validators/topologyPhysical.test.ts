import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import adjacencyVectors from '../testing/topology-adjacency-v2.json';
import unifiVectors from '../testing/topology-unifi-v1.json';
import {
  ADJACENCY_V2_MAX_BYTES,
  ADJACENCY_V2_FDB_MAX_ROWS,
  adjacencyFdbSectionSchema,
  adjacencyV2Schema,
  cdpRowSchema,
  fdbRowSchema,
  lldpRowSchema,
  parseAdjacencyV2Report,
  parseUnifiTopologyV1,
  unifiTopologyV1Schema,
} from './topologyPhysical';
import {
  canonicalizeAdjacencyReport,
  canonicalizeAdjacencyScope,
  canonicalizeUnifiResource,
} from './topologyPhysicalCanonical';

const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const clone = <T>(v: T): T => structuredClone(v);
const baseline = adjacencyVectors.vectors.find(v => v.name === 'baseline')!;
const positive = adjacencyVectors.vectors.find(v => v.name === 'lldp-cdp-positive')!;
type Json = Record<string, any>;
const report = (v = baseline): Json => clone(v.report) as Json;

const mac = (i: number) => `02:00:00:${((i >> 16) & 255).toString(16).padStart(2, '0')}:${((i >> 8) & 255).toString(16).padStart(2, '0')}:${(i & 255).toString(16).padStart(2, '0')}`;
function fdbRow(i: number, over: Json = {}): Json {
  const row = { bridgeContext: 'default', fdbId: 700, mac: mac(i), bridgePort: 7, ifIndex: 101, status: 'learned', vlans: [10], vlanMapping: 'complete', ...over };
  return { rowKey: `${row.bridgeContext}|${row.fdbId ?? '-'}|${row.mac}|${row.bridgePort}`, ...row };
}
function fdbSection(rows: Json[], over: Json = {}): Json {
  return { kind: 'fdb', contextKey: 'default', contentDigest: 'a'.repeat(64), outcome: 'complete', rowCount: rows.length, rows, ...over };
}
const lldpRow = (over: Json = {}): Json => ({
  rowKey: '7.1', timeMark: 400, remoteIndex: 1, localPort: { namespace: 'lldp_local', value: '7', resolvedInterfaceKey: null },
  remoteChassis: { subtype: 'mac_address', value: '02:00:00:00:00:01' }, remotePort: { subtype: 'interface_name', value: 'Gi0/1' }, ...over,
});

describe('adjacency v2 contract', () => {
  it('keeps complete-empty separate from failed and validates tagged ports', () => {
    const full = adjacencyV2Schema.parse(report());
    expect(full.reportKind).toBe('full');
    if (full.reportKind !== 'full') throw new Error('fixture must be full');
    expect(full.sections.find(s => s.kind === 'lldp')).toMatchObject({ outcome: 'complete', rowCount: 0, rows: [] });
    expect(full.sections.find(s => s.kind === 'cdp')).toMatchObject({ outcome: 'failed', reasonCode: 'timeout', rows: [] });
    const fdb = full.sections.find(s => s.kind === 'fdb');
    expect(fdb?.rows.every(r => 'fdbId' in r && r.fdbId !== null)).toBe(true);
    expect(adjacencyV2Schema.safeParse({ ...report(), version: 3 }).success).toBe(false);
    expect(adjacencyV2Schema.safeParse({ ...report(), sequence: '-1' }).success).toBe(false);
    expect(parseAdjacencyV2Report({ ...report(), version: 3 })).toEqual({ accepted: false, reason: 'unsupported_major_version' });
    expect(parseAdjacencyV2Report(report()).accepted).toBe(true);
  });

  it('parses the positive vector with typed ids, BRIDGE-only FDB and CDP ifIndex ports', () => {
    const full = adjacencyV2Schema.parse(report(positive));
    if (full.reportKind !== 'full') throw new Error('full');
    const lldp = full.sections.find(s => s.kind === 'lldp')!;
    expect(lldp.rows).toHaveLength(2);
    const cdp = full.sections.find(s => s.kind === 'cdp')!;
    expect(cdp.rows[0]).toMatchObject({ localPort: { namespace: 'if_index' } });
    const fdb = full.sections.find(s => s.kind === 'fdb')!;
    expect(fdb.rows[0]).toMatchObject({ fdbId: null, vlanMapping: 'unknown', vlans: [] });
  });

  it.each([
    [0, true], [ADJACENCY_V2_FDB_MAX_ROWS, true], [ADJACENCY_V2_FDB_MAX_ROWS + 1, false],
  ])('bounds FDB rows per section: %i rows accepted=%s', (n, ok) => {
    const rows = Array.from({ length: n }, (_, i) => fdbRow(i));
    expect(adjacencyFdbSectionSchema.safeParse(fdbSection(rows)).success).toBe(ok);
  });

  it('rejects manifest totals above the FDB bound', () => {
    const r = report();
    r.finalManifest.scopes.find((s: Json) => s.kind === 'fdb').rowCount = ADJACENCY_V2_FDB_MAX_ROWS + 1;
    expect(adjacencyV2Schema.safeParse(r).success).toBe(false);
  });

  it.each([[255, true], [256, false]])('caps string keys at 255 UTF-8 bytes (%i bytes accepted=%s)', (bytes, ok) => {
    const name = 'é'.repeat(Math.floor(bytes / 2)) + 'x'.repeat(bytes % 2);
    expect(new TextEncoder().encode(name).length).toBe(bytes);
    expect(lldpRowSchema.safeParse(lldpRow({ remoteSysName: name })).success).toBe(ok);
  });

  it.each(['18446744073709551616', '01', '1.0', '', ' 1'])('rejects invalid uint64 sequence %j', sequence => {
    expect(adjacencyV2Schema.safeParse({ ...report(), sequence }).success).toBe(false);
  });

  it.each([
    [[1], 'complete', true], [[4094], 'complete', true], [[0], 'complete', false], [[4095], 'complete', false],
    [[20, 10], 'complete', false], [[10, 10], 'complete', false], [[], 'complete', false], [[10], 'unknown', false],
    [[], 'unknown', true], [[10], 'partial', true], [[], 'partial', true],
  ])('validates VLAN set %j with mapping %s (accepted=%s)', (vlans, vlanMapping, ok) => {
    expect(fdbRowSchema.safeParse(fdbRow(1, { vlans, vlanMapping })).success).toBe(ok);
  });

  it('rejects duplicate and non-derived row keys', () => {
    expect(adjacencyFdbSectionSchema.safeParse(fdbSection([fdbRow(1), fdbRow(1)])).success).toBe(false);
    expect(fdbRowSchema.safeParse({ ...fdbRow(1), rowKey: 'arbitrary' }).success).toBe(false);
    expect(lldpRowSchema.safeParse(lldpRow({ rowKey: '400.7.1' })).success).toBe(false);
  });

  it('keeps FDB identity distinct from VLAN identity and allows BRIDGE-only null FDB ids', () => {
    expect(fdbRowSchema.safeParse(fdbRow(1, { fdbId: null, vlans: [], vlanMapping: 'unknown' })).success).toBe(true);
    expect(fdbRowSchema.safeParse(fdbRow(1, { fdbId: null, vlans: [10], vlanMapping: 'complete' })).success).toBe(false);
  });

  it('pins port namespaces: CDP local ports are ifIndex, LLDP local ports are lldp_local', () => {
    const cdp = { rowKey: '3.1', deviceIndex: 1, localPort: { namespace: 'if_index', value: '3', resolvedInterfaceKey: null }, remoteDevice: { subtype: 'cdp_device_id', value: 'edge-sw' }, remotePort: { subtype: 'interface_name', value: 'Fa0/3' } };
    expect(cdpRowSchema.safeParse(cdp).success).toBe(true);
    expect(cdpRowSchema.safeParse({ ...cdp, localPort: { ...cdp.localPort, namespace: 'bridge_port' } }).success).toBe(false);
    expect(lldpRowSchema.safeParse(lldpRow({ localPort: { namespace: 'if_index', value: '7', resolvedInterfaceKey: null } })).success).toBe(false);
    expect(lldpRowSchema.safeParse(lldpRow({ localPort: { namespace: 'lldp_local', value: 'Gi0/7', resolvedInterfaceKey: null } })).success).toBe(false);
  });

  it('validates MAC-typed ids only when the subtype says MAC', () => {
    expect(lldpRowSchema.safeParse(lldpRow({ remoteChassis: { subtype: 'mac_address', value: '0011223344' } })).success).toBe(false);
    expect(lldpRowSchema.parse(lldpRow({ remoteChassis: { subtype: 'mac_address', value: '02-00-00-00-00-0A' } })).remoteChassis.value).toBe('02:00:00:00:00:0a');
    // A six-byte arbitrary locally-assigned id is not a MAC and stays opaque.
    expect(lldpRowSchema.parse(lldpRow({ remoteChassis: { subtype: 'local', value: '020000000001' } })).remoteChassis).toEqual({ subtype: 'local', value: '020000000001' });
  });

  it('rejects manifest/section count, outcome, omission and digest mismatches', () => {
    const scope = (r: Json, kind: string) => r.finalManifest.scopes.find((s: Json) => s.kind === kind);
    const count = report(positive); scope(count, 'lldp').rowCount = 3;
    expect(adjacencyV2Schema.safeParse(count).success).toBe(false);
    const outcome = report(positive); scope(outcome, 'lldp').outcome = 'partial';
    expect(adjacencyV2Schema.safeParse(outcome).success).toBe(false);
    const digest = report(positive); scope(digest, 'cdp').contentDigest = 'b'.repeat(64);
    expect(adjacencyV2Schema.safeParse(digest).success).toBe(false);
    const omitted = report(positive); scope(omitted, 'fdb').omittedRowCount = 5;
    expect(adjacencyV2Schema.safeParse(omitted).success).toBe(false);
    const missing = report(); missing.sections = missing.sections.filter((s: Json) => s.kind !== 'cdp');
    expect(adjacencyV2Schema.safeParse(missing).success).toBe(false);
    const undeclared = report(); undeclared.finalManifest.scopes = undeclared.finalManifest.scopes.filter((s: Json) => s.kind !== 'cdp');
    expect(adjacencyV2Schema.safeParse(undeclared).success).toBe(false);
    const noManifest = report(); delete noManifest.finalManifest;
    expect(adjacencyV2Schema.safeParse(noManifest).success).toBe(false);
  });

  it('enforces the 4 MiB whole-body bound and forbidden authority keys before parsing', () => {
    const fits = report(); fits.padding = 'x'.repeat(ADJACENCY_V2_MAX_BYTES - JSON.stringify(fits).length - 20);
    expect(parseAdjacencyV2Report(fits).accepted).toBe(true);
    const big = report(); big.padding = 'x'.repeat(ADJACENCY_V2_MAX_BYTES);
    expect(parseAdjacencyV2Report(big)).toMatchObject({ accepted: false, reason: 'invalid_report' });
    const forged = report(); forged.source.orgId = '10000000-0000-4000-8000-000000000001';
    expect(parseAdjacencyV2Report(forged)).toMatchObject({ accepted: false, reason: 'invalid_report' });
    const minor = report(); minor.futureOptional = true;
    expect(parseAdjacencyV2Report(minor).accepted).toBe(true);
  });

  it('keeps full and unchanged fields exclusive', () => {
    const { sections: _s, finalManifest: _m, ...header } = report();
    const unchanged = { ...header, reportKind: 'unchanged', baseSnapshotId: '20000000-0000-4000-8000-000000000009' };
    expect(adjacencyV2Schema.safeParse(unchanged).success).toBe(true);
    expect(adjacencyV2Schema.safeParse({ ...unchanged, sections: [] }).success).toBe(false);
    expect(adjacencyV2Schema.safeParse({ ...unchanged, finalManifest: report().finalManifest }).success).toBe(false);
    expect(adjacencyV2Schema.safeParse({ ...report(), baseSnapshotId: unchanged.baseSnapshotId }).success).toBe(false);
  });

  it('rejects duplicate section scopes', () => {
    const r = report(); r.sections.push(clone(r.sections[0]));
    expect(adjacencyV2Schema.safeParse(r).success).toBe(false);
  });
});

describe('adjacency v2 canonicalization', () => {
  const identity = (v: typeof baseline, full: Json) => ({ sourceIdentity: v.sourceIdentity, producerEpoch: full.producerEpoch, source: full.source });

  it('matches frozen cross-language vectors', () => {
    for (const vector of adjacencyVectors.vectors) {
      const full = adjacencyV2Schema.parse(vector.report);
      if (full.reportKind !== 'full') throw new Error('full');
      const id = identity(vector, full);
      const reportBytes = canonicalizeAdjacencyReport(id, full.sections);
      expect(reportBytes).toBe(vector.expected.reportCanonical);
      expect(sha(reportBytes)).toBe(full.contentDigest);
      for (const s of full.sections) {
        const bytes = canonicalizeAdjacencyScope(id, s);
        const exp = vector.expected.sections.find(x => x.kind === s.kind && x.contextKey === s.contextKey)!;
        expect(bytes).toBe(exp.canonical);
        expect(sha(bytes)).toBe(s.contentDigest);
      }
    }
  });

  it('excludes timeMark, sequence, timestamps and parent ids; keeps outcomes, omissions, typed ids and scope', () => {
    const parse = (r: Json) => { const f = adjacencyV2Schema.parse(r); if (f.reportKind !== 'full') throw new Error('full'); return f; };
    const a = parse(report(positive));
    const digest = (f: typeof a, sourceIdentity = positive.sourceIdentity) => canonicalizeAdjacencyReport({ sourceIdentity, producerEpoch: f.producerEpoch, source: f.source }, f.sections);
    const base = digest(a);
    const meta = report(positive);
    Object.assign(meta, { sequence: '99', capturedAt: '2026-09-15T13:00:00Z', parentJobId: '20000000-0000-4000-8000-0000000000aa', parentCommandId: '20000000-0000-4000-8000-0000000000bb' });
    meta.sections.find((s: Json) => s.kind === 'lldp').rows.forEach((r: Json) => { r.timeMark += 1000; });
    meta.sections.reverse();
    expect(digest(parse(meta))).toBe(base);
    expect(digest(a, 'other-source')).not.toBe(base);
    const outcome = report(positive);
    outcome.sections.find((s: Json) => s.kind === 'cdp').outcome = 'partial';
    outcome.finalManifest.scopes.find((s: Json) => s.kind === 'cdp').outcome = 'partial';
    expect(digest(parse(outcome))).not.toBe(base);
    const typed = report(positive);
    typed.sections.find((s: Json) => s.kind === 'lldp').rows[0].remotePort.subtype = 'interface_alias';
    expect(digest(parse(typed))).not.toBe(base);
    const scope = report(positive); scope.source.address = '192.0.2.99'; scope.source.sourceKey = 'snmp:192.0.2.99';
    expect(digest(parse(scope))).not.toBe(base);
    const lldp = a.sections.find(s => s.kind === 'lldp')!;
    const omitted = { ...lldp, outcome: 'partial' as const, reasonCode: 'limit_exceeded', omittedRowCount: 4 };
    const id = { sourceIdentity: positive.sourceIdentity, producerEpoch: a.producerEpoch, source: a.source };
    expect(canonicalizeAdjacencyScope(id, omitted)).not.toBe(canonicalizeAdjacencyScope(id, lldp));
  });
});

describe('unifi topology v1 contract', () => {
  const vector = unifiVectors.vectors[0]!;
  const body = (): Json => clone(vector.report) as Json;

  it('preserves client type, partial resources and null capabilities', () => {
    const parsed = unifiTopologyV1Schema.parse(body());
    const clients = parsed.resources.find(r => r.kind === 'client_list')!;
    const vpn = clients.rows.find(r => 'clientType' in r && r.clientType === 'VPN');
    expect(vpn).toMatchObject({ uplinkPortIndex: null, ssid: null, vlan: null, signalDbm: null });
    expect(parsed.resources.find(r => r.kind === 'device_details')).toMatchObject({ outcome: 'partial' });
    expect(parseUnifiTopologyV1({ ...body(), version: 2 })).toEqual({ accepted: false, reason: 'unsupported_major_version' });
  });

  it('accepts the wire fixture through the transport guard: a controller deviceId is not Breeze authority', () => {
    expect(parseUnifiTopologyV1(body())).toMatchObject({ accepted: true });
    for (const forbidden of ['orgId', 'siteId', 'agentId', 'producerId', 'partnerId']) {
      const t = body(); t.resources[0].rows[0][forbidden] = 'x';
      expect(parseUnifiTopologyV1(t)).toMatchObject({ accepted: false, reason: 'invalid_report' });
    }
    // Only the typed row field is exempt; a deviceId anywhere else is still refused.
    expect(parseUnifiTopologyV1({ ...body(), deviceId: 'x' })).toMatchObject({ accepted: false });
  });

  it('rejects unknown client types, duplicate site resources and rows on failed resources', () => {
    const t = body(); t.resources.find((r: Json) => r.kind === 'client_list').rows[0].clientType = 'wireless';
    expect(unifiTopologyV1Schema.safeParse(t).success).toBe(false);
    const d = body(); d.resources.push(clone(d.resources[0]));
    expect(unifiTopologyV1Schema.safeParse(d).success).toBe(false);
    const f = body(); const list = f.resources.find((r: Json) => r.kind === 'device_list'); list.outcome = 'failed';
    expect(unifiTopologyV1Schema.safeParse(f).success).toBe(false);
    const k = body(); k.resources.find((r: Json) => r.kind === 'device_list').rows[0].rowKey = 'other';
    expect(unifiTopologyV1Schema.safeParse(k).success).toBe(false);
  });

  it('matches frozen per-resource digests and ignores metadata', () => {
    const parsed = unifiTopologyV1Schema.parse(body());
    for (const r of parsed.resources) {
      const bytes = canonicalizeUnifiResource({ sourceIdentity: vector.sourceIdentity, producerEpoch: parsed.producerEpoch }, r);
      const exp = vector.expected.resources.find(x => x.kind === r.kind && x.controllerSiteId === r.controllerSiteId)!;
      expect(bytes).toBe(exp.canonical);
      expect(sha(bytes)).toBe(r.contentDigest);
    }
    const moved = body(); moved.sequence = '42'; moved.capturedAt = '2026-09-15T12:30:00Z';
    moved.resources.forEach((r: Json) => r.rows.reverse());
    const m = unifiTopologyV1Schema.parse(moved);
    for (const r of m.resources) {
      expect(sha(canonicalizeUnifiResource({ sourceIdentity: vector.sourceIdentity, producerEpoch: m.producerEpoch }, r))).toBe(r.contentDigest);
    }
  });
});
