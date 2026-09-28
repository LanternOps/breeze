import { renderHook, waitFor } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import { useTopologyInterfaceHistory } from './useTopologyInterfaceHistory';
import { topologyApi } from './topologyApi';
import { fetchWithAuth } from '../../stores/auth';

vi.mock('../../stores/auth', () => ({ fetchWithAuth: vi.fn() }));

const SITE = '20000000-0000-4000-8000-000000000001';
const IF = '30000000-0000-4000-8000-000000000001';
const REL = '40000000-0000-4000-8000-000000000001';
const SOURCE = '50000000-0000-4000-8000-000000000001';
const at = '2026-09-01T00:00:00.000Z';
const history = {
  interfaceId: IF, interfaceEpoch: 'gen:1', resolution: '5m', interval: { from: at, to: '2026-09-01T00:05:00.000Z', bucketSeconds: 300 },
  series: [{ name: 'in_bps', unit: 'bits_per_second', interfaceEpoch: 'gen:1', sourceId: SOURCE, sourceKind: 'snmp', producerEpoch: 'p1', coverage: 'complete',
    points: [{ at, value: 10, min: 5, max: 15, validDurationMs: 300000, sampleCount: 5, gapDurationMs: 0, reasons: [] }], gaps: [], reasons: [] }],
  epochs: [{ interfaceEpoch: 'gen:1', sourceId: SOURCE, sourceKind: 'snmp', producerEpoch: 'p1', current: true, sourceState: 'active', from: at, to: '2026-09-01T00:05:00.000Z' }],
  coverage: 'complete', reasons: [], asOf: at,
};
const json = (payload: unknown, status = 200) => new Response(JSON.stringify(payload), { status });
const query = { series: ['in_bps' as const], from: '2026-09-01T00:00:00Z', to: '2026-09-01T00:05:00Z' };

beforeEach(() => { vi.mocked(fetchWithAuth).mockReset(); });

it('reads bounded history with a GET that carries only the contract parameters', async () => {
  vi.mocked(fetchWithAuth).mockResolvedValue(json(history));
  const { result } = renderHook(() => useTopologyInterfaceHistory({ siteId: SITE }, IF, query));
  await waitFor(() => expect(result.current.history).not.toBeNull());
  expect(result.current.history!.series[0]!.points[0]!.value).toBe(10);
  const [url, options] = vi.mocked(fetchWithAuth).mock.calls[0]!;
  expect(String(url)).toBe(`/topology/sites/${SITE}/interfaces/${IF}/history?series=in_bps&from=2026-09-01T00%3A00%3A00Z&to=2026-09-01T00%3A05%3A00Z`);
  expect(options?.method ?? 'GET').toBe('GET');
});

it('does nothing without an interface and surfaces a denied read as an error with no data', async () => {
  const idle = renderHook(() => useTopologyInterfaceHistory({ siteId: SITE }, null, query));
  expect(idle.result.current).toMatchObject({ history: null, loading: false, error: null });
  expect(fetchWithAuth).not.toHaveBeenCalled();
  vi.mocked(fetchWithAuth).mockResolvedValue(json({ error: 'Topology subject not found', code: 'topology_subject_not_found' }, 404));
  const { result } = renderHook(() => useTopologyInterfaceHistory({ siteId: SITE }, IF, query));
  await waitFor(() => expect(result.current.error).toBe('Topology subject not found'));
  expect(result.current.history).toBeNull();
});

it('rejects a response that breaks the shared contract rather than rendering it', async () => {
  vi.mocked(fetchWithAuth).mockResolvedValue(json({ ...history, series: [{ ...history.series[0], unit: 'percent' }] }));
  const { result } = renderHook(() => useTopologyInterfaceHistory({ siteId: SITE }, IF, query));
  await waitFor(() => expect(result.current.error).not.toBeNull());
  expect(result.current.history).toBeNull();
});

it('parses link health through the shared contract', async () => {
  const health = { status: 'unknown', coverage: 'unmonitored', scope: 'relationship', originNodeId: null, resultId: null, reasons: [{ code: 'no_monitor_binding', message: 'x' }], freshness: 'unknown' };
  vi.mocked(fetchWithAuth).mockResolvedValue(json({ siteId: SITE, relationshipId: REL, graphRevision: '1', healthRevision: '2', health, freshUntil: null,
    interfaceEvidence: { applies: false, reason: 'not_a_physical_link' }, endpoints: { source: null, target: null }, asOf: at }));
  const link = await topologyApi.linkHealth(SITE, REL);
  expect(link.interfaceEvidence.reason).toBe('not_a_physical_link');
  expect(String(vi.mocked(fetchWithAuth).mock.calls[0]![0])).toBe(`/topology/sites/${SITE}/relationships/${REL}/health`);
});
