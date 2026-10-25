/**
 * W08 (#9921) Task 9: the inline Wisp conversation binds the shared chat store
 * to this thread without minting a session per visit: reuse the live one,
 * resume the thread's last session, else start the first — and nothing for a
 * paused or ended grant.
 */
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => {
  const state: Record<string, unknown> = {};
  const store = Object.assign((sel?: (s: unknown) => unknown) => (sel ? sel(state) : state), {
    getState: () => state,
    setState: (patch: Record<string, unknown>) => Object.assign(state, patch),
  });
  return { state, store };
});
vi.mock('@/stores/aiStore', () => ({ useAiStore: h.store }));
const fetchMock = vi.hoisted(() => vi.fn());
vi.mock('@/stores/auth', () => ({ fetchWithAuth: fetchMock }));
const sessionRes = (status: string, wispGrantId = 'g-1') =>
  ({ ok: true, status: 200, json: async () => ({ session: { id: 's-old', status, wispGrantId } }) }) as Response;
vi.mock('../ai/AiChatMessages', () => ({ default: () => <div data-testid="ai-chat-messages-mock" /> }));
vi.mock('../ai/AiChatInput', () => ({ default: () => <div data-testid="ai-chat-input-mock" /> }));
vi.mock('../ai/AiThinkingIndicator', () => ({ default: () => null }));
vi.mock('../ai/AiContinuationPrompt', () => ({ default: () => null }));
vi.mock('../ai/BuyCreditsLink', () => ({ default: () => null }));

import WispHomeThread from './WispHomeThread';

const wisp = { grantId: 'g-1', threadId: 'th-1', scopeOrgId: null, focusOrgId: null, focusOrgName: null, status: 'active' as const, expiresAt: '2026-12-01T00:00:00Z', summary: '', budgetCentsPerDay: 200, floorTickMinutes: 30, wideningAvailable: false };

const reset = (over: Record<string, unknown> = {}) => {
  for (const k of Object.keys(h.state)) delete h.state[k];
  Object.assign(h.state, {
    messages: [], chatRuns: [], isStreaming: false, thinking: null, isLoading: false, error: null, errorCode: null,
    pendingApproval: null, pendingPlan: null, activePlan: null, approvalMode: 'per_step', isPaused: false,
    sendMessage: vi.fn(), approveExecution: vi.fn(), clearPendingApproval: vi.fn(), approvePlan: vi.fn(), abortPlan: vi.fn(),
    pauseAi: vi.fn(), interruptResponse: vi.fn(), isInterrupting: false, composerDraft: '', setComposerDraft: vi.fn(), clearError: vi.fn(),
    wisp: null, sessionId: null,
    switchSession: vi.fn(async (id: string) => { Object.assign(h.state, { sessionId: id }); }),
    enterWispMode: vi.fn(async (w: typeof wisp) => { Object.assign(h.state, { wisp: w, sessionId: 's-new' }); }),
    ...over,
  });
};

describe('WispHomeThread (W08 Task 9)', () => {
  beforeEach(() => {
    reset();
    fetchMock.mockReset();
    fetchMock.mockResolvedValue(sessionRes('active'));
  });

  it('reuses a live session already on this thread: no switch, no new session', async () => {
    reset({ wisp, sessionId: 's-live' });
    render(<WispHomeThread wisp={wisp} lastSessionId="s-old" />);
    expect(await screen.findByTestId('ai-chat-input-mock')).toBeInTheDocument();
    expect(h.state.switchSession).not.toHaveBeenCalled();
    expect(h.state.enterWispMode).not.toHaveBeenCalled();
  });

  it('resumes the thread’s last session under the grant instead of creating one', async () => {
    render(<WispHomeThread wisp={wisp} lastSessionId="s-old" />);
    expect(await screen.findByTestId('ai-chat-messages-mock')).toBeInTheDocument();
    expect(h.state.switchSession).toHaveBeenCalledWith('s-old');
    expect(h.state.enterWispMode).not.toHaveBeenCalled();
  });

  it('a last session that no longer loads under this grant falls back to a fresh Wisp session', async () => {
    reset({ switchSession: vi.fn(async () => { Object.assign(h.state, { error: 'Failed to load session' }); }) });
    render(<WispHomeThread wisp={wisp} lastSessionId="s-gone" />);
    await waitFor(() => expect(h.state.enterWispMode).toHaveBeenCalledWith(wisp));
    expect(await screen.findByTestId('ai-chat-input-mock')).toBeInTheDocument();
  });

  it('a thread with no session yet starts the first one', async () => {
    render(<WispHomeThread wisp={wisp} lastSessionId={null} />);
    await waitFor(() => expect(h.state.enterWispMode).toHaveBeenCalledWith(wisp));
  });

  it.each([
    ['paused', 'Wisp is paused.'],
    ['revoked', 'This delegation has ended.'],
  ] as const)('a %s grant creates nothing and says why', async (status, copy) => {
    render(<WispHomeThread wisp={{ ...wisp, status }} lastSessionId="s-old" />);
    expect(screen.getByTestId('wisp-home-thread-inactive')).toHaveTextContent(copy);
    await Promise.resolve();
    expect(h.state.switchSession).not.toHaveBeenCalled();
    expect(h.state.enterWispMode).not.toHaveBeenCalled();
  });

  it('a failed open shows retry, never the composer', async () => {
    reset({ enterWispMode: vi.fn(async () => { throw new Error('createSession failed'); }) });
    render(<WispHomeThread wisp={wisp} lastSessionId={null} />);
    expect(await screen.findByTestId('wisp-home-thread-failed')).toBeInTheDocument();
    expect(screen.queryByTestId('ai-chat-input-mock')).toBeNull();
  });

  it.each(['closed', 'expired'])('a %s last session is not resumed (its first send would fail): a fresh session starts', async (status) => {
    fetchMock.mockResolvedValue(sessionRes(status));
    render(<WispHomeThread wisp={wisp} lastSessionId="s-old" />);
    await waitFor(() => expect(h.state.enterWispMode).toHaveBeenCalledWith(wisp));
    expect(fetchMock).toHaveBeenCalledWith('/ai/sessions/s-old');
    expect(h.state.switchSession).not.toHaveBeenCalled();
  });

  it('a last session under another grant is not resumed', async () => {
    fetchMock.mockResolvedValue(sessionRes('active', 'g-rotated'));
    render(<WispHomeThread wisp={wisp} lastSessionId="s-old" />);
    await waitFor(() => expect(h.state.enterWispMode).toHaveBeenCalledWith(wisp));
    expect(h.state.switchSession).not.toHaveBeenCalled();
  });

  it('switchSession landing under a different grant falls back to a fresh session', async () => {
    reset({ switchSession: vi.fn(async (id: string) => { Object.assign(h.state, { sessionId: id, wisp: { ...wisp, grantId: 'g-other' } }); }) });
    render(<WispHomeThread wisp={wisp} lastSessionId="s-old" />);
    await waitFor(() => expect(h.state.enterWispMode).toHaveBeenCalledWith(wisp));
  });

  it('the docked panel moving the store to another conversation hides the composer here', async () => {
    reset({ wisp, sessionId: 's-live' });
    const view = render(<WispHomeThread wisp={wisp} lastSessionId={null} />);
    expect(await screen.findByTestId('ai-chat-input-mock')).toBeInTheDocument();
    act(() => { Object.assign(h.state, { wisp: null, sessionId: 's-plain' }); });
    view.rerender(<WispHomeThread wisp={wisp} lastSessionId={null} />);
    expect(screen.getByTestId('wisp-home-thread-failed')).toBeInTheDocument();
    expect(screen.queryByTestId('ai-chat-input-mock')).toBeNull();
  });

  it('retry after a failed open binds a fresh session without re-resuming', async () => {
    const enter = vi.fn()
      .mockRejectedValueOnce(new Error('createSession failed'))
      .mockImplementationOnce(async (w: typeof wisp) => { Object.assign(h.state, { wisp: w, sessionId: 's-new' }); });
    reset({ enterWispMode: enter });
    render(<WispHomeThread wisp={wisp} lastSessionId={null} />);
    fireEvent.click(await screen.findByTestId('wisp-home-thread-retry'));
    expect(await screen.findByTestId('ai-chat-input-mock')).toBeInTheDocument();
    expect(enter).toHaveBeenCalledTimes(2);
    expect(h.state.switchSession).not.toHaveBeenCalled();
  });

  it('a new lastSessionId from a poll does not rebind a live thread (no "opening…" flash)', async () => {
    const view = render(<WispHomeThread wisp={wisp} lastSessionId="s-old" />);
    expect(await screen.findByTestId('ai-chat-input-mock')).toBeInTheDocument();
    view.rerender(<WispHomeThread wisp={wisp} lastSessionId="s-newer" />);
    expect(screen.queryByTestId('wisp-home-thread-binding')).toBeNull();
    expect(h.state.switchSession).toHaveBeenCalledTimes(1);
  });
});
