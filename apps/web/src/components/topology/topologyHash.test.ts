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

it('round-trips an open Explain investigation and its approved AI diagnostic run (M4)', () => {
  const SESSION = '71000000-0000-4000-8000-000000000001', RUN = '72000000-0000-4000-8000-000000000001';
  writeTopologyHash({ siteId: SITE, view: 'overview', selection: { kind: 'edge', id: EDGE }, search: '', investigationId: SESSION, aiRunId: RUN });
  expect(window.location.hash).toBe(`#topology/site/${SITE}/view/overview/edge/${EDGE}/explain/${SESSION}/airun/${RUN}`);
  expect(parseTopologyHash(window.location.hash)).toEqual({ siteId: SITE, view: 'overview', selection: { kind: 'edge', id: EDGE }, search: '', investigationId: SESSION, aiRunId: RUN });
  expect(parseTopologyHash('#topology/view/overview/explain/not-a-uuid')).toBeUndefined();
  expect(parseTopologyHash('#topology/view/overview/airun/../../x')).toBeUndefined();
});
