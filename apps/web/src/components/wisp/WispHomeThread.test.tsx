/**
 * W08 (#9921) Task 9: the inline Wisp conversation binds the shared chat store
 * to this thread without minting a session per visit: reuse the live one,
 * resume the thread's last session, else start the first — and nothing for a
 * paused or ended grant.
 */
import { useState } from 'react';
import type { WispThreadLink } from '@breeze/shared';
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
// W05 #10996: the check-in client is mocked (its own contract is wispCheckInsApi.test.ts).
const checkInsApi = vi.hoisted(() => ({ listWispCheckIns: vi.fn(async () => [] as unknown[]), cancelWispCheckIn: vi.fn(async () => {}) }));
vi.mock('@/lib/wispCheckInsApi', () => checkInsApi);
const toast = vi.hoisted(() => ({ showToast: vi.fn() }));
vi.mock('@/components/shared/Toast', () => toast);
const HOUR = 60 * 60 * 1000;
/** The session read; recently active unless `activity` says otherwise (#11430). */
const sessionRes = (status: string, wispGrantId = 'g-1', activity: { createdAt?: string; lastActivityAt?: string } = {}) => {
  const recent = new Date(Date.now() - 5 * 60 * 1000).toISOString();
  return ({ ok: true, status: 200, json: async () => ({ session: { id: 's-old', status, wispGrantId, createdAt: recent, lastActivityAt: recent, ...activity } }) }) as Response;
};
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
const kit = vi.hoisted(() => ({ messages: [] as Array<Record<string, unknown>>, input: [] as Array<Record<string, unknown>>, pickerOnLinked: null as null | ((link: WispThreadLink) => void) }));
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
const LINK = { id: 'l-1', ref: { kind: 'ticket', id: 't-1', orgId: 'o-1' }, label: 'Printer down', status: 'open', href: '/tickets/t-1', source: 'user_pin', lastTouchedAt: '2026-10-24T08:00:00Z', createdAt: '2026-10-25T09:00:00Z' };
vi.mock('./WispEntityPicker', () => ({
  default: (p: { open: boolean; threadId: string; linkedKeys: Set<string>; onLinked: (l: unknown) => void; onClose: () => void }) => {
    kit.pickerOnLinked = p.onLinked;
    return p.open ? (
      <div data-testid="picker-stub" data-thread={p.threadId} data-linked-keys={[...p.linkedKeys].join(",")}>
        <button type="button" onClick={() => p.onLinked(LINK)}>pick</button>
      </div>
    ) : null;
  },
}));
vi.mock('../ai/AiThinkingIndicator', () => ({ default: () => null, approvalWaitFromPending: () => null }));
vi.mock('../ai/AiModelPicker', () => ({
  default: (p: { disabled?: boolean }) => <div data-testid="ai-model-picker-mock" data-disabled={String(!!p.disabled)} />,
}));
vi.mock('../ai/AiContinuationPrompt', () => ({ default: () => null }));
vi.mock('../ai/BuyCreditsLink', () => ({ default: () => null }));

import WispHomeThread from './WispHomeThread';
import { ActionError } from '@/lib/runAction';
import { useWispInstructionCaptureStore } from '@/stores/wispInstructionCaptureStore';

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
    useWispInstructionCaptureStore.getState().reset();
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

  // #11430: the server's read now reports an idled-out session as expired; the
  // column still refuses to resume one whose own timestamps say the first send
  // would be refused (an older API, or a read that raced the expiry).
  it.each([
    ['idle for 3 days', { lastActivityAt: new Date(Date.now() - 72 * HOUR).toISOString() }],
    ['idle past the 2 h window', { lastActivityAt: new Date(Date.now() - 3 * HOUR).toISOString() }],
    ['older than 24 h though busy', { createdAt: new Date(Date.now() - 25 * HOUR).toISOString() }],
  ])('#11430: an "active" last session %s is not resumed: a fresh session starts', async (_label, activity) => {
    fetchMock.mockImplementation(route({ session: sessionRes('active', 'g-1', activity) }));
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

  // The column is the whole thread (one thread per grant, companion spec):
  // there is no "New conversation"; closing a session would change nothing on screen.
  it('offers no "New conversation" control', async () => {
    reset({ wisp, sessionId: 's-live' });
    render(<WispHomeThread {...extra} wisp={wisp} lastSessionId={null} />);
    expect(await screen.findByTestId('ai-chat-input-mock')).toBeInTheDocument();
    expect(screen.queryByTestId('wisp-home-new-conversation')).toBeNull();
    expect(screen.queryByText('aiChatSidebar.newConversation')).toBeNull();
  });

  // The model menu the docked panel shows (registry W05), above the composer; locked while a turn streams.
  it('shows the model picker above the composer, disabled while streaming', async () => {
    reset({ wisp, sessionId: 's-live', isStreaming: true });
    render(<WispHomeThread {...extra} wisp={wisp} lastSessionId={null} />);
    expect(await screen.findByTestId('ai-chat-input-mock')).toBeInTheDocument();
    const picker = screen.getByTestId('ai-model-picker-mock');
    expect(picker.dataset.disabled).toBe('true');
    expect(picker.compareDocumentPosition(screen.getByTestId('ai-chat-input-mock')) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('shows no model picker for a paused grant', () => {
    render(<WispHomeThread {...extra} wisp={{ ...wisp, status: 'paused' }} lastSessionId={null} />);
    expect(screen.queryByTestId('ai-model-picker-mock')).toBeNull();
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

  describe('the first look (#10402)', () => {
    const firstLookPost = { source: 'post', id: 'p-fl', kind: 'first_look', title: 'First look done: 2 of 2 organizations', body: 'Open concerns: 1 high.', link: '/ai/wisp/thread/th-1', sections: null, concernId: null, orgId: null, read: null, createdAt: '2026-10-26T07:00:00.000Z' };
    const schedule = { timeLocal: '08:00', timezone: 'America/Denver', browserTimezone: 'America/Denver' };

    it('swaps the welcome to "I\'ve had a first look" once the post is in the thread, with the post above it', async () => {
      fetchMock.mockImplementation(route({ timeline: () => json({ data: { items: [firstLookPost], nextCursor: null } }) }));
      render(<WispHomeThread {...extra} wisp={wisp} lastSessionId={null} />);
      expect(await screen.findByText("I've had a first look at All organizations.")).toBeInTheDocument();
      expect(screen.getByTestId('wisp-post')).toHaveAttribute('data-kind', 'first_look');
      expect(screen.queryByText("I'm looking around All organizations.")).toBeNull();
      expect(screen.getAllByTestId('wisp-suggestion')).toHaveLength(4);
    });

    it("#11145: a couldn't-look post says so in the welcome, not \"first look\"", async () => {
      const couldntLook = { ...firstLookPost, id: 'p-cl', variant: 'couldnt_look', title: "I couldn't look yet: 0 of 2 organizations" };
      fetchMock.mockImplementation(route({ timeline: () => json({ data: { items: [couldntLook], nextCursor: null } }) }));
      render(<WispHomeThread {...extra} wisp={wisp} lastSessionId={null} />);
      expect(await screen.findByText("I couldn't look at All organizations yet.")).toBeInTheDocument();
      expect(screen.getByTestId('wisp-post')).toHaveAttribute('data-variant', 'couldnt_look');
      expect(screen.queryByText("I've had a first look at All organizations.")).toBeNull();
      expect(screen.queryByText("I'm looking around All organizations.")).toBeNull();
    });

    it("#11145: a later real first look outranks the couldn't-look post above it", async () => {
      const couldntLook = { ...firstLookPost, id: 'p-cl', variant: 'couldnt_look', title: "I couldn't look yet: 0 of 2 organizations", createdAt: '2026-10-26T06:00:00.000Z' };
      fetchMock.mockImplementation(route({ timeline: () => json({ data: { items: [firstLookPost, couldntLook], nextCursor: null } }) }));
      render(<WispHomeThread {...extra} wisp={wisp} lastSessionId={null} />);
      expect(await screen.findByText("I've had a first look at All organizations.")).toBeInTheDocument();
    });

    it("#11145: the grant's state speaks when the post is not on this page of the timeline", async () => {
      fetchMock.mockImplementation(route({ timeline: () => json({ data: { items: [], nextCursor: null } }) }));
      render(<WispHomeThread {...extra} wisp={{ ...wisp, firstLookState: 'couldnt_look' }} lastSessionId={null} />);
      expect(await screen.findByText("I couldn't look at All organizations yet.")).toBeInTheDocument();
    });

    describe('#11146: progress', () => {
      const progress = { lookedAtOrgs: 1, queuedOrgs: 1, failedOrgs: 0, totalOrgs: 2 };

      it('the welcome shows the counts until the post arrives, then not', async () => {
        let posted = false;
        fetchMock.mockImplementation(route({ timeline: () => json({ data: { items: posted ? [firstLookPost] : [], nextCursor: null } }) }));
        const { rerender } = render(<WispHomeThread {...extra} wisp={wisp} lastSessionId={null} refreshKey={0} firstLookProgress={progress} />);
        expect(await screen.findByTestId('wisp-welcome-progress-looked')).toHaveTextContent('1 of 2 organizations looked at');
        posted = true;
        rerender(<WispHomeThread {...extra} wisp={wisp} lastSessionId={null} refreshKey={1} firstLookProgress={progress} />);
        expect(await screen.findByText("I've had a first look at All organizations.")).toBeInTheDocument();
        expect(screen.queryByTestId('wisp-welcome-progress')).toBeNull();
      });
    });

    it('a refresh that brings the post flips a welcome already on screen', async () => {
      let posted = false;
      fetchMock.mockImplementation(route({ timeline: () => json({ data: { items: posted ? [firstLookPost] : [], nextCursor: null } }) }));
      const { rerender } = render(<WispHomeThread {...extra} wisp={wisp} lastSessionId={null} refreshKey={0} />);
      expect(await screen.findByText("I'm looking around All organizations.")).toBeInTheDocument();
      posted = true;
      rerender(<WispHomeThread {...extra} wisp={wisp} lastSessionId={null} refreshKey={1} />);
      expect(await screen.findByText("I've had a first look at All organizations.")).toBeInTheDocument();
    });

    it('still "looking" while the thread has only other posts', async () => {
      fetchMock.mockImplementation(route({ timeline: () => json({ data: { items: [{ ...firstLookPost, kind: 'nudge' }], nextCursor: null } }) }));
      render(<WispHomeThread {...extra} wisp={wisp} lastSessionId={null} />);
      expect(await screen.findByText("I'm looking around All organizations.")).toBeInTheDocument();
    });

    it('passes the brief schedule to the welcome', async () => {
      render(<WispHomeThread {...extra} wisp={wisp} lastSessionId={null} briefSchedule={schedule} />);
      expect(await screen.findByTestId('wisp-welcome-brief-at')).toHaveTextContent('08:00 (America/Denver)');
    });
  });

  it('the composer link button opens the entity picker and a pick is added to the links', async () => {
    const existing = { ...LINK, id: 'l-0', ref: { ...LINK.ref, id: 't-other' }, label: 'Old' };
    render(<WispHomeThread {...extra} links={[existing] as never[]} wisp={wisp} lastSessionId={null} />);
    const button = await screen.findByTestId('wisp-composer-link');
    expect(button).toHaveAccessibleName('Link an item');
    expect(screen.queryByTestId('picker-stub')).toBeNull();
    fireEvent.click(button);
    expect(screen.getByTestId('picker-stub')).toHaveAttribute('data-thread', 'th-1');
    fireEvent.click(screen.getByText('pick'));
    expect(onLinksChange).toHaveBeenCalledWith(expect.any(Function));
    expect(onLinksChange.mock.calls[0][0]([existing])).toEqual([existing, LINK]);
    expect(screen.queryByTestId('picker-stub')).toBeNull();
  });

  it('re-linking an item already linked replaces it instead of adding a second row', async () => {
    render(<WispHomeThread {...extra} links={[{ ...LINK, label: 'stale' }] as never[]} wisp={wisp} lastSessionId={null} />);
    fireEvent.click(await screen.findByTestId('wisp-composer-link'));
    fireEvent.click(screen.getByText('pick'));
    expect(onLinksChange).toHaveBeenCalledWith(expect.any(Function));
    expect(onLinksChange.mock.calls[0][0]([{ ...LINK, label: 'stale' }])).toEqual([LINK]);
  });

  it.each(['concern', 'auto', 'pins'] as const)('50 %s rows apply the pin-only composer cap', async (source) => {
    const links: WispThreadLink[] = Array.from({ length: 50 }, (_, i) => ({
      ...LINK,
      id: source === 'concern' ? null : `l-${i}`,
      ref: { ...LINK.ref, kind: 'ticket', id: `t-${i}` },
      source: source === 'pins' ? (i % 2 ? 'wisp_pin' : 'user_pin') : source,
    }));
    render(<WispHomeThread {...extra} links={links} wisp={wisp} lastSessionId={null} />);
    const button = await screen.findByTestId('wisp-composer-link');
    if (source === 'pins') {
      expect(button).toBeDisabled();
    } else {
      expect(button).toBeEnabled();
      fireEvent.click(button);
      expect(screen.getByTestId('picker-stub')).toBeInTheDocument();
    }
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

  describe('#11287: no model provider on the server (503 ai_not_configured)', () => {
    /** As createSession leaves the store after the refusal: no session, the server's code kept. */
    const refused = () => vi.fn(async (w: typeof wisp) => {
      Object.assign(h.state, { wisp: w, sessionId: null, error: 'AI is not configured on this server.', errorCode: 'ai_not_configured' });
    });

    it('says why instead of the generic retry, and shows the thread so far read-only', async () => {
      reset({ enterWispMode: refused() });
      fetchMock.mockImplementation(route({ timeline: () => page([post('p-1', 30)]) }));
      render(<WispHomeThread {...extra} wisp={wisp} lastSessionId={null} />);
      expect(await screen.findByTestId('wisp-home-thread-not-configured'))
        .toHaveTextContent("AI isn't configured on this server. An administrator needs to add a model provider key.");
      expect(screen.queryByText('Could not open the conversation.')).toBeNull();
      expect(screen.queryByTestId('wisp-home-thread-failed')).toBeNull();
      await waitFor(() => expect(extraIds()).toEqual(['p-1']));
      expect(paramsOf(timelineCalls()[0] as string).has('excludeSessionId')).toBe(false);
      expect(screen.queryByTestId('ai-chat-input-mock')).toBeNull();
    });

    it('Try again binds the conversation once a key has been added', async () => {
      reset({ enterWispMode: refused() });
      fetchMock.mockImplementation(route());
      render(<WispHomeThread {...extra} wisp={wisp} lastSessionId={null} />);
      await screen.findByTestId('wisp-home-thread-not-configured');
      h.state.enterWispMode = vi.fn(async (w: typeof wisp) => { Object.assign(h.state, { wisp: w, sessionId: 's-new', error: null, errorCode: null }); });
      fireEvent.click(screen.getByTestId('wisp-home-thread-not-configured-retry'));
      expect(await screen.findByTestId('ai-chat-input-mock')).toBeInTheDocument();
      expect(screen.queryByTestId('wisp-home-thread-not-configured')).toBeNull();
    });

    it('keeps the reason when another surface clears the shared store error', async () => {
      reset({ enterWispMode: refused() });
      fetchMock.mockImplementation(route());
      const view = render(<WispHomeThread {...extra} wisp={wisp} lastSessionId={null} />);
      await screen.findByTestId('wisp-home-thread-not-configured');
      act(() => { Object.assign(h.state, { error: null, errorCode: null }); });
      view.rerender(<WispHomeThread {...extra} wisp={wisp} lastSessionId={null} />);
      expect(screen.getByTestId('wisp-home-thread-not-configured')).toBeInTheDocument();
    });

    it('any other failed open keeps the generic retry', async () => {
      reset({ enterWispMode: vi.fn(async (w: typeof wisp) => { Object.assign(h.state, { wisp: w, sessionId: null, errorCode: 'grant_inactive' }); }) });
      fetchMock.mockImplementation(route());
      render(<WispHomeThread {...extra} wisp={wisp} lastSessionId={null} />);
      expect(await screen.findByTestId('wisp-home-thread-failed')).toHaveTextContent('Could not open the conversation.');
      expect(screen.getByTestId('wisp-home-thread-retry')).toBeInTheDocument();
      expect(screen.queryByTestId('wisp-home-thread-not-configured')).toBeNull();
    });
  });

  it('an ended grant reads no timeline', async () => {
    reset();
    render(<WispHomeThread {...extra} wisp={{ ...wisp, status: 'revoked' }} lastSessionId="s-old" />);
    expect(screen.getByTestId('wisp-home-thread-inactive')).toBeInTheDocument();
    await Promise.resolve();
    expect(timelineCalls()).toHaveLength(0);
  });
});

it('composer picker excludes derived concern keys and pinning replaces that entity only', async () => {
  const concern = { ...LINK, id: null, source: 'concern' as const };
  const other = { ...concern, ref: { ...concern.ref, id: 't-other' } };
  render(<WispHomeThread {...extra} links={[concern, other] as WispThreadLink[]} wisp={wisp} lastSessionId={null} />);
  fireEvent.click(await screen.findByTestId('wisp-composer-link'));
  expect(screen.getByTestId('picker-stub')).toHaveAttribute('data-linked-keys', '');
  fireEvent.click(screen.getByText('pick'));
  expect(onLinksChange).toHaveBeenCalledWith(expect.any(Function));
  expect(onLinksChange.mock.calls[0][0]([concern, other])).toEqual([LINK, other]);
});


it('composer picker preserves a poll that lands before the pending pick returns', async () => {
  reset({ wisp, sessionId: 's-live' });
  fetchMock.mockImplementation(route());
  let poll!: (links: WispThreadLink[]) => void;
  const polled = { ...LINK, id: 'l-polled', ref: { ...LINK.ref, id: 't-polled' } } as WispThreadLink;
  function HomeThread() {
    const [links, setLinks] = useState<WispThreadLink[]>([]);
    poll = setLinks;
    return <><WispHomeThread {...extra} wisp={wisp} lastSessionId={null} links={links} onLinksChange={setLinks} />
      <output data-testid="latest-link-ids">{links.map((link) => link.id).join(',')}</output></>;
  }
  render(<HomeThread />);
  fireEvent.click(await screen.findByTestId('wisp-composer-link'));
  const pendingPick = kit.pickerOnLinked!;
  act(() => poll([polled]));
  act(() => pendingPick(LINK as WispThreadLink));
  expect(screen.getByTestId('latest-link-ids')).toHaveTextContent('l-polled,l-1');
});

describe('WispHomeThread check-ins (W05 #10996)', () => {
  const CHECK_IN_LINK = (id: string) => `/ai/wisp/thread/th-1#checkin=${id}`;
  const checkInPost = (id: string) => ({
    source: 'post', id: `p-${id}`, kind: 'check_in', title: `Check-in due: ${id}`, body: null, link: CHECK_IN_LINK(id),
    sections: null, concernId: null, orgId: null, read: null, createdAt: new Date(Date.UTC(2026, 10, 5, 8, 0)).toISOString(),
  });
  const row = (id: string, status: string, dueAt = new Date(Date.now() + 10 * 60_000).toISOString()) => ({
    id, threadId: 'th-1', status, dueAt, instruction: `do ${id}`, subject: null, firedAt: status === 'fired' ? dueAt : null, createdAt: dueAt,
  });
  const withPosts = (posts: unknown[]) => route({ timeline: () => json({ data: { items: posts, nextCursor: null } }) });
  const scrollIntoView = vi.fn();

  beforeEach(() => {
    reset({ wisp, sessionId: 's-live' });
    kit.messages.length = 0;
    kit.input.length = 0;
    fetchMock.mockReset();
    fetchMock.mockImplementation(route());
    checkInsApi.listWispCheckIns.mockReset().mockResolvedValue([]);
    checkInsApi.cancelWispCheckIn.mockReset().mockResolvedValue(undefined);
    toast.showToast.mockReset();
    scrollIntoView.mockReset();
    Element.prototype.scrollIntoView = scrollIntoView;
    window.history.replaceState(null, '', window.location.pathname);
  });

  it('loads the thread\'s check-ins once bound', async () => {
    render(<WispHomeThread {...extra} wisp={wisp} lastSessionId={null} />);
    await waitFor(() => expect(checkInsApi.listWispCheckIns).toHaveBeenCalledWith('th-1'));
  });

  it('refetches check-ins when a turn finishes streaming', async () => {
    const view = render(<WispHomeThread {...extra} wisp={wisp} lastSessionId={null} />);
    await waitFor(() => expect(checkInsApi.listWispCheckIns).toHaveBeenCalledTimes(1));
    checkInsApi.listWispCheckIns.mockResolvedValue([row('ci-new', 'scheduled')]);
    act(() => { Object.assign(h.state, { isStreaming: true }); });
    view.rerender(<WispHomeThread {...extra} wisp={wisp} lastSessionId={null} />);
    expect(checkInsApi.listWispCheckIns).toHaveBeenCalledTimes(1);
    act(() => { Object.assign(h.state, { isStreaming: false }); });
    view.rerender(<WispHomeThread {...extra} wisp={wisp} lastSessionId={null} />);
    await waitFor(() => expect(checkInsApi.listWispCheckIns).toHaveBeenCalledTimes(2));
    // The chip shows as soon as the reply that scheduled it ends, not on the next poll.
    expect(await screen.findByTestId('wisp-check-in-chip')).toHaveAttribute('data-check-in-id', 'ci-new');
  });

  it('refetches check-ins on every refreshKey change (the page poll)', async () => {
    const view = render(<WispHomeThread {...extra} wisp={wisp} lastSessionId={null} refreshKey={0} />);
    await waitFor(() => expect(checkInsApi.listWispCheckIns).toHaveBeenCalledTimes(1));
    view.rerender(<WispHomeThread {...extra} wisp={wisp} lastSessionId={null} refreshKey={1} />);
    await waitFor(() => expect(checkInsApi.listWispCheckIns).toHaveBeenCalledTimes(2));
  });

  it('a failed load is logged and keeps the previous list', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    checkInsApi.listWispCheckIns.mockResolvedValueOnce([row('ci-1', 'scheduled')]);
    const view = render(<WispHomeThread {...extra} wisp={wisp} lastSessionId={null} refreshKey={0} />);
    expect(await screen.findByTestId('wisp-check-in-chip')).toBeInTheDocument();
    checkInsApi.listWispCheckIns.mockRejectedValueOnce(new Error('503'));
    view.rerender(<WispHomeThread {...extra} wisp={wisp} lastSessionId={null} refreshKey={1} />);
    await waitFor(() => expect(warn).toHaveBeenCalledWith(expect.stringContaining('[WispHomeThread]'), expect.any(Error)));
    expect(screen.getByTestId('wisp-check-in-chip')).toHaveAttribute('data-check-in-id', 'ci-1');
    warn.mockRestore();
  });

  it('shows Run now on a fired check-in post and sends "Go ahead with the check-in"', async () => {
    fetchMock.mockImplementation(withPosts([checkInPost('ci-1')]));
    checkInsApi.listWispCheckIns.mockResolvedValue([row('ci-1', 'fired')]);
    render(<WispHomeThread {...extra} wisp={wisp} lastSessionId={null} />);
    fireEvent.click(await screen.findByTestId('wisp-post-run-now'));
    expect(h.state.sendMessage).toHaveBeenCalledWith('Go ahead with the check-in');
  });

  it('Run now is disabled while a turn streams', async () => {
    fetchMock.mockImplementation(withPosts([checkInPost('ci-1')]));
    checkInsApi.listWispCheckIns.mockResolvedValue([row('ci-1', 'fired')]);
    reset({ wisp, sessionId: 's-live', isStreaming: true });
    render(<WispHomeThread {...extra} wisp={wisp} lastSessionId={null} />);
    expect(await screen.findByTestId('wisp-post-run-now')).toBeDisabled();
  });

  it('hides Run now on a consumed or cancelled check-in post', async () => {
    // Consumed and cancelled rows are not listed; a fired row for another check-in does not count.
    fetchMock.mockImplementation(withPosts([checkInPost('ci-1')]));
    checkInsApi.listWispCheckIns.mockResolvedValue([row('ci-other', 'fired')]);
    render(<WispHomeThread {...extra} wisp={wisp} lastSessionId={null} />);
    expect(await screen.findByTestId('wisp-post')).toHaveAttribute('data-check-in-id', 'ci-1');
    await waitFor(() => expect(checkInsApi.listWispCheckIns).toHaveBeenCalled());
    expect(screen.queryByTestId('wisp-post-run-now')).toBeNull();
  });

  it('cancel calls the client and reloads the list', async () => {
    checkInsApi.listWispCheckIns.mockResolvedValueOnce([row('ci-2', 'scheduled')]).mockResolvedValue([]);
    render(<WispHomeThread {...extra} wisp={wisp} lastSessionId={null} />);
    fireEvent.click(await screen.findByTestId('wisp-check-in-cancel'));
    await waitFor(() => expect(checkInsApi.cancelWispCheckIn).toHaveBeenCalledWith('th-1', 'ci-2'));
    await waitFor(() => expect(checkInsApi.listWispCheckIns).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.queryByTestId('wisp-check-in-chip')).toBeNull());
  });

  it('a refused cancel (ActionError, already toasted) reloads without a second toast; a 401 does nothing more', async () => {
    checkInsApi.listWispCheckIns.mockResolvedValue([row('ci-2', 'scheduled')]);
    checkInsApi.cancelWispCheckIn.mockRejectedValueOnce(new ActionError('gone', 404, 'not_found'));
    render(<WispHomeThread {...extra} wisp={wisp} lastSessionId={null} />);
    fireEvent.click(await screen.findByTestId('wisp-check-in-cancel'));
    await waitFor(() => expect(checkInsApi.listWispCheckIns).toHaveBeenCalledTimes(2));
    expect(toast.showToast).not.toHaveBeenCalled();

    checkInsApi.cancelWispCheckIn.mockRejectedValueOnce(new ActionError('auth', 401));
    fireEvent.click(screen.getByTestId('wisp-check-in-cancel'));
    await waitFor(() => expect(checkInsApi.cancelWispCheckIn).toHaveBeenCalledTimes(2));
    await Promise.resolve();
    expect(checkInsApi.listWispCheckIns).toHaveBeenCalledTimes(2);
    expect(toast.showToast).not.toHaveBeenCalled();
  });

  it('a cancelled chip disappears at once, even when the reload after it fails', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    checkInsApi.listWispCheckIns.mockResolvedValueOnce([row('ci-2', 'scheduled'), row('ci-3', 'scheduled')]).mockRejectedValue(new Error('503'));
    render(<WispHomeThread {...extra} wisp={wisp} lastSessionId={null} />);
    fireEvent.click((await screen.findAllByTestId('wisp-check-in-cancel'))[0]);
    await waitFor(() => expect(screen.getAllByTestId('wisp-check-in-chip')).toHaveLength(1));
    expect(screen.getByTestId('wisp-check-in-chip')).toHaveAttribute('data-check-in-id', 'ci-3');
    warn.mockRestore();
  });

  it('a 404 cancel (already consumed or cancelled) drops the chip too', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    checkInsApi.listWispCheckIns.mockResolvedValueOnce([row('ci-2', 'scheduled')]).mockRejectedValue(new Error('503'));
    checkInsApi.cancelWispCheckIn.mockRejectedValueOnce(new ActionError('gone', 404, 'not_found'));
    render(<WispHomeThread {...extra} wisp={wisp} lastSessionId={null} />);
    fireEvent.click(await screen.findByTestId('wisp-check-in-cancel'));
    await waitFor(() => expect(screen.queryByTestId('wisp-check-in-chip')).toBeNull());
    warn.mockRestore();
  });

  it('Run now is disabled while the chat is loading', async () => {
    fetchMock.mockImplementation(withPosts([checkInPost('ci-1')]));
    checkInsApi.listWispCheckIns.mockResolvedValue([row('ci-1', 'fired')]);
    reset({ wisp, sessionId: 's-live', isLoading: true });
    render(<WispHomeThread {...extra} wisp={wisp} lastSessionId={null} />);
    expect(await screen.findByTestId('wisp-post-run-now')).toBeDisabled();
  });

  it('a cancel that throws outside runAction is toasted', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    checkInsApi.listWispCheckIns.mockResolvedValue([row('ci-2', 'scheduled')]);
    checkInsApi.cancelWispCheckIn.mockRejectedValueOnce(new TypeError('network'));
    render(<WispHomeThread {...extra} wisp={wisp} lastSessionId={null} />);
    fireEvent.click(await screen.findByTestId('wisp-check-in-cancel'));
    await waitFor(() => expect(toast.showToast).toHaveBeenCalledWith(expect.objectContaining({ type: 'error', message: 'Could not cancel the check-in.' })));
    error.mockRestore();
  });

  it('scrolls the hash-selected check-in post into view once', async () => {
    window.history.replaceState(null, '', `${window.location.pathname}#checkin=ci-1`);
    fetchMock.mockImplementation(withPosts([checkInPost('ci-0'), checkInPost('ci-1')]));
    const view = render(<WispHomeThread {...extra} wisp={wisp} lastSessionId={null} refreshKey={0} />);
    await waitFor(() => expect(scrollIntoView).toHaveBeenCalledTimes(1));
    expect(scrollIntoView).toHaveBeenCalledWith({ block: 'center' });
    expect(scrollIntoView.mock.contexts[0]).toHaveAttribute('data-check-in-id', 'ci-1');
    view.rerender(<WispHomeThread {...extra} wisp={wisp} lastSessionId={null} refreshKey={1} />);
    await waitFor(() => expect(timelineCalls().length).toBeGreaterThanOrEqual(2));
    await new Promise((r) => requestAnimationFrame(() => r(null)));
    expect(scrollIntoView).toHaveBeenCalledTimes(1);
  });

  it('a bell clicked while the page is open (hash change) scrolls to that post', async () => {
    fetchMock.mockImplementation(withPosts([checkInPost('ci-0'), checkInPost('ci-1')]));
    render(<WispHomeThread {...extra} wisp={wisp} lastSessionId={null} />);
    expect(await screen.findAllByTestId('wisp-post')).toHaveLength(2);
    expect(scrollIntoView).not.toHaveBeenCalled();
    act(() => {
      window.history.replaceState(null, '', `${window.location.pathname}#checkin=ci-0`);
      window.dispatchEvent(new HashChangeEvent('hashchange'));
    });
    await waitFor(() => expect(scrollIntoView).toHaveBeenCalledTimes(1));
    expect(scrollIntoView.mock.contexts[0]).toHaveAttribute('data-check-in-id', 'ci-0');
  });

  it('a paused grant shows the post without Run now or chip', async () => {
    fetchMock.mockImplementation(withPosts([checkInPost('ci-1')]));
    checkInsApi.listWispCheckIns.mockResolvedValue([row('ci-1', 'fired'), row('ci-2', 'scheduled')]);
    reset();
    render(<WispHomeThread {...extra} wisp={{ ...wisp, status: 'paused' }} lastSessionId={null} />);
    expect(await screen.findByTestId('wisp-post')).toHaveAttribute('data-kind', 'check_in');
    expect(screen.queryByTestId('wisp-post-run-now')).toBeNull();
    expect(screen.queryByTestId('wisp-check-in-chip')).toBeNull();
    expect(checkInsApi.listWispCheckIns).not.toHaveBeenCalled();
  });

  it('loads the live session’s captured instructions once and renders them as chips', async () => {
    useWispInstructionCaptureStore.getState().reset();
    const instruction = {
      instructionId: 'i-1', captureId: 'c-1', capturedAt: '2026-11-08T10:00:00.000Z', text: "don't reboot PC-01",
      status: 'unconfirmed', enforceable: false, verb: null, targetLabels: [], until: null,
      orgId: null, orgName: null, unmatched: false, keptForOrg: false,
    };
    fetchMock.mockImplementation(async (url: string) => (
      url.includes('/wisp/memory/captures?') ? json({ instructions: [instruction] }) : route()(url)
    ));
    reset({ wisp, sessionId: 's-live' });
    render(<WispHomeThread {...extra} wisp={wisp} lastSessionId="s-old" />);
    expect(await screen.findByTestId('wisp-instruction-chip')).toBeInTheDocument();
    const loads = fetchMock.mock.calls.map((c) => c[0] as string).filter((u) => u.includes('/wisp/memory/captures?'));
    expect(loads).toEqual(['/wisp/memory/captures?sessionId=s-live']);
    const ids = (kit.messages.at(-1)?.extras as Array<{ id: string }>).map((e) => e.id);
    expect(ids).toContain('wisp-instruction-i-1');
  });
});
