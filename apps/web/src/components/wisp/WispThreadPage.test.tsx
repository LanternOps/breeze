import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';

const h = vi.hoisted(() => ({
  fetchWithAuth: vi.fn(),
  fetchActivity: vi.fn(),
  updateWisp: vi.fn(),
  exitWispMode: vi.fn(),
  storeWisp: null as null | { threadId: string },
  railProps: [] as Array<Record<string, unknown>>,
  threadProps: [] as Array<Record<string, unknown>>,
}));
vi.mock('@/stores/auth', () => ({ fetchWithAuth: h.fetchWithAuth }));
vi.mock('@/stores/aiStore', () => ({
  useAiStore: (sel: (s: unknown) => unknown) =>
    sel({ wisp: h.storeWisp, isOpen: false, updateWisp: h.updateWisp, exitWispMode: h.exitWispMode }),
}));
vi.mock('@/stores/orgStore', () => ({
  useOrgStore: (sel: (s: unknown) => unknown) => sel({ organizations: [{ id: 'org-a', name: 'Greenwood' }] }),
}));
// Wide viewport: the rail sits in the aside beside the column.
vi.mock('@/lib/useMediaQuery', () => ({ useMediaQuery: () => true }));
vi.mock('./wispActivity', () => ({ fetchWispActivity: (...a: unknown[]) => h.fetchActivity(...a) }));
vi.mock('./WispRail', () => ({
  default: (props: Record<string, unknown>) => {
    h.railProps.push(props);
    const wisp = props.wisp as { status: string };
    return <div data-testid="wisp-rail" data-status={wisp.status} />;
  },
}));
vi.mock('./WispHomeThread', () => ({
  default: (props: Record<string, unknown>) => {
    h.threadProps.push(props);
    return <div data-testid="wisp-home-thread">{props.leading as ReactNode}</div>;
  },
}));

import WispThreadPage from './WispThreadPage';

const payload = (o: { grant?: Record<string, unknown>; thread?: Record<string, unknown> } = {}) => ({
  data: {
    thread: { id: 't1', grantId: 'g1', summary: 'All quiet.', focusOrgId: null, lastSessionId: 's-last', ...o.thread },
    focusOrgName: null,
    grant: {
      id: 'g1', status: 'active', orgId: 'org-a', expiresAt: '2027-01-17T00:00:00.000Z', currentRevisionId: 'r1',
      budgetCentsPerDay: 200, floorTickMinutes: 30, spentTodayCents: 42, budgetResetsAt: '2026-10-25T00:00:00.000Z',
      ...o.grant,
    },
  },
});
const res = (status: number, body: unknown) => ({ ok: status < 400, status, json: async () => body }) as unknown as Response;
const lastRail = () => h.railProps[h.railProps.length - 1]!;
const lastThread = () => h.threadProps[h.threadProps.length - 1]!;

beforeEach(() => {
  vi.clearAllMocks();
  h.railProps = [];
  h.threadProps = [];
  h.storeWisp = null;
  h.fetchActivity.mockResolvedValue({ items: [], nextCursor: null, current: null });
  h.fetchWithAuth.mockResolvedValue(res(200, payload()));
});
afterEach(() => {
  vi.useRealTimers();
});

describe('WispThreadPage (W06 T7, W01 T13 companion layout)', () => {
  it('ready state renders the thread column and the rail without links', async () => {
    render(<WispThreadPage threadId="t1" />);
    await screen.findByTestId('wisp-rail');
    expect(h.fetchWithAuth).toHaveBeenCalledWith('/wisp/thread/t1', { skipOrgIdInjection: true }); // id-addressed: the switcher's org must not narrow it

    const page = screen.getByTestId('wisp-thread-page');
    expect(within(page).getByTestId('wisp-home-thread')).toBeTruthy();
    expect(within(screen.getByTestId('wisp-rail-aside')).getByTestId('wisp-rail')).toBeTruthy();
    expect(page.querySelector('h1')).toBeNull(); // the identity card carries the name
    expect(screen.queryByTestId('wisp-thread-open-chat')).toBeNull(); // the conversation is inline now

    expect(lastThread()).toMatchObject({
      lastSessionId: 's-last',
      links: null, // the page lists no links, so the composer offers no "Link an item"
      scopeLabel: 'Greenwood',
      wisp: expect.objectContaining({ grantId: 'g1', threadId: 't1' }),
    });
    expect(lastRail()).toMatchObject({
      orgName: 'Greenwood',
      current: null,
      links: null, // no home payload links on the thread page
      needsYou: [], // WispNeedsYou's concerns panel loads the grant's rows (and the #concern= deep link) itself
      activityKey: 0,
      wisp: expect.objectContaining({ grantId: 'g1', threadId: 't1', scopeOrgId: 'org-a', status: 'active', summary: 'All quiet.', spentTodayCents: 42 }),
    });
  });

  it('a grant over every organization labels its scope "All organizations"', async () => {
    h.fetchWithAuth.mockResolvedValue(res(200, payload({ grant: { orgId: null } })));
    render(<WispThreadPage threadId="t1" />);
    await screen.findByTestId('wisp-rail');
    expect(lastThread().scopeLabel).toBe('All organizations');
    expect(lastRail().orgName).toBeNull();
  });

  it('a non-string lastSessionId reaches the thread as null', async () => {
    h.fetchWithAuth.mockResolvedValue(res(200, payload({ thread: { lastSessionId: 42 } })));
    render(<WispThreadPage threadId="t1" />);
    await screen.findByTestId('wisp-rail');
    expect(lastThread().lastSessionId).toBeNull();
  });

  it('summary renders as a post', async () => {
    render(<WispThreadPage threadId="t1" />);
    const column = await screen.findByTestId('wisp-home-thread');
    const post = within(column).getByRole('article');
    expect(within(post).getByText('Summary')).toBeTruthy(); // the eyebrow
    expect(within(post).getByTestId('wisp-thread-summary').textContent).toBe('All quiet.');
  });

  it('no summary passes no leading post', async () => {
    h.fetchWithAuth.mockResolvedValue(res(200, payload({ thread: { summary: '' } })));
    render(<WispThreadPage threadId="t1" />);
    await screen.findByTestId('wisp-home-thread');
    expect(lastThread().leading).toBeNull();
    expect(screen.queryByTestId('wisp-thread-summary')).toBeNull();
  });

  it('404 renders the existence-neutral not-found state and no panels', async () => {
    h.fetchWithAuth.mockResolvedValue(res(404, { code: 'thread_not_found' }));
    render(<WispThreadPage threadId="t1" />);
    expect(await screen.findByTestId('wisp-thread-not-found')).toBeTruthy();
    expect(screen.queryByTestId('wisp-rail')).toBeNull();
    expect(screen.queryByTestId('wisp-home-thread')).toBeNull();
  });

  it('a failed load offers a retry that reloads', async () => {
    h.fetchWithAuth.mockResolvedValueOnce(res(500, {}));
    render(<WispThreadPage threadId="t1" />);
    fireEvent.click(await screen.findByTestId('wisp-thread-retry'));
    await screen.findByTestId('wisp-rail');
    expect(h.fetchWithAuth).toHaveBeenCalledTimes(2);
  });

  it('rail patches update the page; the chat store only when it holds this thread', async () => {
    const { rerender } = render(<WispThreadPage threadId="t1" />);
    await screen.findByTestId('wisp-rail');
    act(() => (lastRail().onWispChange as (p: unknown) => void)({ status: 'paused', pausedReason: 'user_paused' }));
    expect(screen.getByTestId('wisp-rail').getAttribute('data-status')).toBe('paused');
    expect(lastThread().wisp).toMatchObject({ status: 'paused' });
    expect(lastThread().lastSessionId).toBe('s-last'); // a patch keeps what the patch does not carry
    expect(h.updateWisp).not.toHaveBeenCalled();

    h.storeWisp = { threadId: 't1' }; // the chat panel entered Wisp mode on this thread
    rerender(<WispThreadPage threadId="t1" />);
    act(() => (lastRail().onWispChange as (p: unknown) => void)({ status: 'active', pausedReason: null }));
    expect(h.updateWisp).toHaveBeenCalledWith({ status: 'active', pausedReason: null });
  });

  it('a revoke reloads the thread and leaves chat Wisp mode when the chat is on this thread', async () => {
    h.storeWisp = { threadId: 't1' };
    render(<WispThreadPage threadId="t1" />);
    await screen.findByTestId('wisp-rail');
    await act(async () => { await (lastRail().onRevoked as () => Promise<void>)(); });
    expect(h.exitWispMode).toHaveBeenCalledTimes(1);
    expect(h.fetchWithAuth).toHaveBeenCalledTimes(2);
  });

  it('T14: polls every 30 s while visible, passes the live line, and refreshes activity when it changes', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    render(<WispThreadPage threadId="t1" />);
    await screen.findByTestId('wisp-rail');
    const before = lastRail().activityKey;

    const live = { orgId: 'org-a', orgName: 'Greenwood', startedAt: '2026-10-24T17:59:00.000Z' };
    h.fetchActivity.mockResolvedValue({ items: [], nextCursor: null, current: live });
    await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
    await waitFor(() => expect(lastRail().current).toEqual(live));
    expect(h.fetchActivity).toHaveBeenLastCalledWith('t1', null, 1);
    expect(lastRail().activityKey).not.toBe(before);

    // A failed live-line read drops the line (never a stale "Checking …") and keeps the page.
    h.fetchActivity.mockRejectedValue(new Error('activity down'));
    await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
    expect(lastRail().current).toBeNull();
    expect(screen.getByTestId('wisp-rail')).toBeTruthy();

    const calls = h.fetchWithAuth.mock.calls.length;
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
    await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
    expect(h.fetchWithAuth.mock.calls.length).toBe(calls);
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' });
    await act(async () => { document.dispatchEvent(new Event('visibilitychange')); });
    await waitFor(() => expect(h.fetchWithAuth.mock.calls.length).toBe(calls + 1));
  });

  it('a poll carries the thread’s newest lastSessionId to the column', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    render(<WispThreadPage threadId="t1" />);
    await screen.findByTestId('wisp-rail');
    expect(lastThread().lastSessionId).toBe('s-last');
    h.fetchWithAuth.mockResolvedValue(res(200, payload({ thread: { lastSessionId: 's-newer' } })));
    await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
    await waitFor(() => expect(lastThread().lastSessionId).toBe('s-newer'));
  });

  it('a poll keeps a known pause reason the thread payload does not carry, and a failed poll keeps the page', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    h.fetchWithAuth.mockResolvedValue(res(200, payload({ grant: { status: 'paused' } })));
    render(<WispThreadPage threadId="t1" />);
    await screen.findByTestId('wisp-rail');
    act(() => (lastRail().onWispChange as (p: unknown) => void)({ pausedReason: 'user_paused' }));
    await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
    expect((lastRail().wisp as { pausedReason?: string }).pausedReason).toBe('user_paused');

    h.fetchWithAuth.mockResolvedValue(res(500, {}));
    await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
    expect(screen.getByTestId('wisp-rail')).toBeTruthy();
    expect(screen.queryByTestId('wisp-thread-load-error')).toBeNull();
    // One failed poll is noise; a second in a row says the page is stale, with a retry.
    expect(screen.queryByTestId('wisp-thread-stale')).toBeNull();
    await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
    expect(within(screen.getByTestId('wisp-thread-page')).getByTestId('wisp-thread-stale')).toBeTruthy();
    expect(lastThread().lastSessionId).toBe('s-last'); // stale keeps the last good view whole
    h.fetchWithAuth.mockResolvedValue(res(200, payload({ grant: { status: 'paused' } })));
    fireEvent.click(screen.getByTestId('wisp-thread-stale-retry'));
    await waitFor(() => expect(screen.queryByTestId('wisp-thread-stale')).toBeNull());
    expect(screen.getByTestId('wisp-rail')).toBeTruthy();
  });

  it('passes the payload’s wideningAvailable through to the rail', async () => {
    h.fetchWithAuth.mockResolvedValue(res(200, { ...payload(), data: { ...payload().data, wideningAvailable: true } }));
    render(<WispThreadPage threadId="t1" />);
    await screen.findByTestId('wisp-rail');
    expect((lastRail().wisp as { wideningAvailable?: boolean }).wideningAvailable).toBe(true);
  });

  it('a rail patch outranks a poll that was already in flight', async () => {
    render(<WispThreadPage threadId="t1" />);
    await screen.findByTestId('wisp-rail');
    let release!: (r: Response) => void;
    h.fetchWithAuth.mockImplementationOnce(() => new Promise<Response>((r) => { release = r; }));
    act(() => { document.dispatchEvent(new Event('visibilitychange')); }); // starts a silent poll
    act(() => (lastRail().onWispChange as (p: unknown) => void)({ status: 'paused', pausedReason: 'user_paused' }));
    await act(async () => { release(res(200, payload())); });
    expect(screen.getByTestId('wisp-rail').getAttribute('data-status')).toBe('paused');
  });
});
