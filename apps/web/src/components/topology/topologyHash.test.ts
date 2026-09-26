import { afterEach, expect, it } from 'vitest';
import { parseTopologyHash, writeTopologyHash } from './topologyHash';

const SITE = '11111111-1111-4111-8111-111111111111', EDGE = '61000000-0000-4000-8000-000000000002', PORT = '61000000-0000-4000-8000-000000000003';
afterEach(() => { window.location.hash = ''; });

it('round-trips the open port history and operations section alongside the selection', () => {
  writeTopologyHash({ siteId: SITE, view: 'physical', selection: { kind: 'edge', id: EDGE }, search: '', interfaceId: PORT, operations: true });
  expect(window.location.hash).toBe(`#topology/site/${SITE}/view/physical/edge/${EDGE}/iface/${PORT}/ops/1`);
  expect(parseTopologyHash(window.location.hash)).toEqual({ siteId: SITE, view: 'physical', selection: { kind: 'edge', id: EDGE }, search: '', interfaceId: PORT, operations: true });
});

it('rejects a malformed port id instead of reading history for it', () => {
  expect(parseTopologyHash(`#topology/view/overview/iface/not-a-uuid`)).toBeUndefined();
  expect(parseTopologyHash(`#topology/view/overview/ops/yes`)).toBeUndefined();
});
