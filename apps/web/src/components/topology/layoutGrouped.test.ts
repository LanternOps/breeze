import ELK from 'elkjs/lib/elk.bundled.js';
import { describe, expect, it } from 'vitest';
import { computeTopologyLayout, packTopologyLayout } from './layoutAdapter';
import { findOverlaps } from './layoutFixtures';
import type { LayoutBox, LayoutRequest, LayoutResult } from './layoutTypes';
import { SECTION_BAND } from './cardSections';

/** A large-site shape: one gateway, one LAN card with 30 devices, a small second LAN, an unidentified card and one ungrouped device. */
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

  it('puts the primary (largest) network first, with smaller networks beside it', async () => {
    // Harbor Dental demo shape: a big LAN via one gateway, a 3-device LAN via its own gateway
    // whose ids sort first, and a VPN gateway one big-LAN member routes to.
    const tile = (id: string, groupId: string): LayoutBox => ({ id, width: 208, height: 60, role: 'device', groupId, section: 2, rank: 3, name: id });
    const request: LayoutRequest = { requestId: 'r', graphRevision: '1', layoutRevision: '0', measurementRevision: 'm', algorithmVersion: 'v', mode: 'reflow', positions: [],
      nodes: [{ id: 'zz-gw', width: 236, height: 64, role: 'gateway' }, { id: 'aa-gw', width: 236, height: 64, role: 'gateway' }, { id: 'mm-vpn', width: 236, height: 64, role: 'gateway' },
        { id: 'zz-lan', width: 0, height: 0, role: 'group' }, { id: 'aa-lan', width: 0, height: 0, role: 'group' },
        ...Array.from({ length: 40 }, (_, i) => tile(`pc-${String(i).padStart(2, '0')}`, 'zz-lan')), ...Array.from({ length: 3 }, (_, i) => tile(`aa-${i}`, 'aa-lan'))],
      edges: [{ id: 'rv1', source: 'zz-gw', target: 'zz-lan' }, { id: 'rv2', source: 'aa-gw', target: 'aa-lan' }, { id: 'vpn', source: 'pc-07', target: 'mm-vpn' }] };
    const result = await computeTopologyLayout(request, new ELK());
    expect(findOverlaps(result, request)).toEqual([]);
    expect(bounds(result, request, members(request, 'zz-lan')).x1).toBeLessThan(bounds(result, request, members(request, 'aa-lan')).x1);
  });

  it('is deterministic', async () => {
    const request = groupedRequest();
    expect((await computeTopologyLayout(request, new ELK())).positions).toEqual((await computeTopologyLayout(request, new ELK())).positions);
  });

  // Revised Q3 (2026-10-03, #7880): a pin never places a member inside its card.
  it('packs pinned card members in the card grid, never at their saved coordinates', async () => {
    // Two scattered legacy pins: the old rule kept both and hung the rest of the grid below them.
    const pins = [{ nodeId: 'pc-05', x: 5_000, y: 5_000, pinned: true }, { nodeId: 'pc-20', x: 2_000, y: 9_000, pinned: true }];
    const unpinned = await computeTopologyLayout(groupedRequest(), new ELK());
    for (const mode of ['reflow', 'incremental'] as const) {
      const request = groupedRequest(mode, pins);
      const result = await computeTopologyLayout(request, new ELK());
      for (const pin of pins) {
        const placed = result.positions.find((p) => p.nodeId === pin.nodeId)!;
        expect({ x: placed.x, y: placed.y }).not.toEqual({ x: pin.x, y: pin.y });
        expect(placed.pinned).toBe(true);
      }
      expect(findOverlaps(result, request)).toEqual([]);
      // The card is the unpinned grid, moved as one block: every member is shifted by the same offset.
      const shift = (id: string) => {
        const a = result.positions.find((p) => p.nodeId === id)!, b = unpinned.positions.find((p) => p.nodeId === id)!;
        return [Math.round(a.x - b.x), Math.round(a.y - b.y)];
      };
      const offsets = new Set(members(request, 'lan').map((id) => JSON.stringify(shift(id))));
      expect(offsets.size).toBe(1);
    }
  });

  it('anchors a card so its pinned members sit on the centroid of their saved pins', async () => {
    const pins = [{ nodeId: 'pc-05', x: 5_000, y: 5_000, pinned: true }, { nodeId: 'pc-20', x: 5_400, y: 5_200, pinned: true }];
    const request = groupedRequest('reflow', pins);
    const result = await computeTopologyLayout(request, new ELK());
    const placed = pins.map((pin) => result.positions.find((p) => p.nodeId === pin.nodeId)!);
    // Neither member is at its own pin: the pins move the card, the grid places the members.
    expect(placed[0]!.x).not.toBeCloseTo(5_000); expect(placed[1]!.x).not.toBeCloseTo(5_400);
    expect((placed[0]!.x + placed[1]!.x) / 2).toBeCloseTo(5_200);
    expect((placed[0]!.y + placed[1]!.y) / 2).toBeCloseTo(5_100);
    expect(findOverlaps(result, request)).toEqual([]);
  });

  it('turns a pile of legacy member pins into a readable grid (37 pins on one card)', async () => {
    const pile = Array.from({ length: 20 }, (_, i) => ({ nodeId: `pc-${String(i).padStart(2, '0')}`, x: 100 + (i % 4) * 30, y: 100 + (i % 5) * 20, pinned: true }));
    const request = groupedRequest('incremental', pile);
    const result = await computeTopologyLayout(request, new ELK());
    expect(findOverlaps(result, request)).toEqual([]);
    const lan = bounds(result, request, members(request, 'lan'));
    const aspect = (lan.x2 - lan.x1) / (lan.y2 - lan.y1);
    expect(aspect).toBeGreaterThan(1 / 3); expect(aspect).toBeLessThan(3);
  });

  it('a whole-card drag (every member pinned at its grid spot, shifted) keeps the card exactly where it was dropped', async () => {
    const first = await computeTopologyLayout(groupedRequest(), new ELK());
    const lanIds = new Set(members(groupedRequest(), 'lan'));
    const dropped = first.positions.filter((p) => lanIds.has(p.nodeId)).map((p) => ({ ...p, x: p.x + 3_000, y: p.y + 1_000, pinned: true }));
    const again = await computeTopologyLayout(groupedRequest('incremental', dropped), new ELK());
    for (const pin of dropped) {
      const placed = again.positions.find((p) => p.nodeId === pin.nodeId)!;
      expect(placed.x).toBeCloseTo(pin.x, 6); expect(placed.y).toBeCloseTo(pin.y, 6); expect(placed.pinned).toBe(true);
    }
  });

  it('an anchored card yields to a pinned ungrouped node instead of being drawn under it', async () => {
    // Legacy pins pile card members where the gateway is pinned too.
    const pins = [{ nodeId: 'gw', x: 400, y: 150, pinned: true },
      ...Array.from({ length: 12 }, (_, i) => ({ nodeId: `pc-${String(i * 2).padStart(2, '0')}`, x: 300 + (i % 4) * 60, y: 120 + Math.floor(i / 4) * 30, pinned: true }))];
    for (const fallback of [false, true]) {
      const request = groupedRequest('incremental', pins);
      const result = fallback ? packTopologyLayout(request, undefined, true) : await computeTopologyLayout(request, new ELK());
      expect(result.positions.find((p) => p.nodeId === 'gw')).toEqual(pins[0]);
      expect(findOverlaps(result, request)).toEqual([]);
      expect(disjoint(bounds(result, request, ['gw']), bounds(result, request, members(request, 'lan')))).toBe(true);
    }
  });

  it('keeps an unpinned gateway above a pin-anchored card that lands on its row (it clears upward, not under the card)', async () => {
    const free = await computeTopologyLayout(groupedRequest(), new ELK());
    const gw = free.positions.find((p) => p.nodeId === 'gw')!;
    // Legacy pins drag the LAN card up over the gateway's own row.
    const pins = Array.from({ length: 6 }, (_, i) => ({ nodeId: `pc-${String(i * 3).padStart(2, '0')}`, x: gw.x + (i % 3) * 200, y: gw.y + Math.floor(i / 3) * 80, pinned: true }));
    for (const mode of ['reflow', 'incremental'] as const) {
      const request = groupedRequest(mode, pins);
      const result = await computeTopologyLayout(request, new ELK());
      expect(findOverlaps(result, request)).toEqual([]);
      expect(bounds(result, request, ['gw']).y2).toBeLessThanOrEqual(bounds(result, request, members(request, 'lan')).y1);
      // The rest of the auto-layout moves with the anchored card: the second LAN still hangs below its gateway.
      expect(bounds(result, request, ['gw']).y2).toBeLessThanOrEqual(bounds(result, request, members(request, 'lan2')).y1);
    }
  });

  it('moves the rest of the auto-layout with a pin-anchored card, so a sibling card it lands on keeps its gateway above it', async () => {
    const free = await computeTopologyLayout(groupedRequest(), new ELK());
    const home = bounds(free, groupedRequest(), members(groupedRequest(), 'lan2'));
    // Legacy pins drag the big LAN card onto the spot ELK gave the small second LAN.
    const pins = Array.from({ length: 4 }, (_, i) => ({ nodeId: `pc-${String(i * 7).padStart(2, '0')}`, x: (home.x1 + home.x2) / 2 + (i % 2) * 220, y: (home.y1 + home.y2) / 2 + Math.floor(i / 2) * 80, pinned: true }));
    for (const mode of ['reflow', 'incremental'] as const) {
      const request = groupedRequest(mode, pins);
      const result = await computeTopologyLayout(request, new ELK());
      expect(findOverlaps(result, request)).toEqual([]);
      const gw = bounds(result, request, ['gw']), lan = bounds(result, request, members(request, 'lan')), lan2 = bounds(result, request, members(request, 'lan2'));
      expect(gw.y2).toBeLessThanOrEqual(lan.y1);
      expect(gw.y2).toBeLessThanOrEqual(lan2.y1);
    }
  });

  it('still honours pins on ungrouped nodes (gateway, loose device)', async () => {
    const pins = [{ nodeId: 'gw', x: -3_000, y: -3_000, pinned: true }, { nodeId: 'loose', x: 9_000, y: 40, pinned: true }];
    const result = await computeTopologyLayout(groupedRequest('reflow', pins), new ELK());
    for (const pin of pins) expect(result.positions.find((p) => p.nodeId === pin.nodeId)).toEqual(pin);
  });

  it('orders card members by IP numerically, then by name', async () => {
    const request = groupedRequest();
    const lan2 = request.nodes.filter((node) => node.groupId === 'lan2');
    lan2[0]!.address = '10.1.2.137'; lan2[1]!.address = '10.1.2.14'; lan2[2]!.address = undefined;
    const result = await computeTopologyLayout(request, new ELK());
    const order = result.positions.filter((p) => p.nodeId.startsWith('home-')).sort((a, b) => a.y - b.y || a.x - b.x).map((p) => p.nodeId);
    expect(order).toEqual(['home-1', 'home-0', 'home-2']);
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

  it('starts every role section on a new row, in section order, with a header band above each section', async () => {
    const request = groupedRequest();
    // lan: 10 network devices (section 0), 20 computers (section 2), interleaved in input order.
    for (const node of request.nodes) if (node.groupId === 'lan') node.section = Number(node.id.slice(3)) % 3 === 0 ? 0 : 2;
    const result = await computeTopologyLayout(request, new ELK());
    expect(findOverlaps(result, request)).toEqual([]);
    const at = new Map(result.positions.map((p) => [p.nodeId, p]));
    const lan = request.nodes.filter((n) => n.groupId === 'lan');
    const net = lan.filter((n) => n.section === 0), pcs = lan.filter((n) => n.section === 2);
    const lastNetRow = Math.max(...net.map((n) => at.get(n.id)!.y)), firstPcRow = Math.min(...pcs.map((n) => at.get(n.id)!.y));
    // No row mixes sections, and the computers start below the network rows by more than one plain row step.
    expect(new Set(net.map((n) => at.get(n.id)!.y)).size + new Set(pcs.map((n) => at.get(n.id)!.y)).size)
      .toBe(new Set(lan.map((n) => at.get(n.id)!.y)).size);
    const rowStep = 60 + 16;
    expect(firstPcRow - lastNetRow).toBeGreaterThanOrEqual(rowStep + SECTION_BAND);
    // Section bands make the sectioned card taller than the same members packed plainly.
    const plain = await computeTopologyLayout(groupedRequest(), new ELK());
    expect(bounds(result, request, members(request, 'lan')).y2 - bounds(result, request, members(request, 'lan')).y1)
      .toBeGreaterThan(bounds(plain, request, members(request, 'lan')).y2 - bounds(plain, request, members(request, 'lan')).y1);
  });

  it('reserves no header band on a card whose members share one section', async () => {
    const plain = await computeTopologyLayout(groupedRequest(), new ELK());
    const request = groupedRequest();
    for (const node of request.nodes) if (node.groupId === 'lan2') node.section = 2;
    const result = await computeTopologyLayout(request, new ELK());
    const height = (r: LayoutResult) => { const b = bounds(r, request, members(request, 'lan2')); return b.y2 - b.y1; };
    expect(height(result)).toBe(height(plain));
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
