/**
 * Topology M4 Task 5 (#6000): an "Explain this" investigation reuses the ONE
 * chat session transport in this store. What it adds, and what these cases pin:
 *   - createSession for a topology page context goes through runAction (the
 *     outcome is always surfaced) and records the pinned site + selection;
 *   - a topology turn renders ONLY vetted events — generic content_delta and
 *     tool events are dropped even if a server ever sent them;
 *   - the progress phase, the approved diagnostic run id and a refusal code are
 *     kept for the Explain panel;
 *   - a reloaded topology session maps its stored structured answer, never the
 *     raw JSON body, into the transcript.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./auth', () => ({ fetchWithAuth: vi.fn() }));
const showToast = vi.fn();
vi.mock('../components/shared/Toast', () => ({ showToast: (...args: unknown[]) => showToast(...args) }));

import { fetchWithAuth } from './auth';
import { useAiStore } from './aiStore';

const fetchWithAuthMock = vi.mocked(fetchWithAuth);

const SITE = '20000000-0000-4000-8000-000000000001';
const NODE = '30000000-0000-4000-8000-000000000001';
const RUN = '90000000-0000-4000-8000-000000000001';
const topologyContext = { type: 'topology' as const, siteId: SITE, subject: { kind: 'node' as const, id: NODE }, view: 'physical' as const, graphRevision: '7' };
const explanation = {
  schemaVersion: 1, status: 'complete', reasons: [],
  findings: [{ kind: 'finding', claim: 'health', text: 'Uplink reports failed checks.', citationIds: [NODE] }],
  missingData: [], nextChecks: [], citationIds: [NODE],
  citations: [{ id: NODE, resourceType: 'node', resourceId: NODE, observedAt: null, inspectorTarget: { kind: 'node', id: NODE } }],
};

const jsonResponse = (payload: unknown, status = 200): Response =>
  ({ ok: status < 400, status, json: vi.fn().mockResolvedValue(payload) }) as unknown as Response;

/** A streamed SSE response delivering `events` in one chunk. */
function sseResponse(events: unknown[]): Response {
  const bytes = new TextEncoder().encode(events.map((event) => `data: ${JSON.stringify(event)}\n`).join(''));
  let sent = false;
  return {
    ok: true, status: 200,
    body: { getReader: () => ({ read: async () => (sent ? { done: true, value: undefined } : ((sent = true), { done: false, value: bytes })), cancel: async () => undefined }) },
  } as unknown as Response;
}

beforeEach(() => {
  vi.clearAllMocks();
  useAiStore.setState({
    sessionId: null, sessionOrgId: null, hydratedSessionId: null, messages: [], isStreaming: false, isLoading: false,
    error: null, errorCode: null, pageContext: null, pendingApproval: null,
    topologySiteId: null, topologySelection: null, topologyPhase: null, topologyRunId: null,
  });
});

describe('topology session creation', () => {
  it('creates a site-pinned session through runAction and records the pin and selection', async () => {
    fetchWithAuthMock.mockResolvedValueOnce(jsonResponse({ id: 'sess-topo', orgId: 'org-1' }));
    await useAiStore.getState().createSession({ pageContext: topologyContext });
    const state = useAiStore.getState();
    expect(state.sessionId).toBe('sess-topo');
    expect(state.topologySiteId).toBe(SITE);
    expect(state.topologySelection).toEqual({ siteId: SITE, subject: { kind: 'node', id: NODE }, view: 'physical', graphRevision: '7' });
    expect(showToast).toHaveBeenCalledWith(expect.objectContaining({ type: 'success' }));
  });

  it('surfaces a refusal with its code and leaves no session', async () => {
    fetchWithAuthMock.mockResolvedValueOnce(jsonResponse({ error: 'Topology AI is disabled for this organization', code: 'topology_ai_disabled' }, 403));
    await useAiStore.getState().createSession({ pageContext: topologyContext });
    const state = useAiStore.getState();
    expect(state.sessionId).toBeNull();
    expect(state.errorCode).toBe('topology_ai_disabled');
    expect(state.error).toBeTruthy();
    expect(state.isLoading).toBe(false);
    expect(showToast).toHaveBeenCalledWith(expect.objectContaining({ type: 'error' }));
  });

  it('an ordinary session clears any topology pin', async () => {
    useAiStore.setState({ topologySiteId: SITE, topologySelection: { siteId: SITE, subject: { kind: 'node', id: NODE }, view: 'physical', graphRevision: '7' } });
    fetchWithAuthMock.mockResolvedValueOnce(jsonResponse({ id: 'sess-chat', orgId: 'org-1' }));
    await useAiStore.getState().createSession();
    expect(useAiStore.getState().topologySiteId).toBeNull();
    expect(useAiStore.getState().topologySelection).toBeNull();
  });
});

describe('topology turn streaming', () => {
  beforeEach(() => {
    useAiStore.setState({ sessionId: 'sess-topo', topologySiteId: SITE, topologySelection: { siteId: SITE, subject: { kind: 'node', id: NODE }, view: 'physical', graphRevision: '7' } });
  });

  it('renders only vetted events: raw content_delta and tool events never reach the transcript', async () => {
    fetchWithAuthMock.mockResolvedValueOnce(sseResponse([
      { type: 'message_start', messageId: 'm1' },
      { type: 'content_delta', delta: 'RAW MODEL TEXT' },
      { type: 'tool_use_start', toolName: 'get_topology', toolUseId: 't1', input: {} },
      { type: 'tool_result', toolUseId: 't1', output: { secret: 'RAW TOOL OUTPUT' }, isError: false },
      { type: 'topology_progress', phase: 'awaiting_approval' },
      { type: 'approval_required', executionId: 'e1', toolName: 'diagnose_connectivity', input: { site_id: SITE }, description: 'Run gateway reachability', intentBacked: true, selfApprovalRequestId: 'ap-1', approvalScope: 'supervised' },
      { type: 'topology_diagnostic_run', runId: RUN, state: 'queued' },
      { type: 'topology_explanation', explanation },
      { type: 'done' },
    ]));
    await useAiStore.getState().sendMessage('Explain this selection.');
    const state = useAiStore.getState();
    const transcript = JSON.stringify(state.messages);
    expect(transcript).not.toContain('RAW MODEL TEXT');
    expect(transcript).not.toContain('RAW TOOL OUTPUT');
    expect(state.messages.some((m) => m.role === 'tool_use' || m.role === 'tool_result')).toBe(false);
    expect(state.messages.find((m) => m.role === 'assistant')?.topologyExplanation).toEqual(explanation);
    expect(state.pendingApproval).toMatchObject({ toolName: 'diagnose_connectivity', selfApprovalRequestId: 'ap-1' });
    expect(state.topologyRunId).toBe(RUN);
    expect(state.topologyPhase).toBeNull();
  });

  it('keeps the current progress phase while the turn runs', async () => {
    fetchWithAuthMock.mockResolvedValueOnce(sseResponse([
      { type: 'message_start', messageId: 'm1' },
      { type: 'topology_progress', phase: 'analyzing' },
    ]));
    await useAiStore.getState().sendMessage('Explain this selection.');
    expect(useAiStore.getState().topologyPhase).toBe('analyzing');
  });

  it('records the refusal code of a refused turn', async () => {
    fetchWithAuthMock.mockResolvedValueOnce(jsonResponse({ error: 'The investigation scope changed; start a new investigation', code: 'investigation_scope_changed' }, 409));
    await useAiStore.getState().sendMessage('Explain this selection.');
    expect(useAiStore.getState().errorCode).toBe('investigation_scope_changed');
  });
});

describe('reloading a topology session', () => {
  it('restores the pin and selection and maps the stored structured answer', async () => {
    fetchWithAuthMock.mockResolvedValueOnce(jsonResponse({
      session: { id: 'sess-topo', status: 'active', orgId: 'org-1', type: 'topology', topologySiteId: SITE, contextSnapshot: topologyContext },
      messages: [
        { id: 'u1', role: 'user', content: 'Explain this selection.', createdAt: '2026-09-26T12:00:00.000Z' },
        { id: 'a1', role: 'assistant', content: JSON.stringify(explanation), contentBlocks: [{ type: 'topology_explanation', explanation }], createdAt: '2026-09-26T12:00:05.000Z' },
        { id: 'a2', role: 'assistant', content: '{"findings":"FORGED RAW"}', contentBlocks: [{ type: 'topology_explanation', explanation: { findings: 'FORGED RAW' } }], createdAt: '2026-09-26T12:00:06.000Z' },
      ],
    }));
    await useAiStore.getState().loadSession('sess-topo');
    const state = useAiStore.getState();
    expect(state.topologySiteId).toBe(SITE);
    expect(state.topologySelection).toEqual({ siteId: SITE, subject: { kind: 'node', id: NODE }, view: 'physical', graphRevision: '7' });
    const [, valid, invalid] = state.messages;
    expect(valid!.topologyExplanation).toEqual(explanation);
    expect(valid!.content).toContain('Uplink reports failed checks.');
    expect(invalid!.topologyExplanation).toBeUndefined();
    expect(invalid!.topologyExplanationInvalid).toBe(true);
    expect(invalid!.content).not.toContain('FORGED RAW');
  });

  it('an ordinary session has no pin', async () => {
    useAiStore.setState({ topologySiteId: SITE });
    fetchWithAuthMock.mockResolvedValueOnce(jsonResponse({ session: { id: 's', status: 'active', orgId: 'org-1', type: 'general', topologySiteId: null }, messages: [] }));
    await useAiStore.getState().loadSession('s');
    expect(useAiStore.getState().topologySiteId).toBeNull();
  });
});
