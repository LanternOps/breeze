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
const json = (body: unknown, status = 200) => ({ ok: status < 400, status, json: async () => body }) as Response;
/**
 * W02b: the column reads `GET /wisp/thread/:id/timeline` once bound. `timeline`
 * answers it (by default an empty thread); everything else is the session check.
 */
const route = (opts: { session?: Response; timeline?: (url: string) => Response | Promise<Response> } = {}) =>
  async (url: string) => {
    if (url.includes('/timeline')) return opts.timeline ? opts.timeline(url) : json({ data: { items: [], nextCursor: null } });
    return opts.session ?? sessionRes('active');
  };
const timelineCalls = () => fetchMock.mock.calls.map((c) => c[0] as string).filter((u) => u.includes('/timeline'));
const paramsOf = (url: string) => new URLSearchParams(url.split('?')[1]);
// The kit stubs record their props (W01 #10211: page layout, label, dividers,
// leading, empty state, placeholder, the composer's link button) and render
// the nodes they are handed so those can be driven from here.
const kit = vi.hoisted(() => ({ messages: [] as Array<Record<string, unknown>>, input: [] as Array<Record<string, unknown>> }));
vi.mock('../ai/AiChatMessages', () => ({
  default: (p: Record<string, unknown>) => {
    kit.messages.push(p);
    const extras = (p.extras ?? []) as Array<{ id: string; render: () => React.ReactNode }>;
    return (
      <div data-testid="ai-chat-messages-mock">
        {p.leading as React.ReactNode}
        {extras.map((e) => <div key={e.id} data-testid="extra-mock">{e.render()}</div>)}
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
    fetchMock.mockImplementation(route());
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
    fetchMock.mockImplementation(route({ session: sessionRes(status) }));
    render(<WispHomeThread {...extra} wisp={wisp} lastSessionId="s-old" />);
    await waitFor(() => expect(h.state.enterWispMode).toHaveBeenCalledWith(wisp));
    expect(fetchMock).toHaveBeenCalledWith('/ai/sessions/s-old');
    expect(h.state.switchSession).not.toHaveBeenCalled();
  });

  it('a failed session check is logged before a fresh session starts', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    fetchMock.mockImplementation(route({ session: { ok: false, status: 500, json: async () => ({}) } as Response }));
    render(<WispHomeThread {...extra} wisp={wisp} lastSessionId="s-old" />);
    await waitFor(() => expect(h.state.enterWispMode).toHaveBeenCalledWith(wisp));
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('[WispHomeThread]'), 500);
    warn.mockRestore();
  });

  it('a last session under another grant is not resumed', async () => {
    fetchMock.mockImplementation(route({ session: sessionRes('active', 'g-rotated') }));
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
    fetchMock.mockReset();
    fetchMock.mockImplementation(route());
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
    expect(await screen.findByText("I'm looking around All organizations.")).toBeInTheDocument();
    expect(screen.getByText(/Your first brief arrives/)).toBeInTheDocument();
    fireEvent.click(screen.getAllByTestId('wisp-suggestion')[0] as HTMLElement);
    expect(h.state.sendMessage).toHaveBeenCalledWith('What needs my attention today? Keep it short.');
  });

  it('with a brief post in the thread the welcome keeps its chips but drops the first-brief intro', async () => {
    fetchMock.mockImplementation(route({
      timeline: () => json({ data: { items: [{ source: 'post', id: 'p-b', kind: 'brief', title: 'Morning brief', body: null, link: null, sections: [{ heading: 'Overnight', lines: ['All quiet'] }], concernId: null, orgId: null, read: null, createdAt: '2026-10-26T07:00:00.000Z' }], nextCursor: null } }),
    }));
    render(<WispHomeThread {...extra} wisp={wisp} lastSessionId={null} />);
    expect(await screen.findByTestId('wisp-brief-card')).toBeInTheDocument();
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

describe('WispHomeThread reads the thread timeline (W02b #10213)', () => {
  type Item = Record<string, unknown>;
  const msg = (id: string, sessionId: string, minute: number, role = 'assistant'): Item => ({
    source: 'message', id, sessionId, role, content: `text ${id}`, contentBlocks: null, toolName: null,
    toolInput: null, toolOutput: null, toolUseId: null, createdAt: new Date(Date.UTC(2026, 9, 26, 8, minute)).toISOString(),
  });
  const post = (id: string, minute: number, over: Item = {}): Item => ({
    source: 'post', id, kind: 'nudge', title: `nudge ${id}`, body: null, link: null, sections: null, concernId: null,
    orgId: null, read: null, createdAt: new Date(Date.UTC(2026, 9, 26, 8, minute)).toISOString(), ...over,
  });
  const page = (items: Item[], nextCursor: string | null = null) => json({ data: { items, nextCursor } });
  /** A timeline answer the test settles by hand (to look at the seam while a fetch is in flight). */
  const deferred = () => {
    let resolve!: (r: Response) => void;
    const promise = new Promise<Response>((r) => { resolve = r; });
    return { promise, resolve };
  };
  const lastKit = () => kit.messages.at(-1) as {
    messages: Array<{ id: string }>; extras: Array<{ id: string }>; hasEarlier?: boolean; loadingEarlier?: boolean;
    onLoadEarlier?: () => void; emptyState?: unknown;
  };
  const messageIds = () => lastKit().messages.map((m) => m.id);
  const extraIds = () => lastKit().extras.map((e) => e.id).sort();
  const live = [{ id: 'live-1', role: 'user', content: 'hello', createdAt: new Date(Date.UTC(2026, 9, 26, 9, 0)) }];

  beforeEach(() => {
    reset({ wisp, sessionId: 's-live', messages: live });
    kit.messages.length = 0;
    kit.input.length = 0;
    fetchMock.mockReset();
  });

  it('first page loads after bind with excludeSessionId, older sessions before the live one and posts as extras', async () => {
    fetchMock.mockImplementation(route({ timeline: () => page([post('p-1', 30), msg('m-2', 's-old', 20), msg('m-1', 's-old', 10, 'user')]) }));
    render(<WispHomeThread {...extra} wisp={wisp} lastSessionId={null} />);
    await waitFor(() => expect(messageIds()).toEqual(['m-1', 'm-2', 'live-1']));
    expect(extraIds()).toEqual(['p-1']);
    expect(lastKit().hasEarlier).toBe(false);
    const calls = timelineCalls();
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain('/wisp/thread/th-1/timeline?');
    expect(paramsOf(calls[0] as string).get('excludeSessionId')).toBe('s-live');
    expect(paramsOf(calls[0] as string).has('cursor')).toBe(false);
    // The post renders through WispPost.
    expect(screen.getByTestId('wisp-post')).toHaveAttribute('data-kind', 'nudge');
  });

  it('load earlier prepends and keeps order, then hides when the thread start is reached', async () => {
    const second = deferred();
    fetchMock.mockImplementation(route({
      timeline: (url) => (paramsOf(url).get('cursor') === 'c-1' ? second.promise : page([msg('m-3', 's-old', 30), msg('m-2', 's-old', 20)], 'c-1')),
    }));
    render(<WispHomeThread {...extra} wisp={wisp} lastSessionId={null} />);
    await waitFor(() => expect(lastKit().hasEarlier).toBe(true));
    act(() => { lastKit().onLoadEarlier?.(); });
    expect(lastKit().loadingEarlier).toBe(true);
    const call = timelineCalls().at(-1) as string;
    expect(paramsOf(call).get('cursor')).toBe('c-1');
    expect(paramsOf(call).get('excludeSessionId')).toBe('s-live');
    await act(async () => { second.resolve(page([post('p-0', 5), msg('m-1', 's-old', 10)])); });
    expect(messageIds()).toEqual(['m-1', 'm-2', 'm-3', 'live-1']);
    expect(extraIds()).toEqual(['p-0']);
    expect(lastKit().hasEarlier).toBe(false);
    expect(lastKit().loadingEarlier).toBe(false);
  });

  it('rebind refetches with the new session excluded; the old session now comes from the timeline, never duplicated', async () => {
    const rebound = deferred();
    fetchMock.mockImplementation(route({
      timeline: (url) => (paramsOf(url).get('excludeSessionId') === 's-old'
        ? rebound.promise
        : page([msg('m-old', 's-old', 10)])),
    }));
    const view = render(<WispHomeThread {...extra} wisp={wisp} lastSessionId={null} />);
    await waitFor(() => expect(messageIds()).toEqual(['m-old', 'live-1']));

    // The store moves to s-old (its transcript now loads into the store).
    act(() => { Object.assign(h.state, { sessionId: 's-old', messages: [{ id: 'store-old', role: 'assistant', content: 'from the store', createdAt: new Date() }] }); });
    view.rerender(<WispHomeThread {...extra} wisp={wisp} lastSessionId={null} />);
    // While the refetch is in flight the held page's s-old rows are hidden: s-old is the store's now.
    expect(messageIds()).toEqual(['store-old']);
    await waitFor(() => expect(paramsOf(timelineCalls().at(-1) as string).get('excludeSessionId')).toBe('s-old'));

    // The persisted s-live rows arrive from the timeline (their ids differ from the streamed ones).
    await act(async () => { rebound.resolve(page([msg('m-live-persisted', 's-live', 40)])); });
    expect(messageIds()).toEqual(['m-live-persisted', 'store-old']);
  });

  it('a page from before a rebind never lands after it', async () => {
    const stale = deferred();
    fetchMock.mockImplementation(route({
      timeline: (url) => (paramsOf(url).get('excludeSessionId') === 's-live' ? stale.promise : page([msg('m-fresh', 's-live', 10)])),
    }));
    const view = render(<WispHomeThread {...extra} wisp={wisp} lastSessionId={null} />);
    await waitFor(() => expect(timelineCalls()).toHaveLength(1));
    act(() => { Object.assign(h.state, { sessionId: 's-next', messages: [] }); });
    view.rerender(<WispHomeThread {...extra} wisp={wisp} lastSessionId={null} />);
    await waitFor(() => expect(messageIds()).toEqual(['m-fresh']));
    await act(async () => { stale.resolve(page([msg('m-stale', 's-old', 5)])); });
    expect(messageIds()).toEqual(['m-fresh']);
  });

  it('poll refresh adds a new post once and keeps the pages already loaded', async () => {
    let calls = 0;
    fetchMock.mockImplementation(route({
      timeline: (url) => {
        if (paramsOf(url).get('cursor') === 'c-1') return page([msg('m-1', 's-old', 1)]);
        calls += 1;
        return calls === 1
          ? page([post('p-1', 30), msg('m-2', 's-old', 20)], 'c-1')
          : page([post('p-2', 50, { read: false }), post('p-1', 30, { read: true }), msg('m-2', 's-old', 20)], 'c-2');
      },
    }));
    const view = render(<WispHomeThread {...extra} wisp={wisp} lastSessionId={null} refreshKey={0} />);
    await waitFor(() => expect(extraIds()).toEqual(['p-1']));
    await act(async () => { lastKit().onLoadEarlier?.(); });
    await waitFor(() => expect(messageIds()).toEqual(['m-1', 'm-2', 'live-1']));

    view.rerender(<WispHomeThread {...extra} wisp={wisp} lastSessionId={null} refreshKey={1} />);
    await waitFor(() => expect(extraIds()).toEqual(['p-1', 'p-2']));
    // Paged history survives, the cursor still points past the oldest page, a post's read flag updates.
    expect(messageIds()).toEqual(['m-1', 'm-2', 'live-1']);
    expect(lastKit().hasEarlier).toBe(false);
    expect(screen.getAllByTestId('wisp-post-unread')).toHaveLength(1);

    view.rerender(<WispHomeThread {...extra} wisp={wisp} lastSessionId={null} refreshKey={2} />);
    await waitFor(() => expect(calls).toBe(3));
    expect(extraIds()).toEqual(['p-1', 'p-2']);
  });

  it('the welcome waits for the first page instead of flashing over history', async () => {
    reset({ wisp, sessionId: 's-live', messages: [] });
    const first = deferred();
    fetchMock.mockImplementation(route({ timeline: () => first.promise }));
    render(<WispHomeThread {...extra} wisp={wisp} lastSessionId={null} />);
    await screen.findByTestId('ai-chat-input-mock');
    expect(screen.queryByTestId('wisp-suggestion')).toBeNull();
    await act(async () => { first.resolve(page([msg('m-1', 's-old', 1)])); });
    expect(messageIds()).toEqual(['m-1']);
  });

  it('a failed first page says so and retries', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    let fail = true;
    fetchMock.mockImplementation(route({ timeline: () => (fail ? json({}, 500) : page([msg('m-1', 's-old', 1)])) }));
    render(<WispHomeThread {...extra} wisp={wisp} lastSessionId={null} />);
    const notice = await screen.findByTestId('wisp-home-thread-history-failed');
    expect(notice).toHaveTextContent('Could not load this conversation.');
    expect(err).toHaveBeenCalledWith(expect.stringContaining('[WispHomeThread]'), expect.anything());
    fail = false;
    fireEvent.click(screen.getByTestId('wisp-home-thread-history-retry'));
    await waitFor(() => expect(messageIds()).toEqual(['m-1', 'live-1']));
    expect(screen.queryByTestId('wisp-home-thread-history-failed')).toBeNull();
    err.mockRestore();
  });

  it('a failed Load earlier says so, keeps the page and its cursor, survives a refresh, and Retry loads that page', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    let failEarlier = true;
    fetchMock.mockImplementation(route({
      timeline: (url) => {
        if (paramsOf(url).get('cursor') === 'c-1') return failEarlier ? json({}, 500) : page([msg('m-1', 's-old', 1)]);
        return page([msg('m-2', 's-old', 20)], 'c-1');
      },
    }));
    const view = render(<WispHomeThread {...extra} wisp={wisp} lastSessionId={null} refreshKey={0} />);
    await waitFor(() => expect(lastKit().hasEarlier).toBe(true));
    await act(async () => { lastKit().onLoadEarlier?.(); });
    expect(await screen.findByTestId('wisp-home-thread-history-failed')).toHaveTextContent('Could not load earlier messages.');
    expect(lastKit().loadingEarlier).toBe(false);
    expect(lastKit().hasEarlier).toBe(true);
    expect(messageIds()).toEqual(['m-2', 'live-1']);

    // A refresh re-reads the newest page only: the older page is still missing, so the notice stays.
    view.rerender(<WispHomeThread {...extra} wisp={wisp} lastSessionId={null} refreshKey={1} />);
    await waitFor(() => expect(timelineCalls().filter((u) => !paramsOf(u).has('cursor'))).toHaveLength(2));
    expect(screen.getByTestId('wisp-home-thread-history-failed')).toHaveTextContent('Could not load earlier messages.');

    failEarlier = false;
    fireEvent.click(screen.getByTestId('wisp-home-thread-history-retry'));
    await waitFor(() => expect(messageIds()).toEqual(['m-1', 'm-2', 'live-1']));
    expect(paramsOf(timelineCalls().at(-1) as string).get('cursor')).toBe('c-1');
    expect(screen.queryByTestId('wisp-home-thread-history-failed')).toBeNull();
    err.mockRestore();
  });

  it('a failed refresh keeps the thread on screen and says so; Retry re-reads the newest page', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    let calls = 0;
    fetchMock.mockImplementation(route({
      timeline: () => {
        calls += 1;
        if (calls === 2) return json({}, 503);
        return calls === 1 ? page([post('p-1', 30)]) : page([post('p-2', 40), post('p-1', 30)]);
      },
    }));
    const view = render(<WispHomeThread {...extra} wisp={wisp} lastSessionId={null} refreshKey={0} />);
    await waitFor(() => expect(extraIds()).toEqual(['p-1']));
    view.rerender(<WispHomeThread {...extra} wisp={wisp} lastSessionId={null} refreshKey={1} />);
    expect(await screen.findByTestId('wisp-home-thread-history-failed')).toHaveTextContent('Could not check for new posts.');
    expect(extraIds()).toEqual(['p-1']);
    fireEvent.click(screen.getByTestId('wisp-home-thread-history-retry'));
    await waitFor(() => expect(extraIds()).toEqual(['p-1', 'p-2']));
    expect(screen.queryByTestId('wisp-home-thread-history-failed')).toBeNull();
    err.mockRestore();
  });

  it('a failure belongs to its target: after a rebind and back it is not shown while the new read is in flight', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    let failFirst = true;
    const pending = deferred();
    fetchMock.mockImplementation(route({
      timeline: (url) => {
        if (failFirst) return json({}, 500);
        return paramsOf(url).get('excludeSessionId') === 's-live' ? pending.promise : page([]);
      },
    }));
    const view = render(<WispHomeThread {...extra} wisp={wisp} lastSessionId={null} />);
    await screen.findByTestId('wisp-home-thread-history-failed');
    failFirst = false;
    act(() => { Object.assign(h.state, { sessionId: 's-next' }); });
    view.rerender(<WispHomeThread {...extra} wisp={wisp} lastSessionId={null} />);
    await waitFor(() => expect(paramsOf(timelineCalls().at(-1) as string).get('excludeSessionId')).toBe('s-next'));
    act(() => { Object.assign(h.state, { sessionId: 's-live' }); });
    view.rerender(<WispHomeThread {...extra} wisp={wisp} lastSessionId={null} />);
    await waitFor(() => expect(paramsOf(timelineCalls().at(-1) as string).get('excludeSessionId')).toBe('s-live'));
    expect(screen.queryByTestId('wisp-home-thread-history-failed')).toBeNull();
    await act(async () => { pending.resolve(page([msg('m-1', 's-old', 1)])); });
    expect(messageIds()).toEqual(['m-1', 'live-1']);
    err.mockRestore();
  });

  it('another thread never shows this thread’s rows, even while its first page is loading', async () => {
    const other = deferred();
    fetchMock.mockImplementation(route({
      timeline: (url) => (url.includes('/thread/th-2/') ? other.promise : page([post('p-1', 30), msg('m-1', 's-old', 10)], 'c-1')),
    }));
    const view = render(<WispHomeThread {...extra} wisp={wisp} lastSessionId={null} />);
    await waitFor(() => expect(extraIds()).toEqual(['p-1']));
    const wisp2 = { ...wisp, threadId: 'th-2', grantId: 'g-2' };
    act(() => { Object.assign(h.state, { wisp: wisp2, sessionId: 's-2', messages: [] }); });
    view.rerender(<WispHomeThread {...extra} wisp={wisp2} lastSessionId={null} />);
    await waitFor(() => expect(timelineCalls().some((u) => u.includes('/thread/th-2/'))).toBe(true));
    expect(extraIds()).toEqual([]);
    expect(messageIds()).toEqual([]);
    expect(lastKit().hasEarlier).toBe(false);
    expect(screen.queryByTestId('wisp-suggestion')).toBeNull();
    await act(async () => { other.resolve(page([post('p-9', 50)])); });
    expect(extraIds()).toEqual(['p-9']);
  });

  it('a rebind during Load earlier stops the spinner, hides Load earlier until the new page lands, and drops the old page', async () => {
    const older = deferred();
    const rebound = deferred();
    fetchMock.mockImplementation(route({
      timeline: (url) => {
        const p = paramsOf(url);
        if (p.get('cursor') === 'c-1') return older.promise;
        return p.get('excludeSessionId') === 's-next' ? rebound.promise : page([msg('m-2', 's-old', 20)], 'c-1');
      },
    }));
    const view = render(<WispHomeThread {...extra} wisp={wisp} lastSessionId={null} />);
    await waitFor(() => expect(lastKit().hasEarlier).toBe(true));
    act(() => { lastKit().onLoadEarlier?.(); });
    expect(lastKit().loadingEarlier).toBe(true);

    act(() => { Object.assign(h.state, { sessionId: 's-next', messages: [] }); });
    view.rerender(<WispHomeThread {...extra} wisp={wisp} lastSessionId={null} />);
    await waitFor(() => expect(lastKit().loadingEarlier).toBe(false));
    expect(lastKit().hasEarlier).toBe(false);
    const before = timelineCalls().length;
    act(() => { lastKit().onLoadEarlier?.(); });
    expect(timelineCalls()).toHaveLength(before);

    await act(async () => { older.resolve(page([msg('m-stale', 's-old', 1)])); });
    expect(messageIds()).not.toContain('m-stale');
    await act(async () => { rebound.resolve(page([msg('m-live-p', 's-live', 40), msg('m-2', 's-old', 20)], 'c-9')); });
    expect(messageIds()).toEqual(['m-2', 'm-live-p']);
    expect(lastKit().hasEarlier).toBe(true);
  });

  it('a paused grant shows its history read-only (nothing excluded), with no composer', async () => {
    reset();
    fetchMock.mockImplementation(route({ timeline: () => page([post('p-1', 30), msg('m-1', 's-old', 10)]) }));
    render(<WispHomeThread {...extra} wisp={{ ...wisp, status: 'paused' }} lastSessionId="s-old" />);
    await waitFor(() => expect(messageIds()).toEqual(['m-1']));
    expect(extraIds()).toEqual(['p-1']);
    expect(paramsOf(timelineCalls()[0] as string).has('excludeSessionId')).toBe(false);
    expect(screen.getByTestId('wisp-home-thread-inactive')).toBeInTheDocument();
    expect(screen.queryByTestId('ai-chat-input-mock')).toBeNull();
    expect(h.state.switchSession).not.toHaveBeenCalled();
  });

  it('an ended grant reads no timeline', async () => {
    reset();
    render(<WispHomeThread {...extra} wisp={{ ...wisp, status: 'revoked' }} lastSessionId="s-old" />);
    expect(screen.getByTestId('wisp-home-thread-inactive')).toBeInTheDocument();
    await Promise.resolve();
    expect(timelineCalls()).toHaveLength(0);
  });
});
