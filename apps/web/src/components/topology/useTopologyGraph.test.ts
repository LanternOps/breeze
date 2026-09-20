import { renderHook, waitFor, act } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { useTopologyGraph } from './useTopologyGraph';
import { topologyGraphFixture, SITE, NODE } from './topologyFixtures';
import { fetchWithAuth } from '../../stores/auth';

vi.mock('../../stores/auth', () => ({ fetchWithAuth: vi.fn() }));

const jsonResponse = (payload: unknown, status = 200) => new Response(JSON.stringify(payload), { status });

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  vi.mocked(fetchWithAuth).mockReset();
  Object.defineProperty(document, 'hidden', { configurable: true, value: false });
});
afterEach(() => { vi.useRealTimers(); });

it('loads the graph passively on mount with no non-GET request', async () => {
  vi.mocked(fetchWithAuth).mockResolvedValue(jsonResponse(topologyGraphFixture()));
  const { result } = renderHook(() => useTopologyGraph({ siteId: SITE }, { view: 'overview' }));
  await waitFor(() => expect(result.current.graph).not.toBeNull());
  expect(result.current.error).toBeNull();
  expect(vi.mocked(fetchWithAuth).mock.calls.every(([, options]) => !options?.method || options.method === 'GET')).toBe(true);
});

it('polls health every 15 seconds and merges it into existing structure without touching the graph revision', async () => {
  const base = topologyGraphFixture();
  vi.mocked(fetchWithAuth).mockImplementation(async (url) => {
    const target = String(url);
    if (target.includes('/health')) {
      return jsonResponse({ siteId: SITE, graphRevision: base.revisions.graph, healthRevision: '2',
        nodes: [{ id: NODE, health: { ...base.nodes[0].health, status: 'healthy' } }], relationships: [] });
    }
    return jsonResponse(base);
  });
  const { result } = renderHook(() => useTopologyGraph({ siteId: SITE }, { view: 'overview' }));
  await waitFor(() => expect(result.current.graph).not.toBeNull());
  expect(result.current.graph!.nodes[0].health.status).toBe('unknown');
  await act(async () => { await vi.advanceTimersByTimeAsync(15_000); });
  await waitFor(() => expect(result.current.graph!.nodes[0].health.status).toBe('healthy'));
  expect(result.current.graph!.revisions.graph).toBe(base.revisions.graph);
  expect(result.current.graph!.revisions.health).toBe('2');
});

it('discards a health response whose graph revision no longer matches the latest structure', async () => {
  const base = topologyGraphFixture();
  vi.mocked(fetchWithAuth).mockImplementation(async (url) => {
    const target = String(url);
    if (target.includes('/health')) {
      return jsonResponse({ siteId: SITE, graphRevision: 'stale', healthRevision: '2',
        nodes: [{ id: NODE, health: { ...base.nodes[0].health, status: 'healthy' } }], relationships: [] });
    }
    return jsonResponse(base);
  });
  const { result } = renderHook(() => useTopologyGraph({ siteId: SITE }, { view: 'overview' }));
  await waitFor(() => expect(result.current.graph).not.toBeNull());
  await act(async () => { await vi.advanceTimersByTimeAsync(15_000); });
  expect(result.current.graph!.nodes[0].health.status).toBe('unknown');
});

it('pauses both structural and health polling while the document is hidden', async () => {
  vi.mocked(fetchWithAuth).mockResolvedValue(jsonResponse(topologyGraphFixture()));
  renderHook(() => useTopologyGraph({ siteId: SITE }, { view: 'overview' }));
  await waitFor(() => expect(vi.mocked(fetchWithAuth)).toHaveBeenCalled());
  vi.mocked(fetchWithAuth).mockClear();
  Object.defineProperty(document, 'hidden', { configurable: true, value: true });
  await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
  expect(vi.mocked(fetchWithAuth)).not.toHaveBeenCalled();
});

it('clears the graph on a 401/403/404 read failure and surfaces the error message', async () => {
  vi.mocked(fetchWithAuth).mockResolvedValueOnce(jsonResponse({ error: 'Access to this topology is denied' }, 403));
  const { result } = renderHook(() => useTopologyGraph({ siteId: SITE }, { view: 'overview' }));
  await waitFor(() => expect(result.current.error).not.toBeNull());
  expect(result.current.graph).toBeNull();
  expect(result.current.error).toBe('Access to this topology is denied');
});

it('expand replaces the graph with the expansion response for the active scope only', async () => {
  const base = topologyGraphFixture();
  const expanded = { ...base, nodes: [...base.nodes, { ...base.nodes[0], id: '10000000-0000-4000-8000-000000000099', label: 'Expanded peer' }] };
  vi.mocked(fetchWithAuth).mockImplementation(async (url) => String(url).includes('/expansions/') ? jsonResponse(expanded) : jsonResponse(base));
  const { result } = renderHook(() => useTopologyGraph({ siteId: SITE }, { view: 'overview' }));
  await waitFor(() => expect(result.current.graph).not.toBeNull());
  await act(async () => { await result.current.expand('token-1'); });
  expect(result.current.graph!.nodes.map((n) => n.id)).toContain('10000000-0000-4000-8000-000000000099');
});

it('does not fetch at all when disabled', async () => {
  vi.mocked(fetchWithAuth).mockResolvedValue(jsonResponse(topologyGraphFixture()));
  renderHook(() => useTopologyGraph({ siteId: SITE }, { view: 'overview' }, false));
  await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
  expect(vi.mocked(fetchWithAuth)).not.toHaveBeenCalled();
});
