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
// The kit stubs record their props (W01 #10211: page layout, label, dividers,
// leading, empty state, placeholder, the composer's link button) and render
// the nodes they are handed so those can be driven from here.
const kit = vi.hoisted(() => ({ messages: [] as Array<Record<string, unknown>>, input: [] as Array<Record<string, unknown>> }));
vi.mock('../ai/AiChatMessages', () => ({
  default: (p: Record<string, unknown>) => {
    kit.messages.push(p);
    return (
      <div data-testid="ai-chat-messages-mock">
        {p.leading as React.ReactNode}
        {(p.messages as unknown[]).length === 0 && (p.emptyState as React.ReactNode)}
      </div>
    );
  },
}));
vi.mock('../ai/AiChatInput', () => ({
  default: (p: Record<string, unknown>) => {
    kit.input.push(p);
    return <div data-testid="ai-chat-input-mock">{p.leftSlot as React.ReactNode}</div>;
  },
}));
const LINK = { id: 'l-1', ref: { kind: 'ticket', id: 't-1', orgId: 'o-1' }, label: 'Printer down', status: 'open', href: '/tickets/t-1', addedBy: 'user', createdAt: '2026-10-25T09:00:00Z' };
vi.mock('./WispEntityPicker', () => ({
  default: (p: { open: boolean; threadId: string; onLinked: (l: unknown) => void; onClose: () => void }) =>
    p.open ? (
      <div data-testid="picker-stub" data-thread={p.threadId}>
        <button type="button" onClick={() => p.onLinked(LINK)}>pick</button>
      </div>
    ) : null,
}));
vi.mock('../ai/AiThinkingIndicator', () => ({ default: () => null }));
vi.mock('../ai/AiContinuationPrompt', () => ({ default: () => null }));
vi.mock('../ai/BuyCreditsLink', () => ({ default: () => null }));

import WispHomeThread from './WispHomeThread';

const onLinksChange = vi.fn();
const extra = { scopeLabel: 'All organizations', links: [] as never[], onLinksChange };

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
    render(<WispHomeThread {...extra} wisp={wisp} lastSessionId="s-old" />);
    expect(await screen.findByTestId('ai-chat-input-mock')).toBeInTheDocument();
    expect(h.state.switchSession).not.toHaveBeenCalled();
    expect(h.state.enterWispMode).not.toHaveBeenCalled();
  });

  it('resumes the thread’s last session under the grant instead of creating one', async () => {
    render(<WispHomeThread {...extra} wisp={wisp} lastSessionId="s-old" />);
    expect(await screen.findByTestId('ai-chat-messages-mock')).toBeInTheDocument();
    expect(h.state.switchSession).toHaveBeenCalledWith('s-old');
    expect(h.state.enterWispMode).not.toHaveBeenCalled();
  });

  it('a last session that no longer loads under this grant falls back to a fresh Wisp session', async () => {
    reset({ switchSession: vi.fn(async () => { Object.assign(h.state, { error: 'Failed to load session' }); }) });
    render(<WispHomeThread {...extra} wisp={wisp} lastSessionId="s-gone" />);
    await waitFor(() => expect(h.state.enterWispMode).toHaveBeenCalledWith(wisp));
    expect(await screen.findByTestId('ai-chat-input-mock')).toBeInTheDocument();
  });

  it('a thread with no session yet starts the first one', async () => {
    render(<WispHomeThread {...extra} wisp={wisp} lastSessionId={null} />);
    await waitFor(() => expect(h.state.enterWispMode).toHaveBeenCalledWith(wisp));
  });

  it.each([
    ['paused', 'Wisp is paused.'],
    ['revoked', 'This delegation has ended.'],
  ] as const)('a %s grant creates nothing and says why', async (status, copy) => {
    render(<WispHomeThread {...extra} wisp={{ ...wisp, status }} lastSessionId="s-old" />);
    expect(screen.getByTestId('wisp-home-thread-inactive')).toHaveTextContent(copy);
    await Promise.resolve();
    expect(h.state.switchSession).not.toHaveBeenCalled();
    expect(h.state.enterWispMode).not.toHaveBeenCalled();
  });

  it('a failed open shows retry, never the composer', async () => {
    reset({ enterWispMode: vi.fn(async () => { throw new Error('createSession failed'); }) });
    render(<WispHomeThread {...extra} wisp={wisp} lastSessionId={null} />);
    expect(await screen.findByTestId('wisp-home-thread-failed')).toBeInTheDocument();
    expect(screen.queryByTestId('ai-chat-input-mock')).toBeNull();
  });

  it.each(['closed', 'expired'])('a %s last session is not resumed (its first send would fail): a fresh session starts', async (status) => {
    fetchMock.mockResolvedValue(sessionRes(status));
    render(<WispHomeThread {...extra} wisp={wisp} lastSessionId="s-old" />);
    await waitFor(() => expect(h.state.enterWispMode).toHaveBeenCalledWith(wisp));
    expect(fetchMock).toHaveBeenCalledWith('/ai/sessions/s-old');
    expect(h.state.switchSession).not.toHaveBeenCalled();
  });

  it('a failed session check is logged before a fresh session starts', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    fetchMock.mockResolvedValue({ ok: false, status: 500, json: async () => ({}) } as Response);
    render(<WispHomeThread {...extra} wisp={wisp} lastSessionId="s-old" />);
    await waitFor(() => expect(h.state.enterWispMode).toHaveBeenCalledWith(wisp));
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('[WispHomeThread]'), 500);
    warn.mockRestore();
  });

  it('a last session under another grant is not resumed', async () => {
    fetchMock.mockResolvedValue(sessionRes('active', 'g-rotated'));
    render(<WispHomeThread {...extra} wisp={wisp} lastSessionId="s-old" />);
    await waitFor(() => expect(h.state.enterWispMode).toHaveBeenCalledWith(wisp));
    expect(h.state.switchSession).not.toHaveBeenCalled();
  });

  it('switchSession landing under a different grant falls back to a fresh session', async () => {
    reset({ switchSession: vi.fn(async (id: string) => { Object.assign(h.state, { sessionId: id, wisp: { ...wisp, grantId: 'g-other' } }); }) });
    render(<WispHomeThread {...extra} wisp={wisp} lastSessionId="s-old" />);
    await waitFor(() => expect(h.state.enterWispMode).toHaveBeenCalledWith(wisp));
  });

  it('the docked panel moving the store to another conversation hides the composer here', async () => {
    reset({ wisp, sessionId: 's-live' });
    const view = render(<WispHomeThread {...extra} wisp={wisp} lastSessionId={null} />);
    expect(await screen.findByTestId('ai-chat-input-mock')).toBeInTheDocument();
    act(() => { Object.assign(h.state, { wisp: null, sessionId: 's-plain' }); });
    view.rerender(<WispHomeThread {...extra} wisp={wisp} lastSessionId={null} />);
    expect(screen.getByTestId('wisp-home-thread-failed')).toBeInTheDocument();
    expect(screen.queryByTestId('ai-chat-input-mock')).toBeNull();
  });

  it('retry after a failed open binds a fresh session without re-resuming', async () => {
    const enter = vi.fn()
      .mockRejectedValueOnce(new Error('createSession failed'))
      .mockImplementationOnce(async (w: typeof wisp) => { Object.assign(h.state, { wisp: w, sessionId: 's-new' }); });
    reset({ enterWispMode: enter });
    render(<WispHomeThread {...extra} wisp={wisp} lastSessionId={null} />);
    fireEvent.click(await screen.findByTestId('wisp-home-thread-retry'));
    expect(await screen.findByTestId('ai-chat-input-mock')).toBeInTheDocument();
    expect(enter).toHaveBeenCalledTimes(2);
    expect(h.state.switchSession).not.toHaveBeenCalled();
  });

  it('a new lastSessionId from a poll does not rebind a live thread (no "opening…" flash)', async () => {
    const view = render(<WispHomeThread {...extra} wisp={wisp} lastSessionId="s-old" />);
    expect(await screen.findByTestId('ai-chat-input-mock')).toBeInTheDocument();
    view.rerender(<WispHomeThread {...extra} wisp={wisp} lastSessionId="s-newer" />);
    expect(screen.queryByTestId('wisp-home-thread-binding')).toBeNull();
    expect(h.state.switchSession).toHaveBeenCalledTimes(1);
  });
});

describe('WispHomeThread as the companion column (W01 #10211)', () => {
  const brief = <article data-testid="brief-post">brief</article>;

  beforeEach(() => {
    reset({ wisp, sessionId: 's-live' });
    kit.messages.length = 0;
    kit.input.length = 0;
    onLinksChange.mockReset();
  });

  it('renders no heading and passes the brief post as leading', async () => {
    render(<WispHomeThread {...extra} wisp={wisp} lastSessionId={null} leading={brief} />);
    await screen.findByTestId('ai-chat-input-mock');
    const root = screen.getByTestId('wisp-home-thread');
    expect(root).toHaveAttribute('id', 'thread');
    expect(root.querySelector('h2')).toBeNull();
    expect(root.className).not.toMatch(/\bborder\b|bg-card/);
    expect(screen.getByTestId('brief-post')).toBeInTheDocument();
    expect(kit.messages.at(-1)).toMatchObject({ layout: 'page', assistantLabel: 'Wisp', showTimeDividers: true });
    expect(kit.input.at(-1)).toMatchObject({ placeholder: 'Message Wisp' });
  });

  it('empty thread shows the welcome and a chip sends its prompt', async () => {
    render(<WispHomeThread {...extra} wisp={wisp} lastSessionId={null} />);
    await screen.findByTestId('ai-chat-input-mock');
    expect(screen.getByText("I'm looking around All organizations.")).toBeInTheDocument();
    fireEvent.click(screen.getAllByTestId('wisp-suggestion')[0] as HTMLElement);
    expect(h.state.sendMessage).toHaveBeenCalledWith('What needs my attention today? Keep it short.');
  });

  it('with a brief on screen the welcome keeps its chips but drops the first-brief intro', async () => {
    render(<WispHomeThread {...extra} wisp={wisp} lastSessionId={null} leading={brief} />);
    await screen.findByTestId('ai-chat-input-mock');
    expect(screen.queryByText(/Your first brief arrives/)).toBeNull();
    expect(screen.getAllByTestId('wisp-suggestion')).toHaveLength(4);
  });

  it('the composer link button opens the entity picker and a pick is added to the links', async () => {
    const existing = { ...LINK, id: 'l-0', label: 'Old' };
    render(<WispHomeThread {...extra} links={[existing] as never[]} wisp={wisp} lastSessionId={null} />);
    const button = await screen.findByTestId('wisp-composer-link');
    expect(button).toHaveAccessibleName('Link an item');
    expect(screen.queryByTestId('picker-stub')).toBeNull();
    fireEvent.click(button);
    expect(screen.getByTestId('picker-stub')).toHaveAttribute('data-thread', 'th-1');
    fireEvent.click(screen.getByText('pick'));
    expect(onLinksChange).toHaveBeenCalledWith([existing, LINK]);
    expect(screen.queryByTestId('picker-stub')).toBeNull();
  });

  it('re-linking an item already linked replaces it instead of adding a second row', async () => {
    render(<WispHomeThread {...extra} links={[{ ...LINK, label: 'stale' }] as never[]} wisp={wisp} lastSessionId={null} />);
    fireEvent.click(await screen.findByTestId('wisp-composer-link'));
    fireEvent.click(screen.getByText('pick'));
    expect(onLinksChange).toHaveBeenCalledWith([LINK]);
  });

  it('links null hides the composer link button', async () => {
    render(<WispHomeThread {...extra} links={null} wisp={wisp} lastSessionId={null} />);
    await screen.findByTestId('ai-chat-input-mock');
    expect(screen.queryByTestId('wisp-composer-link')).toBeNull();
  });

  it('a paused grant keeps the brief and shows the notice where the composer would be', () => {
    reset();
    render(<WispHomeThread {...extra} wisp={{ ...wisp, status: 'paused' }} lastSessionId={null} leading={brief} />);
    expect(screen.getByTestId('brief-post')).toBeInTheDocument();
    expect(screen.getByTestId('wisp-home-thread-inactive')).toBeInTheDocument();
    expect(screen.queryByTestId('ai-chat-input-mock')).toBeNull();
  });
});
