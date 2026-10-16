import type { PresentationNode, PresenceVisitor } from '@breeze/shared';

/**
 * Where a cross-site visitor is drawn on the viewed site's map (site location spec S§9): in the network card whose prefix
 * equals the visitor's reported prefix and whose gateway set contains its reported gateway, preferring a declared card.
 * Everything else is `unplaced` and goes to the presentation-only "Visiting devices" card. Pure; reads only the card's own
 * `group.prefix` and `group.gatewayAddresses`.
 */
export function placeVisitors(groups: readonly PresentationNode[], visitors: readonly PresenceVisitor[]): { byGroup: Map<string, PresenceVisitor[]>; unplaced: PresenceVisitor[] } {
  const networks = groups.filter((node) => node.group?.kind === 'network' && node.group.prefix);
  const byGroup = new Map<string, PresenceVisitor[]>(), unplaced: PresenceVisitor[] = [];
  for (const visitor of visitors) {
    const matches = networks.filter((node) => node.group!.prefix === visitor.network.prefix && node.group!.gatewayAddresses.includes(visitor.network.gatewayAddress));
    const target = matches.find((node) => node.group!.declaration?.state === 'declared') ?? matches[0];
    if (!target) { unplaced.push(visitor); continue; }
    byGroup.set(target.id, [...(byGroup.get(target.id) ?? []), visitor]);
  }
  return { byGroup, unplaced };
}
