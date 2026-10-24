import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  fetchWithAuth: vi.fn(),
  fetchActivity: vi.fn(),
  enterWispMode: vi.fn(),
  open: vi.fn(),
  updateWisp: vi.fn(),
  exitWispMode: vi.fn(),
  storeWisp: null as null | { threadId: string },
  headerProps: [] as Array<Record<string, unknown>>,
  concernProps: null as null | Record<string, unknown>,
  activityProps: [] as Array<Record<string, unknown>>,
}));
vi.mock('@/stores/auth', () => ({ fetchWithAuth: h.fetchWithAuth }));
vi.mock('@/stores/aiStore', () => ({
  useAiStore: (sel: (s: unknown) => unknown) =>
    sel({ wisp: h.storeWisp, enterWispMode: h.enterWispMode, open: h.open, updateWisp: h.updateWisp, exitWispMode: h.exitWispMode }),
}));
vi.mock('@/stores/orgStore', () => ({
  useOrgStore: (sel: (s: unknown) => unknown) => sel({ organizations: [{ id: 'org-a', name: 'Greenwood' }] }),
}));
vi.mock('../ai/WispThreadHeader', () => ({
  default: (props: Record<string, unknown>) => {
    h.headerProps.push(props);
    const wisp = props.wisp as { status: string };
    return <div data-testid="header-mock" data-status={wisp.status} />;
  },
}));
vi.mock('../ai/WispConcernsPanel', () => ({
  WispConcernsPanel: (props: Record<string, unknown>) => {
    h.concernProps = props;
    return <div data-testid="concerns-mock" />;
  },
}));
vi.mock('./wispActivity', () => ({ fetchWispActivity: (...a: unknown[]) => h.fetchActivity(...a) }));
vi.mock('./WispActivityPanel', () => ({
  default: (props: Record<string, unknown>) => {
    h.activityProps.push(props);
    return <div data-testid="activity-mock" />;
  },
}));

import WispThreadPage from './WispThreadPage';

const payload = (o: { grant?: Record<string, unknown> } = {}) => ({
  data: {
    thread: { id: 't1', grantId: 'g1', summary: 'All quiet.', focusOrgId: null },
    focusOrgName: null,
    grant: {
      id: 'g1', status: 'active', orgId: 'org-a', expiresAt: '2027-01-17T00:00:00.000Z', currentRevisionId: 'r1',
      budgetCentsPerDay: 200, floorTickMinutes: 30, spentTodayCents: 42, budgetResetsAt: '2026-10-25T00:00:00.000Z',
      ...o.grant,
    },
  },
});
const res = (status: number, body: unknown) => ({ ok: status < 400, status, json: async () => body }) as unknown as Response;
const lastHeader = () => h.headerProps[h.headerProps.length - 1]!;

beforeEach(() => {
  vi.clearAllMocks();
  h.headerProps = [];
  h.activityProps = [];
  h.concernProps = null;
  h.storeWisp = null;
  h.enterWispMode.mockResolvedValue(undefined);
  h.fetchActivity.mockResolvedValue({ items: [], nextCursor: null, current: null });
  h.fetchWithAuth.mockResolvedValue(res(200, payload()));
});
afterEach(() => {
  vi.useRealTimers();
});

describe('WispThreadPage (W06 T7)', () => {
  it('loads the thread by id and composes header, concerns and activity for its grant', async () => {
    render(<WispThreadPage threadId="t1" />);
    await screen.findByTestId('header-mock');
    expect(h.fetchWithAuth).toHaveBeenCalledWith('/wisp/thread/t1');
    expect(lastHeader()).toMatchObject({
      orgName: 'Greenwood',
      wideningAvailable: false, // the payload's own value (false here)
      showFocus: false,
      currentActivity: null,
      wisp: expect.objectContaining({ grantId: 'g1', threadId: 't1', scopeOrgId: 'org-a', status: 'active', summary: 'All quiet.', spentTodayCents: 42 }),
    });
    expect(h.concernProps).toMatchObject({ grantId: 'g1', threadId: 't1' });
    expect(h.activityProps[0]).toMatchObject({ threadId: 't1' });
    expect(screen.getByTestId('wisp-thread-summary').textContent).toBe('All quiet.');
  });

  it('404 renders the existence-neutral not-found state and no panels', async () => {
    h.fetchWithAuth.mockResolvedValue(res(404, { code: 'thread_not_found' }));
    render(<WispThreadPage threadId="t1" />);
    expect(await screen.findByTestId('wisp-thread-not-found')).toBeTruthy();
    expect(screen.queryByTestId('header-mock')).toBeNull();
    expect(screen.queryByTestId('concerns-mock')).toBeNull();
  });

  it('a failed load offers a retry that reloads', async () => {
    h.fetchWithAuth.mockResolvedValueOnce(res(500, {}));
    render(<WispThreadPage threadId="t1" />);
    fireEvent.click(await screen.findByTestId('wisp-thread-retry'));
    await screen.findByTestId('header-mock');
    expect(h.fetchWithAuth).toHaveBeenCalledTimes(2);
  });

  it('Open in chat enters Wisp mode with the thread’s grant, then opens the panel', async () => {
    render(<WispThreadPage threadId="t1" />);
    fireEvent.click(await screen.findByTestId('wisp-thread-open-chat'));
    await waitFor(() => expect(h.open).toHaveBeenCalledTimes(1));
    expect(h.enterWispMode).toHaveBeenCalledWith(expect.objectContaining({ grantId: 'g1', threadId: 't1', scopeOrgId: 'org-a' }));
    expect(h.enterWispMode.mock.invocationCallOrder[0]!).toBeLessThan(h.open.mock.invocationCallOrder[0]!);
  });

  it('Open in chat is disabled unless the grant is active', async () => {
    h.fetchWithAuth.mockResolvedValue(res(200, payload({ grant: { status: 'paused' } })));
    render(<WispThreadPage threadId="t1" />);
    expect(((await screen.findByTestId('wisp-thread-open-chat')) as HTMLButtonElement).disabled).toBe(true);
  });

  it('header patches update the page; the chat store only when it holds this thread', async () => {
    const { rerender } = render(<WispThreadPage threadId="t1" />);
    await screen.findByTestId('header-mock');
    act(() => (lastHeader().onWispChange as (p: unknown) => void)({ status: 'paused', pausedReason: 'user_paused' }));
    expect(screen.getByTestId('header-mock').getAttribute('data-status')).toBe('paused');
    expect(h.updateWisp).not.toHaveBeenCalled();

    h.storeWisp = { threadId: 't1' }; // the chat panel entered Wisp mode on this thread
    rerender(<WispThreadPage threadId="t1" />);
    act(() => (lastHeader().onWispChange as (p: unknown) => void)({ status: 'active', pausedReason: null }));
    expect(h.updateWisp).toHaveBeenCalledWith({ status: 'active', pausedReason: null });
  });

  it('a revoke reloads the thread and leaves chat Wisp mode when the chat is on this thread', async () => {
    h.storeWisp = { threadId: 't1' };
    render(<WispThreadPage threadId="t1" />);
    await screen.findByTestId('header-mock');
    await act(async () => { await (lastHeader().onRevoked as () => Promise<void>)(); });
    expect(h.exitWispMode).toHaveBeenCalledTimes(1);
    expect(h.fetchWithAuth).toHaveBeenCalledTimes(2);
  });

  it('T14: polls every 30 s while visible, passes the live line, and refreshes activity when it changes', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    render(<WispThreadPage threadId="t1" />);
    await screen.findByTestId('header-mock');
    const activityKeys = () => h.activityProps.map((p) => p.refreshKey);
    const before = activityKeys().at(-1);

    const live = { orgId: 'org-a', orgName: 'Greenwood', startedAt: '2026-10-24T17:59:00.000Z' };
    h.fetchActivity.mockResolvedValue({ items: [], nextCursor: null, current: live });
    await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
    await waitFor(() => expect(lastHeader().currentActivity).toEqual(live));
    expect(h.fetchActivity).toHaveBeenLastCalledWith('t1', null, 1);
    expect(activityKeys().at(-1)).not.toBe(before);

    // A failed live-line read drops the line (never a stale "Checking …") and keeps the page.
    h.fetchActivity.mockRejectedValue(new Error('activity down'));
    await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
    expect(lastHeader().currentActivity).toBeNull();
    expect(screen.getByTestId('header-mock')).toBeTruthy();

    const calls = h.fetchWithAuth.mock.calls.length;
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
    await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
    expect(h.fetchWithAuth.mock.calls.length).toBe(calls);
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' });
    await act(async () => { document.dispatchEvent(new Event('visibilitychange')); });
    await waitFor(() => expect(h.fetchWithAuth.mock.calls.length).toBe(calls + 1));
  });

  it('a poll keeps a known pause reason the thread payload does not carry, and a failed poll keeps the page', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    h.fetchWithAuth.mockResolvedValue(res(200, payload({ grant: { status: 'paused' } })));
    render(<WispThreadPage threadId="t1" />);
    await screen.findByTestId('header-mock');
    act(() => (lastHeader().onWispChange as (p: unknown) => void)({ pausedReason: 'user_paused' }));
    await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
    expect((lastHeader().wisp as { pausedReason?: string }).pausedReason).toBe('user_paused');

    h.fetchWithAuth.mockResolvedValue(res(500, {}));
    await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
    expect(screen.getByTestId('header-mock')).toBeTruthy();
    expect(screen.queryByTestId('wisp-thread-load-error')).toBeNull();
    // One failed poll is noise; a second in a row says the page is stale, with a retry.
    expect(screen.queryByTestId('wisp-thread-stale')).toBeNull();
    await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
    expect(screen.getByTestId('wisp-thread-stale')).toBeTruthy();
    h.fetchWithAuth.mockResolvedValue(res(200, payload({ grant: { status: 'paused' } })));
    fireEvent.click(screen.getByTestId('wisp-thread-stale-retry'));
    await waitFor(() => expect(screen.queryByTestId('wisp-thread-stale')).toBeNull());
    expect(screen.getByTestId('header-mock')).toBeTruthy();
  });

  it('passes the payload’s wideningAvailable through to the header', async () => {
    h.fetchWithAuth.mockResolvedValue(res(200, { ...payload(), data: { ...payload().data, wideningAvailable: true } }));
    render(<WispThreadPage threadId="t1" />);
    await screen.findByTestId('header-mock');
    expect(lastHeader().wideningAvailable).toBe(true);
  });

  it('a header patch outranks a poll that was already in flight', async () => {
    render(<WispThreadPage threadId="t1" />);
    await screen.findByTestId('header-mock');
    let release!: (r: Response) => void;
    h.fetchWithAuth.mockImplementationOnce(() => new Promise<Response>((r) => { release = r; }));
    act(() => { document.dispatchEvent(new Event('visibilitychange')); }); // starts a silent poll
    act(() => (lastHeader().onWispChange as (p: unknown) => void)({ status: 'paused', pausedReason: 'user_paused' }));
    await act(async () => { release(res(200, payload())); });
    expect(screen.getByTestId('header-mock').getAttribute('data-status')).toBe('paused');
  });
});
