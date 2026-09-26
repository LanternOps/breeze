import { describe, expect, it } from 'vitest';
import { buildPhysicalRelationship, unboundPhysicalNode, type PhysicalRowMaterial } from './physicalProjector';
import { macEndpointSourceKey } from './physicalIdentity';
import { MAX_PHYSICAL_RERESOLUTION_CHANGES, physicalResolver, reresolvePhysicalRelationships, type PhysicalPassState } from './physicalPublication';
import { FIXTURE_SCOPE, fixtureInterface, SWITCH } from './physicalFixtures';
import type { CollectionSource, SupportPublication } from './reconciliationTypes';
import type { NodePublication, RelationshipPublication } from './publish';

const SOURCE = '0d000000-0000-4000-8000-000000000001';
const ASSET_A = '0d000000-0000-4000-8000-0000000000aa';
const at = new Date('2026-09-20T00:00:00Z');
const mac = (i: number) => `02:${[(i >> 16) & 255, (i >> 8) & 255, i & 255, 0xaa, 0xbb].map(b => b.toString(16).padStart(2, '0')).join(':')}`;

/**
 * N FDB candidates on switch A port 5, published while the port's interface
 * was unknown (`if_index:default:5`). The interface is now known, so every
 * candidate re-resolves to an `if:<id>` key and its support must move.
 */
function candidates(n: number): PhysicalPassState {
  const nodes = new Map<string, NodePublication>();
  nodes.set(SWITCH.A, { ...FIXTURE_SCOPE, id: SWITCH.A, kind: 'endpoint', identityKey: 'switch-a', identityMaterial: { version: 1, kind: 'endpoint', sourceKey: 'switch-a' }, attributes: {}, lifecycle: 'active' });
  const relationships = new Map<string, RelationshipPublication>();
  const support = new Map<string, SupportPublication>();
  const rows: Record<string, string[]> = {};
  for (let i = 0; i < n; i++) {
    const material: PhysicalRowMaterial = { method: 'fdb', subjectAuthority: 'snmp:192.0.2.1', localPort: { namespace: 'if_index', value: '5', resolvedInterfaceKey: null },
      remoteChassis: { subtype: 'mac_address', value: mac(i) }, bridgeContext: 'default', fdbId: 1, vlanIds: [10] };
    const client = unboundPhysicalNode(FIXTURE_SCOPE, macEndpointSourceKey(mac(i)), undefined, new Map(), at);
    nodes.set(client.id, client);
    const rel = buildPhysicalRelationship(FIXTURE_SCOPE, material, { kind: 'candidate', sourceNodeId: SWITCH.A, sourceInterfaceId: null, targetNodeId: client.id,
      unboundSourceKey: macEndpointSourceKey(mac(i)), resolved: false }, client.id, undefined, at);
    relationships.set(rel.id, rel);
    rows[`default|1|${mac(i)}|5`] = [rel.id];
    support.set(`${SOURCE}:${rel.id}`, { ...FIXTURE_SCOPE, relationshipId: rel.id, sourceId: SOURCE, latestObservationId: null, producerEpoch: 'e', sequence: '1', contentDigest: 'd',
      firstPositiveAt: at, lastPositiveAt: at, effectiveAt: at, freshUntil: new Date(at.getTime() + 3_600_000), lifecycle: 'active', completeMissCount: 0 });
  }
  const iface = fixtureInterface('A', 5);
  return { scope: FIXTURE_SCOPE, at, sources: new Map([[SOURCE, { id: SOURCE, revokedAt: null } as CollectionSource]]), support, changedSupport: new Set(),
    relationships, nodes, interfaces: new Map([[iface.id, iface]]), baselines: new Map([[SOURCE, { _rowRelationships: rows }]]),
    newNodes: [], touchedRelationships: new Set(), archived: new Set(), rekeyed: new Set(), supportDeletes: [], lifecycleRemaps: [], observationRemaps: [], remappedBaselines: new Set() };
}
const resolverFor = (state: PhysicalPassState) => physicalResolver({ identityRevision: 1n, resolvedIdentityRevision: 0n, assets: [{ id: ASSET_A, ipAddress: '192.0.2.1' }], deviceMacs: [] },
  state.nodes, [{ ...FIXTURE_SCOPE, id: '0d000000-0000-4000-8000-0000000000bb', nodeId: SWITCH.A, discoveredAssetId: ASSET_A }]);

describe('physical re-resolution scale (#5998 review)', () => {
  it('moves every candidate to its resolved key and remaps the row mapping', () => {
    const state = candidates(3);
    expect(reresolvePhysicalRelationships(state, resolverFor(state))).toEqual({ complete: true, changes: 3 });
    const moved = [...state.support.values()];
    expect(moved).toHaveLength(3);
    for (const row of moved) expect(state.relationships.get(row.relationshipId)!.sourceInterfaceId).toBe(fixtureInterface('A', 5).id);
    const mapped = Object.values(state.baselines.get(SOURCE)!._rowRelationships as Record<string, string[]>).flat();
    expect(new Set(mapped)).toEqual(new Set(moved.map(r => r.relationshipId)));
    expect(state.archived.size).toBe(3);
  });

  // The pass used to rescan every support row and rewrite the whole row
  // mapping once per moved candidate (O(N^2) under the site lock). It is now
  // near-linear and bounded per publication: an incomplete pass keeps the
  // identity dirty mark and the next publication continues.
  it('re-resolves 5,000 candidates quickly, bounded per publication, and makes progress each time', () => {
    const state = candidates(5000);
    const resolver = resolverFor(state);
    const started = performance.now();
    const passes: { complete: boolean; changes: number }[] = [];
    for (let i = 0; i < 20; i++) {
      const pass = reresolvePhysicalRelationships(state, resolver);
      passes.push(pass);
      if (pass.complete) break;
    }
    const elapsed = performance.now() - started;
    expect(passes.at(-1)!.complete).toBe(true);
    expect(passes.every(p => p.changes <= MAX_PHYSICAL_RERESOLUTION_CHANGES)).toBe(true);
    expect(passes.slice(0, -1).every(p => !p.complete && p.changes === MAX_PHYSICAL_RERESOLUTION_CHANGES)).toBe(true);
    expect(passes.reduce((n, p) => n + p.changes, 0)).toBe(5000);
    expect(passes.length).toBe(Math.ceil(5000 / MAX_PHYSICAL_RERESOLUTION_CHANGES) + (5000 % MAX_PHYSICAL_RERESOLUTION_CHANGES === 0 ? 1 : 0));
    const mapped = Object.values(state.baselines.get(SOURCE)!._rowRelationships as Record<string, string[]>).flat();
    expect(new Set(mapped)).toEqual(new Set([...state.support.values()].map(r => r.relationshipId)));
    expect(elapsed).toBeLessThan(3000);
  });
});
