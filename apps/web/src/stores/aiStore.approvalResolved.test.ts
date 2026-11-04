/**
 * #9431: an approval decided somewhere else (another window, Approvals,
 * mobile) must not leave this surface showing a live Approve / Deny card.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./auth', () => ({
  fetchWithAuth: vi.fn()
}));
vi.mock('./orgStore', () => ({ useOrgStore: { getState: () => ({ currentOrgId: null }) } }));

import { fetchWithAuth } from './auth';
import { useAiStore } from './aiStore';
import type { PendingApproval } from './processStreamEvent';

const fetchWithAuthMock = vi.mocked(fetchWithAuth);

const jsonResponse = (payload: unknown, status: number): Response =>
  ({ ok: status >= 200 && status < 300, status, json: vi.fn().mockResolvedValue(payload) }) as unknown as Response;

const idleAttach = (): Response => {
  const bytes = new TextEncoder().encode(`data: ${JSON.stringify({ type: 'attach_state', turn: 'idle', turnId: null, lastSeq: 0, turnUserMessageId: null, partial: false, replay: [], pendingCards: [], activePlan: null, turnModel: null })}\n\n`);
  return { ok: true, status: 200, body: new ReadableStream<Uint8Array>({ start(c) { c.enqueue(bytes); c.close(); } }) } as unknown as Response;
};

const card = (overrides: Partial<PendingApproval> = {}): PendingApproval => ({
  executionId: 'exec-1',
  toolName: 'file_operations',
  input: { action: 'delete' },
  description: 'Delete a file',
  ...overrides,
});

describe('aiStore approvals decided elsewhere (#9431)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useAiStore.setState({
      sessionId: 'session-1',
      messages: [],
      isStreaming: false,
      error: null,
      pendingApproval: card(),
    });
  });

  it.each(['approved', 'not_approved'] as const)(
    'a click on a card already decided (%s) shows the decision instead of an error',
    async (outcome) => {
      fetchWithAuthMock.mockResolvedValueOnce(jsonResponse({
        error: 'This request was already decided.', code: 'approval_already_decided', outcome,
      }, 409));

      await useAiStore.getState().approveExecution('exec-1', true);

      expect(fetchWithAuthMock).toHaveBeenCalledTimes(1);
      expect(useAiStore.getState().pendingApproval).toMatchObject({ executionId: 'exec-1', resolution: outcome });
      expect(useAiStore.getState().error).toBeNull();
    },
  );

  it('a 409 for an execution that is no longer the card on screen leaves that card alone', async () => {
    useAiStore.setState({ pendingApproval: card({ executionId: 'exec-2' }) });
    fetchWithAuthMock.mockResolvedValueOnce(jsonResponse({ code: 'approval_already_decided', outcome: 'approved' }, 409));

    await useAiStore.getState().approveExecution('exec-1', true);

    expect(useAiStore.getState().pendingApproval).toMatchObject({ executionId: 'exec-2' });
    expect(useAiStore.getState().pendingApproval?.resolution).toBeUndefined();
  });

  it('any other refusal still surfaces as an error and leaves the card actionable', async () => {
    fetchWithAuthMock.mockResolvedValueOnce(jsonResponse({ error: 'Execution not found or already processed' }, 404));

    await useAiStore.getState().approveExecution('exec-1', true);

    expect(useAiStore.getState().error).toBe('Execution not found or already processed');
    expect(useAiStore.getState().pendingApproval?.resolution).toBeUndefined();
  });

  it('re-reads the session when the window comes back with a card up and no live stream', async () => {
    fetchWithAuthMock.mockResolvedValueOnce(idleAttach());

    useAiStore.getState().recheckPendingApproval();
    await vi.waitFor(() => expect(useAiStore.getState().pendingApproval).toBeNull());

    expect(fetchWithAuthMock).toHaveBeenCalledWith('/ai/sessions/session-1/stream', expect.anything());
  });

  it('does nothing without an undecided card', () => {
    useAiStore.setState({ pendingApproval: card({ resolution: 'approved' }) });
    useAiStore.getState().recheckPendingApproval();
    useAiStore.setState({ pendingApproval: null });
    useAiStore.getState().recheckPendingApproval();

    expect(fetchWithAuthMock).not.toHaveBeenCalled();
  });
});
