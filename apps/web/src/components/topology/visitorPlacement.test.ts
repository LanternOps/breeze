import { expect, it } from 'vitest';
import type { PresentationNode } from '@breeze/shared';
import { placeVisitors } from './visitorPlacement';
import { presenceVisitor } from './presenceFixtures';

const card = (id: string, prefix: string, gateways: string[], declaration: 'declared' | 'undeclared' | null, kind: 'network' | 'gateway' = 'network'): PresentationNode => ({
  id, role: 'network_group', label: prefix, memberCount: 0, view: 'overview', frontierToken: 't', authority: false,
  group: { kind, basis: 'inferred_site_prefix', networkClass: 'lan', prefix, address: null, gatewayAddresses: gateways, conflict: false, observerCount: 0, members: [], canonicalNodeIds: [],
    ...(declaration ? { declaration: { state: declaration, sources: [] } } : {}) } }) as unknown as PresentationNode;

it('places a visitor in the card with the same prefix whose gateway set contains its gateway, preferring declared cards', () => {
  const groups = [card('g2', '10.1.5.0/24', ['10.1.5.1'], 'undeclared'), card('g1', '10.1.5.0/24', ['10.1.5.1', '10.1.5.2'], 'declared'), card('g3', '10.1.5.0/24', ['10.1.5.254'], 'declared')];
  const placed = placeVisitors(groups, [presenceVisitor(1)]);
  expect(placed.byGroup.get('g1')).toHaveLength(1);
  expect(placed.byGroup.has('g2')).toBe(false);
  expect(placed.byGroup.has('g3')).toBe(false);
  expect(placed.unplaced).toEqual([]);
});

it('falls back to an undeclared matching card, and leaves a visitor with no matching prefix or gateway unplaced', () => {
  const groups = [card('g2', '10.1.5.0/24', ['10.1.5.1'], 'undeclared')];
  expect(placeVisitors(groups, [presenceVisitor(1)]).byGroup.get('g2')).toHaveLength(1);
  const other = placeVisitors(groups, [presenceVisitor(2, { network: { prefix: '10.1.9.0/24', gatewayAddress: '10.1.9.1' } }), presenceVisitor(3, { network: { prefix: '10.1.5.0/24', gatewayAddress: '10.1.5.77' } })]);
  expect(other.unplaced).toHaveLength(2);
  expect(other.byGroup.size).toBe(0);
});

it('ignores non-network cards even when their prefix matches', () => {
  expect(placeVisitors([card('gw', '10.1.5.0/24', ['10.1.5.1'], null, 'gateway')], [presenceVisitor(1)]).unplaced).toHaveLength(1);
});
