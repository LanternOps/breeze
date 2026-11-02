/**
 * listAssetCircuitDtos: asset -> binding -> owner node -> interfaces -> terminations.
 * The db is a queue-backed mock; the real visibility/redaction rules run. Anything
 * that needs real SQL semantics lives in circuitAssetView.integration.test.ts.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';

const ORG = '55555555-5555-4555-8555-555555555555';
const SITE_A = '11111111-1111-4111-8111-111111111111';
const SITE_B = '22222222-2222-4222-8222-222222222222';
const ASSET = '77777777-7777-4777-8777-777777777777';
const NODE = '88888888-8888-4888-8888-888888888888';

const m = vi.hoisted(() => ({
  queue: [] as unknown[][],
  wheres: [] as unknown[],
  getCircuitDtosByIds: vi.fn(),
}));

vi.mock('../db', () => ({
  db: {
    select: vi.fn(() => {
      const result = m.queue.shift() ?? [];
      const chain: Record<string, unknown> = {};
      for (const k of ['from', 'innerJoin', 'orderBy', 'limit']) chain[k] = () => chain;
      chain.where = (w: unknown) => { m.wheres.push(w); return chain; };
      chain.then = (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) => Promise.resolve(result).then(res, rej);
      return chain;
    }),
  },
}));
vi.mock('./circuits', async () => ({
  ...(await vi.importActual<object>('./circuits')),
  getCircuitDtosByIds: m.getCircuitDtosByIds,
}));

import { listAssetCircuitDtos, INTERFACE_LIST_CAP } from './circuitAssetView';
import type { CircuitDto } from './circuits';

const subject = { kind: 'device' as const, id: ASSET, orgId: ORG, siteId: SITE_A };
const open = { scope: { allowedSiteIds: null }, canAccessOrg: () => true, includeInterfaces: true };

function iface(n: number, extra: Record<string, unknown> = {}) {
  return { id: `i-${n}`, name: `eth${n}`, kind: 'ethernet', role: null, retiredAt: null, ...extra };
}

function circuitDto(id: string, state: CircuitDto['terminationState'], primary: string | null, served: string[] = []): CircuitDto {
  return {
    id, orgId: ORG, providerName: 'Acme', cid: id, bandwidthBps: null, serviceType: null, administrativeStatus: 'active',
    terminationState: state,
    termination: primary
      ? { interfaceId: 'x', interfaceName: 'x', asset: null, primarySite: { id: primary, name: 'P' }, placement: null }
      : null,
    additionalServedSites: served.map((s) => ({ id: s, name: `S-${s.slice(0, 2)}` })),
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
}

const sqlOf = (w: unknown) => new PgDialect().sqlToQuery(w as never);

beforeEach(() => {
  m.queue = [];
  m.wheres = [];
  m.getCircuitDtosByIds.mockReset();
});

describe('listAssetCircuitDtos', () => {
  it('reports an unbound asset with nothing else and runs no further queries', async () => {
    m.queue = [[]];
    const view = await listAssetCircuitDtos(subject, open);
    expect(view).toEqual({ bound: false, interfaces: [], interfacesTruncated: false, circuits: [] });
    expect(m.getCircuitDtosByIds).not.toHaveBeenCalled();
    expect(m.queue).toEqual([]);
  });

  it('returns current interfaces with the circuit id of a visible termination', async () => {
    m.queue = [
      [{ nodeId: NODE }],
      [{ circuitId: 'c1', interfaceId: 'i-1', name: 'eth1', kind: 'ethernet', role: 'wan', retiredAt: null }],
      [iface(1, { role: 'wan' }), iface(2)],
    ];
    m.getCircuitDtosByIds.mockResolvedValue([circuitDto('c1', 'assigned', SITE_A)]);
    const view = await listAssetCircuitDtos(subject, open);
    expect(view.bound).toBe(true);
    expect(view.circuits.map((c) => c.id)).toEqual(['c1']);
    expect(view.interfaces).toEqual([
      { id: 'i-1', name: 'eth1', kind: 'ethernet', role: 'wan', retired: false, circuitId: 'c1' },
      { id: 'i-2', name: 'eth2', kind: 'ethernet', role: null, retired: false, circuitId: null },
    ]);
    expect(view.interfacesTruncated).toBe(false);
    expect(m.getCircuitDtosByIds).toHaveBeenCalledWith(['c1'], ORG);
  });

  it('includes needs_reassociation through a retired interface of the own node, listing that retired interface', async () => {
    m.queue = [
      [{ nodeId: NODE }],
      [{ circuitId: 'c9', interfaceId: 'old', name: 'eth9', kind: 'ethernet', role: 'wan', retiredAt: '10:00:00' }],
      [iface(1)],
    ];
    m.getCircuitDtosByIds.mockResolvedValue([circuitDto('c9', 'needs_reassociation', null)]);
    const view = await listAssetCircuitDtos(subject, open);
    expect(view.circuits.map((c) => c.id)).toEqual(['c9']);
    expect(view.interfaces.map((i) => [i.id, i.retired, i.circuitId])).toEqual([
      ['i-1', false, null],
      ['old', true, 'c9'],
    ]);
  });

  it('omits an invisible circuit and leaks no circuitId, retired row or count for it', async () => {
    m.queue = [
      [{ nodeId: NODE }],
      [
        { circuitId: 'hidden', interfaceId: 'i-1', name: 'eth1', kind: 'ethernet', role: 'wan', retiredAt: null },
        { circuitId: 'hiddenOld', interfaceId: 'old', name: 'eth9', kind: 'ethernet', role: 'wan', retiredAt: '10:00:00' },
      ],
      [iface(1, { role: 'wan' })],
    ];
    m.getCircuitDtosByIds.mockResolvedValue([
      circuitDto('hidden', 'assigned', SITE_A),
      circuitDto('hiddenOld', 'needs_reassociation', null, [SITE_A]),
    ]);
    // Caller reaches only SITE_B: neither the primary site nor a served site matches.
    const view = await listAssetCircuitDtos(subject, { ...open, scope: { allowedSiteIds: [SITE_B] } });
    expect(view.circuits).toEqual([]);
    expect(view.interfaces).toEqual([{ id: 'i-1', name: 'eth1', kind: 'ethernet', role: 'wan', retired: false, circuitId: null }]);
    expect(JSON.stringify(view)).not.toMatch(/hidden|eth9|old/);
  });

  it('redacts served sites the caller cannot reach on a visible circuit', async () => {
    m.queue = [
      [{ nodeId: NODE }],
      [{ circuitId: 'c1', interfaceId: 'i-1', name: 'eth1', kind: 'ethernet', role: 'wan', retiredAt: null }],
      [iface(1)],
    ];
    m.getCircuitDtosByIds.mockResolvedValue([circuitDto('c1', 'assigned', SITE_A, [SITE_B])]);
    const view = await listAssetCircuitDtos(subject, { ...open, scope: { allowedSiteIds: [SITE_A] } });
    expect(view.circuits[0]!.additionalServedSites).toEqual([]);
  });

  it('drops circuits of an org the caller cannot access', async () => {
    m.queue = [
      [{ nodeId: NODE }],
      [{ circuitId: 'c1', interfaceId: 'i-1', name: 'eth1', kind: 'ethernet', role: 'wan', retiredAt: null }],
      [iface(1)],
    ];
    m.getCircuitDtosByIds.mockResolvedValue([circuitDto('c1', 'assigned', SITE_A)]);
    const view = await listAssetCircuitDtos(subject, { ...open, canAccessOrg: () => false });
    expect(view.circuits).toEqual([]);
    expect(view.interfaces[0]!.circuitId).toBeNull();
  });

  it('skips the interface query and returns no interfaces when not visible, but still returns circuits', async () => {
    m.queue = [
      [{ nodeId: NODE }],
      [{ circuitId: 'c1', interfaceId: 'i-1', name: 'eth1', kind: 'ethernet', role: 'wan', retiredAt: null }],
    ];
    m.getCircuitDtosByIds.mockResolvedValue([circuitDto('c1', 'assigned', SITE_A)]);
    const view = await listAssetCircuitDtos(subject, { ...open, includeInterfaces: false });
    expect(view.interfaces).toEqual([]);
    expect(view.interfacesTruncated).toBe(false);
    expect(view.circuits.map((c) => c.id)).toEqual(['c1']);
    expect(m.queue).toEqual([]);
  });

  it('does not look up circuits when the node has no terminations', async () => {
    m.queue = [[{ nodeId: NODE }], [], [iface(1)]];
    const view = await listAssetCircuitDtos(subject, open);
    expect(view.circuits).toEqual([]);
    expect(m.getCircuitDtosByIds).not.toHaveBeenCalled();
    expect(view.interfaces).toHaveLength(1);
  });

  it('caps current interfaces at the fixed ceiling and flags truncation', async () => {
    expect(INTERFACE_LIST_CAP).toBe(1000);
    const many = Array.from({ length: INTERFACE_LIST_CAP + 1 }, (_, n) => iface(n));
    m.queue = [[{ nodeId: NODE }], [], many];
    const view = await listAssetCircuitDtos(subject, open);
    expect(view.interfaces).toHaveLength(INTERFACE_LIST_CAP);
    expect(view.interfacesTruncated).toBe(true);
  });

  it('is not truncated at exactly the ceiling', async () => {
    const exact = Array.from({ length: INTERFACE_LIST_CAP }, (_, n) => iface(n));
    m.queue = [[{ nodeId: NODE }], [], exact];
    const view = await listAssetCircuitDtos(subject, open);
    expect(view.interfaces).toHaveLength(INTERFACE_LIST_CAP);
    expect(view.interfacesTruncated).toBe(false);
  });

  it('filters bindings, terminations and interfaces explicitly by org and site (defence in depth)', async () => {
    m.queue = [[{ nodeId: NODE }], [{ circuitId: 'c1', interfaceId: 'i-1', name: 'e', kind: 'k', role: null, retiredAt: null }], []];
    m.getCircuitDtosByIds.mockResolvedValue([]);
    await listAssetCircuitDtos(subject, open);
    expect(m.wheres).toHaveLength(3);
    for (const w of m.wheres) {
      const { params } = sqlOf(w);
      expect(params).toContain(ORG);
      expect(params).toContain(SITE_A);
    }
    // binding query is keyed on the subject asset and a live canonical node
    const binding = sqlOf(m.wheres[0]);
    expect(binding.params).toContain(ASSET);
    expect(binding.sql).toMatch(/deleted_at.*is null/i);
    expect(binding.sql).toMatch(/alias_target_id.*is null/i);
  });

  it('binds a discovered subject through discovered_asset_id', async () => {
    m.queue = [[]];
    await listAssetCircuitDtos({ ...subject, kind: 'discovered' }, open);
    expect(sqlOf(m.wheres[0]).sql).toContain('discovered_asset_id');
    expect(sqlOf(m.wheres[0]).sql).not.toContain('"device_id"');
  });
});
