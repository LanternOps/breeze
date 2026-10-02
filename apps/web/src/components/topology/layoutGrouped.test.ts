import ELK from 'elkjs/lib/elk.bundled.js';
import { describe, expect, it } from 'vitest';
import { computeTopologyLayout, packTopologyLayout } from './layoutAdapter';
import { findOverlaps } from './layoutFixtures';
import type { LayoutBox, LayoutRequest, LayoutResult } from './layoutTypes';

/** A Whalers-shaped site: one gateway, one LAN card with 30 devices, a small second LAN, an unidentified card and one ungrouped device. */
function groupedRequest(mode: LayoutRequest['mode'] = 'reflow', positions: LayoutRequest['positions'] = []): LayoutRequest {
  const tile = (id: string, groupId: string, rank = 3): LayoutBox => ({ id, width: 208, height: 60, role: 'device', groupId, rank, name: id });
  const nodes: LayoutBox[] = [
    { id: 'gw', width: 232, height: 64, role: 'gateway' },
    { id: 'lan', width: 0, height: 0, role: 'group' },
    { id: 'lan2', width: 0, height: 0, role: 'group' },
    { id: 'unid', width: 0, height: 0, role: 'unidentified' },
    { id: 'loose', width: 208, height: 60, role: 'device' },
    ...Array.from({ length: 30 }, (_, i) => tile(`pc-${String(i).padStart(2, '0')}`, 'lan', i % 3 === 0 ? 0 : 3)),
    ...Array.from({ length: 3 }, (_, i) => tile(`home-${i}`, 'lan2')),
    ...Array.from({ length: 5 }, (_, i) => tile(`phone-${i}`, 'unid', 5)),
  ];
  return { requestId: 'r', graphRevision: '1', layoutRevision: '0', measurementRevision: 'm', algorithmVersion: 'v', nodes,
    edges: [{ id: 'rv', source: 'gw', target: 'lan' }, { id: 'rv2', source: 'gw', target: 'lan2' }], positions, mode };
}
const members = (request: LayoutRequest, group: string) => request.nodes.filter((node) => node.groupId === group).map((node) => node.id);
function bounds(result: LayoutResult, request: LayoutRequest, ids: string[]) {
  const boxes = new Map(request.nodes.map((node) => [node.id, node]));
  const points = result.positions.filter((p) => ids.includes(p.nodeId));
  return { x1: Math.min(...points.map((p) => p.x - boxes.get(p.nodeId)!.width / 2)), x2: Math.max(...points.map((p) => p.x + boxes.get(p.nodeId)!.width / 2)),
    y1: Math.min(...points.map((p) => p.y - boxes.get(p.nodeId)!.height / 2)), y2: Math.max(...points.map((p) => p.y + boxes.get(p.nodeId)!.height / 2)) };
}
const disjoint = (a: ReturnType<typeof bounds>, b: ReturnType<typeof bounds>) => a.x2 <= b.x1 || b.x2 <= a.x1 || a.y2 <= b.y1 || b.y2 <= a.y1;

describe('grouped two-stage layout', () => {
  it('packs every group into its own compact, non-overlapping region and never positions the group box itself', async () => {
    const request = groupedRequest();
    const result = await computeTopologyLayout(request, new ELK());
    expect(result.warning).toBeUndefined();
    expect(findOverlaps(result, request)).toEqual([]);
    expect(result.positions.map((p) => p.nodeId)).not.toEqual(expect.arrayContaining(['lan']));
    for (const id of ['lan', 'lan2', 'unid']) expect(result.positions.some((p) => p.nodeId === id)).toBe(false);
    expect(result.positions).toHaveLength(request.nodes.length - 3);
    const lan = bounds(result, request, members(request, 'lan')), lan2 = bounds(result, request, members(request, 'lan2')), unid = bounds(result, request, members(request, 'unid'));
    expect(disjoint(lan, lan2) && disjoint(lan, unid) && disjoint(lan2, unid)).toBe(true);
    for (const loose of ['gw', 'loose']) {
      const point = bounds(result, request, [loose]);
      expect(disjoint(point, lan) && disjoint(point, lan2) && disjoint(point, unid)).toBe(true);
    }
    // A grid, not a strip: the LAN card is no more than ~3x taller than wide and the other way round.
    const aspect = (lan.x2 - lan.x1) / (lan.y2 - lan.y1);
    expect(aspect).toBeGreaterThan(1 / 3); expect(aspect).toBeLessThan(3);
  });

  it('ranks the gateway above the networks that route via it', async () => {
    const request = groupedRequest();
    const result = await computeTopologyLayout(request, new ELK());
    const gw = bounds(result, request, ['gw']);
    expect(gw.y2).toBeLessThanOrEqual(bounds(result, request, members(request, 'lan')).y1);
    expect(gw.y2).toBeLessThanOrEqual(bounds(result, request, members(request, 'lan2')).y1);
  });

  it('orders members by rank then name inside the card (infrastructure first)', async () => {
    const request = groupedRequest();
    const result = await computeTopologyLayout(request, new ELK());
    const order = result.positions.filter((p) => p.nodeId.startsWith('pc-')).sort((a, b) => a.y - b.y || a.x - b.x).map((p) => p.nodeId);
    const firstRanked = request.nodes.filter((n) => n.groupId === 'lan' && n.rank === 0).map((n) => n.id).sort();
    expect(order.slice(0, firstRanked.length)).toEqual(firstRanked);
  });

  it('is deterministic', async () => {
    const request = groupedRequest();
    expect((await computeTopologyLayout(request, new ELK())).positions).toEqual((await computeTopologyLayout(request, new ELK())).positions);
  });

  it('keeps a pinned member exactly where it was and packs the rest of its card around it', async () => {
    const pin = { nodeId: 'pc-05', x: 5_000, y: 5_000, pinned: true };
    const request = groupedRequest('reflow', [pin]);
    const result = await computeTopologyLayout(request, new ELK());
    expect(result.positions.find((p) => p.nodeId === 'pc-05')).toEqual(pin);
    expect(findOverlaps(result, request)).toEqual([]);
  });

  it('never anchors a card on unpinned saved positions (old flat layouts); only real pins hold a member in place', async () => {
    const saved = { nodeId: 'pc-07', x: -9_000, y: -9_000, pinned: false };
    for (const mode of ['reflow', 'incremental'] as const) {
      const request = groupedRequest(mode, [saved]);
      const result = await computeTopologyLayout(request, new ELK());
      expect(result.positions.find((p) => p.nodeId === 'pc-07')).not.toEqual(saved);
      const lan = bounds(result, request, members(request, 'lan'));
      expect(lan.x2 - lan.x1).toBeLessThan(3_000);
    }
  });

  it('keeps a saved top-level position on incremental placement (existing contract for ungrouped tiles)', async () => {
    const saved = { nodeId: 'loose', x: 7_000, y: 7_000, pinned: false };
    expect((await computeTopologyLayout(groupedRequest('incremental', [saved]), new ELK())).positions.find((p) => p.nodeId === 'loose')).toEqual(saved);
  });

  it('falls back without ELK yet keeps cards together and collision-free', () => {
    const request = groupedRequest();
    const result = packTopologyLayout(request, undefined, true);
    expect(result.warning).toBe('layout_fallback');
    expect(findOverlaps(result, request)).toEqual([]);
    const lan = bounds(result, request, members(request, 'lan')), unid = bounds(result, request, members(request, 'unid'));
    expect(disjoint(lan, unid)).toBe(true);
  });
});
