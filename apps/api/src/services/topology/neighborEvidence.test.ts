import { describe, expect, it } from 'vitest';
import type { SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import {
  NEIGHBOR_SOURCE_CAP, buildNeighborEvidenceIndex, canonicalMac, qualifyNeighborRow, readNeighborEvidence, topologyOsContextKey,
  type InterfaceRowInput, type NeighborObserverBaseline, type NeighborRowInput,
} from './neighborEvidence';

const OBSERVER = '11111111-1111-4111-8111-111111111111';
const SOURCE = '22222222-2222-4222-8222-222222222222';
const PRODUCER = '33333333-3333-4333-8333-333333333333';
const NOW = new Date('2026-10-02T12:00:00.000Z');

const eth = (overrides: Partial<InterfaceRowInput> = {}): InterfaceRowInput => ({
  interfaceKey: 'if:eth0', name: 'eth0', kind: 'ethernet', adminState: 'up', operState: 'up', currentMac: '02:00:00:00:00:01',
  addresses: [
    { address: '10.1.2.10', prefixLength: 24, family: 'ipv4', zone: null, state: 'preferred' },
    { address: '192.168.7.1', prefixLength: 31, family: 'ipv4', zone: null, state: 'preferred' },
    { address: '2001:db8:1::10', prefixLength: 64, family: 'ipv6', zone: null, state: 'deprecated' },
    { address: 'fe80::10', prefixLength: 64, family: 'ipv6', zone: 'eth0', state: 'preferred' },
    { address: '10.9.9.9', prefixLength: 24, family: 'ipv4', zone: null, state: 'tentative' },
  ],
  ...overrides,
});
const row = (overrides: Partial<NeighborRowInput> = {}): NeighborRowInput => ({
  rowKey: 'n:1', address: '10.1.2.80', family: 'ipv4', zone: null, interfaceKey: 'if:eth0', mac: '00:11:22:33:44:55', state: 'reachable', isRouter: null,
  ...overrides,
});
const qualify = (neighbor: NeighborRowInput, interfaces: InterfaceRowInput[] = [eth()], addressFamily: 'any' | 'ipv4' | 'ipv6' = 'any') =>
  qualifyNeighborRow(neighbor, { addressFamily, interfaces });

describe('qualifyNeighborRow', () => {
  it.each([
    ['reachable'], ['stale'], ['delay'], ['probe'], ['permanent'], ['unknown'],
  ])('accepts a %s mapping as a cache mapping', (state) => {
    expect(qualify(row({ state }))).toMatchObject({ ok: true, prefix: '10.1.2.0/24', networkClass: 'lan', linkLocal: false });
  });

  it.each([['incomplete'], ['failed'], ['bogus']])('rejects a %s row', (state) => {
    expect(qualify(row({ state }))).toEqual({ ok: false, reason: 'state' });
  });

  it.each([
    ['null', null], ['zero', '00:00:00:00:00:00'], ['broadcast', 'ff:ff:ff:ff:ff:ff'], ['IPv4 multicast', '01:00:5e:00:00:fb'],
    ['IPv6 multicast', '33:33:00:00:00:01'], ['malformed', '00:11:22:33:44'],
  ])('rejects a %s MAC', (_name, mac) => {
    expect(qualify(row({ mac }))).toEqual({ ok: false, reason: 'mac' });
  });

  it('keeps a locally administered unicast MAC (randomised phones) eligible', () => {
    expect(qualify(row({ mac: '02:11:22:33:44:55' }))).toMatchObject({ ok: true });
    expect(qualify(row({ mac: 'AA-BB-CC-DD-EE-F0' }))).toMatchObject({ ok: true, mac: 'aa:bb:cc:dd:ee:f0' });
  });

  it.each([
    ['unspecified', '0.0.0.0'], ['loopback', '127.0.0.1'], ['multicast', '224.0.0.251'], ['limited broadcast', '255.255.255.255'],
    ['IPv4 network address', '10.1.2.0'], ['IPv4 subnet broadcast', '10.1.2.255'],
  ])('rejects the %s address', (_name, address) => {
    expect(qualify(row({ address }))).toMatchObject({ ok: false, reason: 'address' });
  });

  it.each([['::'], ['::1'], ['ff02::1']])('rejects the IPv6 address %s', (address) => {
    expect(qualify(row({ address, family: 'ipv6' }))).toMatchObject({ ok: false, reason: 'address' });
  });

  it('respects /31 (both addresses usable) and never accepts the observer itself', () => {
    expect(qualify(row({ address: '192.168.7.0' }))).toMatchObject({ ok: true, prefix: '192.168.7.0/31' });
    expect(qualify(row({ address: '10.1.2.10' }))).toEqual({ ok: false, reason: 'self' });
    expect(qualify(row({ mac: '02:00:00:00:00:01' }))).toEqual({ ok: false, reason: 'self' });
    // A /32 interface contains only itself.
    const host = eth({ addresses: [{ address: '10.5.5.5', prefixLength: 32, family: 'ipv4', zone: null, state: 'preferred' }] });
    expect(qualify(row({ address: '10.5.5.6' }), [host])).toEqual({ ok: false, reason: 'not_in_prefix' });
  });

  it('requires a preferred/deprecated interface prefix that contains the neighbour', () => {
    expect(qualify(row({ address: '10.3.3.3' }))).toEqual({ ok: false, reason: 'not_in_prefix' });
    // Tentative addresses do not count.
    expect(qualify(row({ address: '10.9.9.50' }))).toEqual({ ok: false, reason: 'not_in_prefix' });
    expect(qualify(row({ address: '2001:db8:1::99', family: 'ipv6' }))).toMatchObject({ ok: true, prefix: '2001:db8:1::/64', networkClass: 'lan' });
  });

  it('keeps zones as interface scope: link-local neighbours need the interface zone and stay link-local', () => {
    expect(qualify(row({ address: 'fe80::1', family: 'ipv6', zone: 'eth0' }))).toMatchObject({ ok: true, linkLocal: true, networkClass: 'link_local' });
    expect(qualify(row({ address: 'fe80::1', family: 'ipv6', zone: 'eth1' }))).toEqual({ ok: false, reason: 'not_in_prefix' });
    expect(qualify(row({ address: '169.254.3.3' }), [eth({ addresses: [{ address: '169.254.1.1', prefixLength: 16, family: 'ipv4', zone: null, state: 'preferred' }] })]))
      .toMatchObject({ ok: true, linkLocal: true });
  });

  it('rejects rows on a missing, down or tunnel interface', () => {
    expect(qualify(row({ interfaceKey: 'if:missing' }))).toEqual({ ok: false, reason: 'interface' });
    expect(qualify(row(), [eth({ operState: 'down' })])).toEqual({ ok: false, reason: 'interface_down' });
    expect(qualify(row(), [eth({ adminState: 'down' })])).toEqual({ ok: false, reason: 'interface_down' });
    // Unknown state is not "explicitly down".
    expect(qualify(row(), [eth({ operState: 'unknown' })])).toMatchObject({ ok: true });
    expect(qualify(row(), [eth({ kind: 'tunnel' })])).toEqual({ ok: false, reason: 'tunnel' });
  });

  it('classifies the containing prefix with the interface kind, like the overview (#7819)', () => {
    const cgnat = [{ address: '100.64.1.10', prefixLength: 16, family: 'ipv4', zone: null, state: 'preferred' }];
    // A genuine CGNAT LAN on Ethernet is a LAN, so its caches can corroborate.
    expect(qualify(row({ address: '100.64.1.80' }), [eth({ addresses: cgnat })])).toMatchObject({ ok: true, prefix: '100.64.0.0/16', networkClass: 'lan' });
    // With no kind evidence the CIDR guess still calls it an overlay.
    expect(qualify(row({ address: '100.64.1.80' }), [eth({ kind: 'unknown', addresses: cgnat })])).toMatchObject({ ok: true, networkClass: 'overlay' });
  });

  it('rejects a family mismatch with the row or the source scope', () => {
    expect(qualify(row({ family: 'ipv6' }))).toEqual({ ok: false, reason: 'address' });
    expect(qualify(row(), [eth()], 'ipv6')).toEqual({ ok: false, reason: 'address' });
  });
});

describe('canonicalMac', () => {
  it.each([
    ['00:11:22:33:44:55', '00:11:22:33:44:55'], ['00-11-22-33-44-55', '00:11:22:33:44:55'], ['0011.2233.4455', '00:11:22:33:44:55'],
    ['001122334455', '00:11:22:33:44:55'], [' AA:BB:CC:DD:EE:FF ', 'aa:bb:cc:dd:ee:ff'], ['00:11:22', null], ['', null], [null, null], ['zz:11:22:33:44:55', null],
  ])('canonicalises %s', (input, expected) => {
    expect(canonicalMac(input)).toBe(expected);
  });
});

describe('buildNeighborEvidenceIndex', () => {
  const baseline = (overrides: Partial<NeighborObserverBaseline> = {}): NeighborObserverBaseline => ({
    sourceId: SOURCE, observerNodeId: OBSERVER, observerLabel: 'DRT-HYG3', producerId: PRODUCER, contextKey: 'default', addressFamily: 'any',
    outcome: 'complete', omittedRowCount: 0, rowsTruncated: false,
    confirmedAt: '2026-10-02T11:55:00.000Z', expiresAt: '2026-10-02T12:10:00.000Z',
    rows: [row(), row({ rowKey: 'n:2', address: '10.1.2.81', state: 'failed' })],
    interfaces: { rows: [eth()], expiresAt: '2026-10-02T12:10:00.000Z' },
    interfaceIds: { 'if:eth0': '44444444-4444-4444-8444-444444444444' },
    ...overrides,
  });

  it('indexes qualifying tuples once, by canonical address, with provenance and freshness', () => {
    const index = buildNeighborEvidenceIndex({ baselines: [baseline()], limited: false }, NOW);
    expect(index.coverage).toBe('complete');
    expect(index.tupleCount).toBe(1);
    const [tuple] = index.byAddress.get('4:a010250')!;
    expect(tuple).toMatchObject({ observerNodeId: OBSERVER, observerLabel: 'DRT-HYG3', sourceId: SOURCE, rowKey: 'n:1', interfaceKey: 'if:eth0',
      interfaceId: '44444444-4444-4444-8444-444444444444', interfaceName: 'eth0', address: '10.1.2.80', mac: '00:11:22:33:44:55', state: 'reachable',
      prefix: '10.1.2.0/24', confirmedAt: '2026-10-02T11:55:00.000Z', expiresAt: '2026-10-02T12:10:00.000Z',
      context: topologyOsContextKey(PRODUCER, 'default') });
    expect(index.rejected).toMatchObject({ state: 1 });
  });

  it('drops expired or unknown freshness, including an expired interfaces baseline', () => {
    expect(buildNeighborEvidenceIndex({ baselines: [baseline({ expiresAt: '2026-10-02T11:59:59.000Z' })], limited: false }, NOW).tupleCount).toBe(0);
    expect(buildNeighborEvidenceIndex({ baselines: [baseline({ expiresAt: null })], limited: false }, NOW).tupleCount).toBe(0);
    expect(buildNeighborEvidenceIndex({ baselines: [baseline({ confirmedAt: null })], limited: false }, NOW).tupleCount).toBe(0);
    expect(buildNeighborEvidenceIndex({ baselines: [baseline({ interfaces: { rows: [eth()], expiresAt: '2026-10-02T11:00:00.000Z' } })], limited: false }, NOW).tupleCount).toBe(0);
    expect(buildNeighborEvidenceIndex({ baselines: [baseline({ interfaces: null })], limited: false }, NOW).tupleCount).toBe(0);
  });

  it('only uses positive outcomes', () => {
    expect(buildNeighborEvidenceIndex({ baselines: [baseline({ outcome: 'failed' })], limited: false }, NOW).tupleCount).toBe(0);
    expect(buildNeighborEvidenceIndex({ baselines: [baseline({ outcome: 'partial' })], limited: false }, NOW).tupleCount).toBe(1);
  });

  it('exposes limited coverage for truncated sections, row caps and read bounds — never absence', () => {
    expect(buildNeighborEvidenceIndex({ baselines: [baseline({ outcome: 'partial', omittedRowCount: 12 })], limited: false }, NOW)).toMatchObject({ coverage: 'limited', tupleCount: 1 });
    expect(buildNeighborEvidenceIndex({ baselines: [baseline({ rowsTruncated: true })], limited: false }, NOW).coverage).toBe('limited');
    expect(buildNeighborEvidenceIndex({ baselines: [baseline()], limited: true }, NOW).coverage).toBe('limited');
  });

  it('bounds the tuples it indexes across observers x contexts x rows', () => {
    const rows = Array.from({ length: 200 }, (_, i) => row({ rowKey: `n:${i}`, address: `10.1.2.${i + 20}` }));
    const many = Array.from({ length: 3 }, (_, i) => baseline({ sourceId: `22222222-2222-4222-8222-22222222222${i}`, contextKey: `ctx${i}`, rows }));
    const index = buildNeighborEvidenceIndex({ baselines: many, limited: false }, NOW, { tupleBudget: 450 });
    expect(index.tupleCount).toBe(450);
    expect(index.coverage).toBe('limited');
  });
});

describe('readNeighborEvidence query shape', () => {
  it('selects, orders and caps sources on cheap columns before any baseline payload is read', async () => {
    const executed: { sql: string; params: unknown[] }[] = [];
    const tx = { execute: async (query: SQL) => { executed.push(new PgDialect().sqlToQuery(query)); return []; } };
    await readNeighborEvidence(tx as never, { orgId: OBSERVER, siteId: SOURCE }, 'overview', { physical: true, excluded: new Set() }, ['10.1.2.80']);
    expect(executed).toHaveLength(1);
    const { sql: text, params } = executed[0]!;
    // Locate the source cap: the LIMIT whose parameter is NEIGHBOR_SOURCE_CAP + 1 (overflow is detectable).
    const capIndex = params.findIndex((value) => value === NEIGHBOR_SOURCE_CAP + 1);
    expect(capIndex).toBeGreaterThanOrEqual(0);
    const capAt = text.indexOf(`LIMIT $${capIndex + 1}`);
    expect(capAt).toBeGreaterThan(0);
    const beforeCap = text.slice(0, capAt);
    expect(beforeCap).toContain('topology_collection_sources');
    // Nothing up to the source cap may detoast or evaluate a baseline document.
    expect(beforeCap).not.toMatch(/baseline/);
  });

  it('asks nothing when there is nothing to ask about', async () => {
    const tx = { execute: async () => { throw new Error('no read expected'); } };
    await expect(readNeighborEvidence(tx as never, { orgId: OBSERVER, siteId: SOURCE }, 'overview', { physical: true, excluded: new Set() }, [])).resolves.toEqual({ baselines: [], limited: false });
  });
});
