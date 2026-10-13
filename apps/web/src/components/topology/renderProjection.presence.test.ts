import { describe, expect, it } from 'vitest';
import type { GraphResponse } from '@breeze/shared';
import { compileTopologyRender, renderLayoutKey, ENGLISH_RENDER_TEXT } from './renderProjection';
import { cardSummaries } from './cardSections';
import { groupedGraphFixture } from './groupedGraphFixture';
import { SITE } from './topologyFixtures';
import { LAKESIDE, MAIN_OFFICE, presenceAssigned, presenceDeviceId, presenceFixture, presenceVisitor } from './presenceFixtures';

/** Binds the nth fixture endpoint (HOST-*) to a Breeze device id, the way a real device-backed node is bound. */
function bound(graph: GraphResponse, bindings: Record<string, number>): GraphResponse {
  return { ...graph, nodes: graph.nodes.map((n) => bindings[n.label] === undefined ? n
    : { ...n, bindings: [{ id: n.id, type: 'device' as const, referenceId: presenceDeviceId(bindings[n.label]!) }] }) };
}
const NET0 = 'presentation:overview:scope:net-0';
const OPTS = { showAllNetworks: false, text: ENGLISH_RENDER_TEXT };

describe('home map: a device assigned here that is visiting another site', () => {
  const base = () => bound(groupedGraphFixture([{ prefix: '10.1.2.0/24', declaration: 'declared', members: 3 }]), { 'HOST-0-0': 1 });

  it('leaves its network card, while the card keeps its server member count', () => {
    const graph = base();
    const presence = presenceFixture({ siteId: SITE, assigned: [presenceAssigned(1)], counts: { observedElsewhere: 1, unidentified: 0, unknown: 0, visiting: 0 } });
    const without = compileTopologyRender(graph, OPTS), withPresence = compileTopologyRender(graph, OPTS, presence);
    expect(without.nodes.map((n) => n.label)).toContain('HOST-0-0');
    expect(withPresence.nodes.map((n) => n.label)).not.toContain('HOST-0-0');
    expect(withPresence.nodes.filter((n) => n.parent === NET0)).toHaveLength(2);
    expect(withPresence.nodes.find((n) => n.id === NET0)!.memberCount).toBe(3);
  });

  it('is not listed twice: it is removed from the undeclared-network roster too', () => {
    const graph = bound(groupedGraphFixture([{ prefix: '10.1.2.0/24', declaration: 'declared', members: 2 }, { prefix: '10.1.5.0/24', declaration: 'undeclared', members: 2 }]), { 'HOST-1-0': 1 });
    const presence = presenceFixture({ siteId: SITE, assigned: [presenceAssigned(1)] });
    const roster = compileTopologyRender(graph, OPTS, presence).roster;
    expect(roster.flatMap((r) => r.memberNodeIds)).toHaveLength(1);
    expect(compileTopologyRender(graph, OPTS).roster.flatMap((r) => r.memberNodeIds)).toHaveLength(2);
  });

  it('keeps the device when presence says it is unrecognized or presence belongs to another site', () => {
    const graph = base();
    const unrecognized = presenceFixture({ siteId: SITE, assigned: [presenceAssigned(1, { state: 'unrecognized', matchedSite: null })] });
    expect(compileTopologyRender(graph, OPTS, unrecognized).nodes.map((n) => n.label)).toContain('HOST-0-0');
    const foreign = presenceFixture({ siteId: LAKESIDE.id, assigned: [presenceAssigned(1)] });
    expect(compileTopologyRender(graph, OPTS, foreign).nodes.map((n) => n.label)).toContain('HOST-0-0');
  });
});

describe('visited map: visitors from other sites', () => {
  const lakeside = () => groupedGraphFixture([{ prefix: '10.1.5.0/24', declaration: 'declared', members: 2 }]);
  const presenceWith = (...visitors: ReturnType<typeof presenceVisitor>[]) => presenceFixture({ siteId: SITE, visitors, counts: { observedElsewhere: 0, unidentified: 0, unknown: 0, visiting: visitors.length } });

  it('draws a visitor tile in its network card: neutral Visiting marker, "Assigned to" subtitle, text alternative, no address, not a member', () => {
    const graph = lakeside();
    const render = compileTopologyRender(graph, OPTS, presenceWith(presenceVisitor(1)));
    const tile = render.nodes.find((n) => n.label === 'LAPTOP-LOV-01')!;
    expect(tile).toMatchObject({ kind: 'visitor', parent: 'presentation:overview:scope:net-0', detail: 'Assigned to Main Office', visiting: true,
      note: 'Visiting device, assigned to Main Office', address: null, health: null, presence: null, agentPresence: null, sharedWith: 0 });
    const card = render.nodes.find((n) => n.id === 'presentation:overview:scope:net-0')!;
    expect(card.memberCount).toBe(2);
    expect(card.detail).toContain('+1 visiting');
    expect(cardSummaries(render.nodes).get(card.id)!.total).toBe(2);
    expect(render.site.devices).toBe(2);
  });

  it('flags only a visitor carrying a wrong-site suggestion (W3 "Move suggested" marker)', () => {
    const suggestion = { siteId: SITE, siteName: 'Lakeside', days: 9, firstObservedAt: '2026-09-14T08:00:00.000Z', lastObservedAt: '2026-10-02T18:00:00.000Z' };
    const render = compileTopologyRender(lakeside(), OPTS, presenceWith(presenceVisitor(1, { suggestion }), presenceVisitor(2, { label: 'WIN-HD4M8T2C9' })));
    expect(render.nodes.find((n) => n.label === 'LAPTOP-LOV-01')).toMatchObject({ visiting: true, suggested: true });
    expect(render.nodes.find((n) => n.label === 'WIN-HD4M8T2C9')!.suggested).toBeUndefined();
  });

  it('puts a visitor with no matching card in a presentation-only "Visiting devices" card labelled with the prefix', () => {
    const render = compileTopologyRender(lakeside(), OPTS, presenceWith(presenceVisitor(1, { network: { prefix: '10.1.9.0/24', gatewayAddress: '10.1.9.1' } })));
    const card = render.nodes.find((n) => n.id.startsWith('presentation:overview:visiting:'))!;
    expect(card).toMatchObject({ kind: 'group', memberCount: 0 });
    expect(card.label).toBe('Visiting devices (10.1.9.0/24)');
    expect(render.nodes.find((n) => n.kind === 'visitor')!.parent).toBe(card.id);
    expect(render.grouped).toBe(true);
  });

  it('never places a visitor in a card that is not drawn (an undeclared network moved to the roster)', () => {
    const graph = groupedGraphFixture([{ prefix: '10.1.2.0/24', declaration: 'declared', members: 2 }, { prefix: '10.1.5.0/24', declaration: 'undeclared', members: 2 }]);
    const render = compileTopologyRender(graph, OPTS, presenceWith(presenceVisitor(1)));
    expect(render.nodes.find((n) => n.kind === 'visitor')!.parent).toMatch(/^presentation:overview:visiting:/);
  });

  it('draws nothing extra without presence, and ignores presence for another site', () => {
    const none = compileTopologyRender(lakeside(), OPTS);
    expect(none.nodes.some((n) => n.kind === 'visitor')).toBe(false);
    expect(compileTopologyRender(lakeside(), OPTS, presenceFixture({ siteId: LAKESIDE.id, visitors: [presenceVisitor(1)] })).nodes.some((n) => n.kind === 'visitor')).toBe(false);
  });

  it('never re-runs layout for a refresh that only moves freshUntil / observedAt', () => {
    const graph = lakeside();
    const first = compileTopologyRender(graph, OPTS, presenceWith(presenceVisitor(1)));
    const refreshed = compileTopologyRender(graph, OPTS, presenceWith(presenceVisitor(1, { freshUntil: '2026-10-12T11:12:00Z', observedAt: '2026-10-12T10:12:00Z' })));
    expect(renderLayoutKey(refreshed.nodes)).toBe(renderLayoutKey(first.nodes));
    const another = compileTopologyRender(graph, OPTS, presenceWith(presenceVisitor(1), presenceVisitor(2)));
    expect(renderLayoutKey(another.nodes)).not.toBe(renderLayoutKey(first.nodes));
    expect(MAIN_OFFICE.name).toBe('Main Office');
  });
});
