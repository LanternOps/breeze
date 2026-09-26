import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fetchWithAuth } from '../../stores/auth';
import { useAiStore } from '../../stores/aiStore';
import { TOPOLOGY_EXPLAIN_QUESTION, topologySelectionKey, useTopologyInvestigation } from './useTopologyInvestigation';
import { AI, aiExplanationFixture, aiSelection, jsonResponse, sseResponse } from './topologyAiFixtures';

vi.mock('../../stores/auth', () => ({ fetchWithAuth: vi.fn() }));
vi.mock('../shared/Toast', () => ({ showToast: vi.fn() }));

const RESET = {
  sessionId: null, sessionOrgId: null, hydratedSessionId: null, messages: [], isStreaming: false, isLoading: false, error: null, errorCode: null,
  pendingApproval: null, topologySiteId: null, topologySelection: null, topologyPhase: null, topologyRunId: null, pageContext: null,
};
beforeEach(() => { vi.mocked(fetchWithAuth).mockReset(); useAiStore.setState(RESET as never); });
const calls = () => vi.mocked(fetchWithAuth).mock.calls.map(([url, init]) => `${init?.method ?? 'GET'} ${String(url)}`);

const storedSession = (selection = aiSelection()) => ({
  session: { id: AI.session, status: 'active', orgId: 'org-1', type: 'topology', topologySiteId: AI.site, contextSnapshot: { type: 'topology', ...selection } },
  messages: [
    { id: 'u1', role: 'user', content: TOPOLOGY_EXPLAIN_QUESTION, createdAt: '2026-09-26T12:00:00.000Z' },
    { id: 'a1', role: 'assistant', content: '{}', contentBlocks: [{ type: 'topology_explanation', explanation: aiExplanationFixture() }], createdAt: '2026-09-26T12:00:05.000Z' },
  ],
});

describe('useTopologyInvestigation (M4 Task 5)', () => {
  it('keys cancellation on site/subject/view, not on the graph revision', () => {
    expect(topologySelectionKey(aiSelection())).toBe(topologySelectionKey(aiSelection({ graphRevision: '9' })));
    expect(topologySelectionKey(aiSelection())).not.toBe(topologySelectionKey(aiSelection({ view: 'physical' })));
    expect(topologySelectionKey(null)).toBe('');
  });

  it('makes no request until explain(); explain sends the one fixed question', async () => {
    vi.mocked(fetchWithAuth).mockImplementation(async (input, init) => init?.method === 'POST' && String(input) === '/ai/sessions'
      ? jsonResponse({ id: AI.session, orgId: 'org-1' })
      : sseResponse([{ type: 'message_start', messageId: 'm' }, { type: 'topology_explanation', explanation: aiExplanationFixture() }, { type: 'done' }]));
    const { result } = renderHook(() => useTopologyInvestigation(aiSelection()));
    expect(result.current.status).toBe('idle');
    expect(fetchWithAuth).not.toHaveBeenCalled();
    await act(async () => { await result.current.explain(); });
    await waitFor(() => expect(result.current.status).toBe('complete'));
    expect(JSON.parse(String(vi.mocked(fetchWithAuth).mock.calls[1]![1]!.body)).content).toBe(TOPOLOGY_EXPLAIN_QUESTION);
    expect(result.current.historical).toBe(false);
    expect(result.current.sessionId).toBe(AI.session);
  });

  it('reopens a stored investigation read-only (no POST) and marks it historical when the selection differs', async () => {
    vi.mocked(fetchWithAuth).mockResolvedValue(jsonResponse(storedSession(aiSelection({ graphRevision: '0' }))));
    const { result } = renderHook(() => useTopologyInvestigation(aiSelection(), { initialSessionId: AI.session }));
    await waitFor(() => expect(result.current.status).toBe('complete'));
    expect(calls()).toEqual([`GET /ai/sessions/${AI.session}`]);
    expect(result.current.historical).toBe(true);
  });

  it('reopens after a page reload, when only the persisted session id survived', async () => {
    useAiStore.setState({ sessionId: AI.session, hydratedSessionId: null, messages: [] } as never);
    vi.mocked(fetchWithAuth).mockResolvedValue(jsonResponse(storedSession()));
    const { result } = renderHook(() => useTopologyInvestigation(aiSelection(), { initialSessionId: AI.session }));
    await waitFor(() => expect(result.current.status).toBe('complete'));
    expect(calls()).toEqual([`GET /ai/sessions/${AI.session}`]);
  });

  it('a reopened answer for the same selection is current, not historical', async () => {
    vi.mocked(fetchWithAuth).mockResolvedValue(jsonResponse(storedSession()));
    const { result } = renderHook(() => useTopologyInvestigation(aiSelection(), { initialSessionId: AI.session }));
    await waitFor(() => expect(result.current.status).toBe('complete'));
    expect(result.current.historical).toBe(false);
  });

  it('interrupts a running turn when the panel unmounts', async () => {
    let release!: () => void;
    vi.mocked(fetchWithAuth).mockImplementation(async (input, init) => {
      const url = String(input);
      if (init?.method === 'POST' && url === '/ai/sessions') return jsonResponse({ id: AI.session, orgId: 'org-1' });
      if (url.endsWith('/interrupt')) return jsonResponse({ interrupted: true });
      return sseResponse([{ type: 'message_start', messageId: 'm' }], new Promise<void>((resolve) => { release = resolve; }));
    });
    const { result, unmount } = renderHook(() => useTopologyInvestigation(aiSelection()));
    act(() => { void result.current.explain(); });
    await waitFor(() => expect(useAiStore.getState().isStreaming).toBe(true));
    unmount();
    await waitFor(() => expect(calls()).toContain(`POST /ai/sessions/${AI.session}/interrupt`));
    release();
  });
});
