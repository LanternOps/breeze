/**
 * #9431: an approval decided somewhere else (another window, Approvals,
 * mobile) must not leave a workspace tab showing a live Approve / Deny card.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./auth', () => ({ fetchWithAuth: vi.fn(), registerOrgIdProvider: vi.fn() }));
vi.mock('../components/shared/Toast', () => ({ showToast: vi.fn() }));

import { fetchWithAuth } from './auth';
import { useWorkspaceStore, type TabState } from './workspaceStore';
import { abortAllAttaches } from './aiSessionAttach';
import type { PendingApproval } from './processStreamEvent';

const fetchMock = vi.mocked(fetchWithAuth);
const enc = new TextEncoder();

const json = (payload: unknown, status = 200): Response =>
  ({ ok: status < 400, status, json: vi.fn().mockResolvedValue(payload), body: null }) as unknown as Response;
const idleAttach = (): Response => {
  const bytes = enc.encode(`data: ${JSON.stringify({ type: 'attach_state', turn: 'idle', turnId: null, lastSeq: 0, turnUserMessageId: null, partial: false, replay: [], pendingCards: [], activePlan: null, turnModel: null })}\n\n`);
  return { ok: true, status: 200, body: new ReadableStream<Uint8Array>({ start(c) { c.enqueue(bytes); c.close(); } }) } as unknown as Response;
};

const card = (overrides: Partial<PendingApproval> = {}): PendingApproval => ({
  executionId: 'exec-1', toolName: 'file_operations', input: { action: 'delete' }, description: 'Delete a file', ...overrides,
});

function tab(over: Partial<TabState> = {}): TabState {
  return {
    id: 'tab-x', sessionId: null, title: 'Chat', isTitleCustom: false, contextLabel: null, pageContext: null,
    messages: [], chatRuns: {}, isStreaming: false, isLoading: false, error: null, pendingApproval: null,
    pendingPlan: null, activePlan: null, approvalMode: 'per_step', isPaused: false, isInterrupting: false,
    isFlagged: false, unreadCount: 0, hasApprovalPending: false, orgId: null, deviceId: null, deviceLabel: null,
    m365ConnectionId: null, composerDraft: '', joinedMidResponse: false, errorAction: null,
    ...over,
  };
}
const tabOf = (id: string) => useWorkspaceStore.getState().tabs.find((t) => t.id === id);

beforeEach(() => {
  vi.clearAllMocks();
  fetchMock.mockReset();
  useWorkspaceStore.getState().cleanupAllStreams();
  useWorkspaceStore.setState({
    tabs: [tab({ id: 'a', sessionId: 'sa', pendingApproval: card(), hasApprovalPending: true })],
    activeTabId: 'a',
  });
});

afterEach(() => {
  useWorkspaceStore.getState().cleanupAllStreams();
  abortAllAttaches();
});

describe('workspaceStore approvals decided elsewhere (#9431)', () => {
  it('a click on a card already decided shows the decision instead of an error', async () => {
    fetchMock.mockResolvedValueOnce(json({ error: 'This request was already decided.', code: 'approval_already_decided', outcome: 'not_approved' }, 409));

    await useWorkspaceStore.getState().approveExecution('a', 'exec-1', true);

    expect(tabOf('a')).toMatchObject({ error: null, hasApprovalPending: false, pendingApproval: { executionId: 'exec-1', resolution: 'not_approved' } });
  });

  it('any other refusal still surfaces as an error', async () => {
    fetchMock.mockResolvedValueOnce(json({ error: 'Execution not found or already processed' }, 404));

    await useWorkspaceStore.getState().approveExecution('a', 'exec-1', true);

    expect(tabOf('a')?.error).toBe('Execution not found or already processed');
    expect(tabOf('a')?.pendingApproval?.resolution).toBeUndefined();
  });

  it('re-attaches a tab with an undecided card and no live stream when the window comes back', async () => {
    fetchMock.mockResolvedValueOnce(idleAttach());

    useWorkspaceStore.getState().recheckPendingApprovals();
    await vi.waitFor(() => expect(tabOf('a')?.pendingApproval).toBeNull());

    expect(fetchMock).toHaveBeenCalledWith('/ai/sessions/sa/stream', expect.anything());
  });

  it('does not open a second stream for a tab whose session already streams', () => {
    const reader = {} as ReadableStreamDefaultReader<Uint8Array>;
    useWorkspaceStore.setState({ _readers: new Map([['sa', reader]]) });

    useWorkspaceStore.getState().recheckPendingApprovals();

    expect(fetchMock).not.toHaveBeenCalled();
    useWorkspaceStore.setState({ _readers: new Map() });
  });

  it('a resolution arriving on the stream clears a background tab\'s approval badge', async () => {
    let push!: (s: string) => void;
    const body = new ReadableStream<Uint8Array>({ start(c) { push = (s) => c.enqueue(enc.encode(s)); } });
    fetchMock.mockResolvedValueOnce({ ok: true, status: 200, body } as unknown as Response);
    useWorkspaceStore.setState({ activeTabId: 'other' });

    useWorkspaceStore.getState().recheckPendingApprovals();
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const pending = { type: 'approval_required', executionId: 'exec-1', toolName: 'file_operations', input: {}, description: 'Delete a file' };
    push(`data: ${JSON.stringify({ type: 'attach_state', turn: 'running', turnId: 't1', lastSeq: 0, turnUserMessageId: null, partial: true, replay: [], pendingCards: [pending], activePlan: null, turnModel: null })}\n\n`);
    await vi.waitFor(() => expect(tabOf('a')?.hasApprovalPending).toBe(true));
    push(`data: ${JSON.stringify({ type: 'approval_resolved', executionId: 'exec-1', outcome: 'approved' })}\n\n`);

    await vi.waitFor(() => expect(tabOf('a')?.hasApprovalPending).toBe(false));
    expect(tabOf('a')?.pendingApproval?.resolution).toBe('approved');
  });

  it('leaves a tab whose card is already decided alone', () => {
    useWorkspaceStore.setState({ tabs: [tab({ id: 'a', sessionId: 'sa', pendingApproval: card({ resolution: 'approved' }) })] });

    useWorkspaceStore.getState().recheckPendingApprovals();

    expect(fetchMock).not.toHaveBeenCalled();
  });
});
