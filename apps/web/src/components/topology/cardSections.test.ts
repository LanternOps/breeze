import { describe, expect, it } from 'vitest';
import type { RenderNode } from './renderProjection';
import type { TopologyGlyph } from './topologyGlyphs';
import { SECTION_ORDER, cardSummaries, memberRank, sectionHeaders, sectionOf } from './cardSections';

const tile = (id: string, glyph: TopologyGlyph, extra: Partial<RenderNode> = {}): RenderNode => ({ id, label: id, detail: null, kind: 'device', glyph, parent: 'card', presence: null,
  agentPresence: null, health: null, stale: false, unverified: false, corroborated: false, networkClass: null, memberCount: 0, address: null, note: null, ...extra });

describe('sectionOf', () => {
  it('maps every glyph into the fixed section order', () => {
    expect(SECTION_ORDER).toEqual(['network', 'servers', 'computers', 'phones', 'printers', 'other']);
    const cases: [TopologyGlyph, string][] = [['router', 'network'], ['firewall', 'network'], ['switch', 'network'], ['access_point', 'network'], ['server', 'servers'], ['nas', 'servers'],
      ['workstation', 'computers'], ['laptop', 'computers'], ['phone', 'phones'], ['printer', 'printers'], ['camera', 'other'], ['iot', 'other'], ['device', 'other']];
    for (const [glyph, section] of cases) expect(sectionOf(glyph)).toBe(section);
  });
});

describe('memberRank', () => {
  it('puts routers and firewalls before switches and access points, and unverified non-infrastructure last', () => {
    expect(memberRank(tile('r', 'router'))).toBeLessThan(memberRank(tile('s', 'switch')));
    expect(memberRank(tile('w', 'workstation', { unverified: true }))).toBeGreaterThan(memberRank(tile('w', 'workstation')));
    // Infrastructure placed by address match stays with the infrastructure.
    expect(memberRank(tile('s', 'switch', { unverified: true }))).toBe(memberRank(tile('s', 'switch')));
  });
});

describe('cardSummaries', () => {
  it('counts members per section in the fixed order, omitting empty sections, and counts agent presence only', () => {
    const nodes: RenderNode[] = [
      { ...tile('card', 'network'), kind: 'group', parent: undefined },
      tile('a', 'printer'), tile('b', 'workstation', { agentPresence: 'online' }), tile('c', 'laptop', { agentPresence: 'offline' }), tile('d', 'router'),
      tile('e', 'phone', { presence: 'online' /* a scan answer, not an agent */ }), tile('f', 'device'), tile('g', 'workstation', { agentPresence: 'unknown' }),
      tile('other-card-member', 'server', { parent: 'elsewhere' }), tile('loose', 'server', { parent: undefined }),
    ];
    const summary = cardSummaries(nodes).get('card')!;
    expect(summary.total).toBe(7);
    expect(summary.sections).toEqual([{ section: 'network', count: 1 }, { section: 'computers', count: 3 }, { section: 'phones', count: 1 }, { section: 'printers', count: 1 }, { section: 'other', count: 1 }]);
    expect(summary.agentsOnline).toBe(1);
    expect(summary.agentsOffline).toBe(1);
    expect(cardSummaries(nodes).get('elsewhere')!.total).toBe(1);
    expect(cardSummaries(nodes).has('loose')).toBe(false);
  });
});

describe('sectionHeaders', () => {
  const at = (id: string, glyph: TopologyGlyph, x: number, y: number) => ({ ...tile(id, glyph), x, y, width: 200, height: 60 });

  it('places one header per section above its first row, spanning the card members', () => {
    const headers = sectionHeaders([at('r', 'router', 100, 100), at('s', 'switch', 330, 100), at('w1', 'workstation', 100, 230), at('w2', 'workstation', 330, 230), at('w3', 'laptop', 560, 300)]);
    expect(headers.map((h) => [h.section, h.count])).toEqual([['network', 2], ['computers', 3]]);
    const [network, computers] = headers;
    expect(network!.parent).toBe('card');
    expect(network!.id).toBe('section:card:network');
    // Spans the full card width (x 0 … 660), not only that section's tiles.
    expect(network!.x - network!.width / 2).toBe(0);
    expect(network!.x + network!.width / 2).toBe(660);
    // Sits above the section's first row (tile tops at 70 and 200).
    expect(network!.y + network!.height / 2).toBeLessThanOrEqual(70);
    expect(computers!.y + computers!.height / 2).toBeLessThanOrEqual(200);
    expect(computers!.y).toBeGreaterThan(network!.y);
  });

  it('draws no headers on a card with a single section', () => {
    expect(sectionHeaders([at('w1', 'workstation', 100, 100), at('w2', 'laptop', 330, 100)])).toEqual([]);
  });
});
