import { expect, it } from 'vitest';
import { parseDiscoveredAssetLinkSource } from './networkTypes';

it.each(['manual', 'auto', 'agent_report'] as const)('preserves %s provenance', source => {
  expect(parseDiscoveredAssetLinkSource(source)).toBe(source);
});

it.each([null, undefined, 'future_source', 42, {}])('rejects unknown provenance %j', source => {
  expect(parseDiscoveredAssetLinkSource(source)).toBeNull();
});
