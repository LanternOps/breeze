// @vitest-environment jsdom
import { act, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { MessageView } from '../components/MessageCard';
import { NotificationsTab, useNotificationList, type NotificationListApi } from './NotificationsTab';
import type { NotificationListView, PromptView, VersionNotice } from './types';

const NOW = new Date(2026, 9, 26, 14, 30, 0).getTime();

const base: PromptView = {
  promptId: 'restart:42',
  kind: 'restart.prompt',
  kindVersion: 1,
  state: 'pending',
  presentation: 'card',
  copy: { title: 'Restart to finish installing updates', consequence: 'Time left: {remaining}.' },
  facts: [],
  actions: [
    { id: 'restart_now', label: 'Restart now', role: 'proceed' },
    { id: 'postpone', label: 'Postpone', role: 'safe' },
  ],
  defaultActionId: 'postpone',
  decision: true,
  safeActionId: 'postpone',
  countdownDeadlineUnixMs: NOW + 90_000,
  expiryText: null,
  locale: 'en',
  direction: 'ltr',
  pendingActionId: null,
  lastOutcome: null,
  closed: false,
  card: false,
  lastError: null,
  version: 3,
};

const outcome: PromptView = {
  ...base,
  promptId: 'elevation:e1',
  kind: 'elevation.request',
  state: 'approved',
  copy: { title: 'Request approved' },
  actions: [],
  decision: false,
  safeActionId: null,
  countdownDeadlineUnixMs: null,
  closed: true,
};

describe('NotificationsTab', () => {
  it('lists entries in the order given, with placeholders filled and live actions', () => {
    const onAction = vi.fn(async () => {});
    render(<NotificationsTab entries={[base, outcome]} onAction={onAction} clock={() => NOW} />);
    const items = screen.getAllByRole('listitem');
    expect(items).toHaveLength(2);
    expect(items[0]).toHaveTextContent('Restart to finish installing updates');
    expect(items[0]).toHaveTextContent('Time left: 1:30.');
    expect(items[1]).toHaveTextContent('Request approved');
    // Safe action first; a closed entry offers no action.
    const buttons = screen.getAllByRole('button');
    expect(buttons.map((b) => b.textContent)).toEqual(['Postpone', 'Restart now']);
    fireEvent.click(buttons[1]!);
    expect(onAction).toHaveBeenCalledWith('restart:42', 'restart_now');
  });

  it('shows a working state while an action is in flight', () => {
    render(<NotificationsTab entries={[{ ...base, pendingActionId: 'postpone' }]} onAction={vi.fn()} clock={() => NOW} />);
    expect(screen.getByText('Working…')).toBeInTheDocument();
    for (const b of screen.getAllByRole('button')) expect(b).toBeDisabled();
  });

  it('says so when the list is empty', () => {
    render(<NotificationsTab entries={[]} onAction={vi.fn()} clock={() => NOW} />);
    expect(screen.getByText('No notifications')).toBeInTheDocument();
  });

  it('renders its chrome in the synced locale and each entry in its own', () => {
    const { rerender } = render(<NotificationsTab entries={[]} onAction={vi.fn()} clock={() => NOW} locale="de-DE" />);
    expect(screen.getByText('Benachrichtigungen')).toBeInTheDocument();
    expect(screen.getByText('Keine Benachrichtigungen')).toBeInTheDocument();
    rerender(
      <NotificationsTab
        entries={[{ ...base, locale: 'de-DE', pendingActionId: 'postpone' }]}
        onAction={vi.fn()}
        clock={() => NOW}
      />,
    );
    expect(screen.getByText('Notifications')).toBeInTheDocument();
    expect(screen.getByText('Wird bearbeitet…')).toBeInTheDocument();
  });

  it('shows the error Rust recorded for an entry', () => {
    render(<NotificationsTab entries={[{ ...base, lastError: 'That choice is not available.' }]} onAction={vi.fn()} clock={() => NOW} />);
    expect(screen.getByRole('listitem')).toHaveTextContent('That choice is not available.');
  });

  it('lists a message card as text, with its sender slot, and offers it no action', () => {
    const hostile: MessageView = {
      ...message,
      title: 'Hello **there**',
      body: '[click](https://example.invalid) <img src=x onerror=alert(1)>',
    };
    const { container } = render(<NotificationsTab entries={[]} messages={[hostile]} onAction={vi.fn()} clock={() => NOW} />);
    const item = screen.getByRole('listitem');
    expect(item).toHaveAttribute('data-kind', 'message');
    expect(item).toHaveTextContent('From Example IT');
    expect(item).toHaveTextContent('Hello **there**');
    expect(item).toHaveTextContent('[click](https://example.invalid) <img src=x onerror=alert(1)>');
    // Plain text in the main window: no markup, no link, no image, no button.
    expect(container.querySelector('a, img, strong')).toBeNull();
    expect(screen.queryAllByRole('button')).toHaveLength(0);
    expect(screen.queryByText('No notifications')).toBeNull();
  });
});

const message: MessageView = {
  messageId: '11111111-1111-4111-8111-111111111111',
  title: 'Maintenance tonight',
  body: 'Please save your work before 18:00.',
  severity: 'info',
  requiresAck: false,
  expiresAt: '2030-01-01T00:00:00Z',
  branding: { companyName: 'Example IT', displayName: 'Example', accent: null },
  plain: false,
};

describe('useNotificationList', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  const listOf = (version: number, prompts: PromptView[], messages: MessageView[] = []): NotificationListView => ({
    version,
    prompts,
    messages,
  });

  /** A Rust stand-in: `getList` answers from `current`, `notify` fires a version notice. */
  function fakeApi(overrides: Partial<NotificationListApi> = {}) {
    let notify: ((n: VersionNotice) => void) | null = null;
    const state = { current: listOf(3, [base]) };
    const api: NotificationListApi = {
      getList: vi.fn(async () => state.current),
      action: vi.fn(async () => {}),
      subscribe: vi.fn(async (onNotice: (n: VersionNotice) => void) => {
        notify = onNotice;
        return () => {
          notify = null;
        };
      }),
      ...overrides,
    };
    return { api, state, notify: (version: number) => notify?.({ version }) };
  }

  it('NotificationsTab lists message and prompt entries for this session only', async () => {
    const { api, state, notify } = fakeApi();
    state.current = listOf(4, [base], [message]);
    function Harness() {
      const list = useNotificationList(api, true, 0);
      return <NotificationsTab entries={list.entries} messages={list.messages} onAction={list.act} error={list.error} clock={() => NOW} />;
    }
    render(<Harness />);
    await waitFor(() => expect(screen.getAllByRole('listitem')).toHaveLength(2));
    expect(screen.getByText('Restart to finish installing updates')).toBeInTheDocument();
    expect(screen.getByText('Maintenance tonight')).toBeInTheDocument();
    // The agent session ends: Rust forgets both kinds and notifies; the tab
    // pulls the empty list and keeps nothing from the old session.
    state.current = listOf(9, [], []);
    await act(async () => notify(9));
    await waitFor(() => expect(screen.queryAllByRole('listitem')).toHaveLength(0));
    expect(screen.getByText('No notifications')).toBeInTheDocument();
    // The next session's replay is a fresh list, not a merge with the old one.
    state.current = listOf(12, [], [{ ...message, messageId: 'next-session', title: 'Replayed' }]);
    await act(async () => notify(12));
    await waitFor(() => expect(screen.getAllByRole('listitem')).toHaveLength(1));
    expect(screen.getByText('Replayed')).toBeInTheDocument();
    expect(screen.queryByText('Maintenance tonight')).toBeNull();
  });

  it('a notice carries no entries: every notice is answered by a pull', async () => {
    const { api, state, notify } = fakeApi();
    const { result } = renderHook(() => useNotificationList(api, true, 0));
    await waitFor(() => expect(result.current.entries).toHaveLength(1));
    expect(api.getList).toHaveBeenCalledTimes(1);
    state.current = listOf(4, []);
    await act(async () => notify(4));
    await waitFor(() => expect(result.current.entries).toHaveLength(0));
    expect(api.getList).toHaveBeenCalledTimes(2);
    // A notice no newer than the list held is not pulled again.
    await act(async () => notify(4));
    expect(api.getList).toHaveBeenCalledTimes(2);
    await act(() => result.current.act('restart:42', 'postpone'));
    expect(api.action).toHaveBeenCalledWith('restart:42', 'postpone');
  });

  it('a pull after a notice that fails is retried once, then the tab says it may be out of date', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { api, state, notify } = fakeApi();
    const { result } = renderHook(() => useNotificationList(api, true, 0));
    await waitFor(() => expect(result.current.entries).toHaveLength(1));
    await waitFor(() => expect(api.subscribe).toHaveBeenCalled());
    // The session ends, but the pull that should empty the list fails twice.
    vi.mocked(api.getList).mockRejectedValueOnce('busy').mockRejectedValueOnce('busy');
    await act(async () => notify(9));
    await waitFor(() => expect(result.current.error).toMatch(/may be out of date/));
    expect(api.getList).toHaveBeenCalledTimes(3);
    // A later notice that pulls fine replaces the list and clears the error.
    state.current = listOf(10, []);
    await act(async () => notify(10));
    await waitFor(() => expect(result.current.entries).toHaveLength(0));
    expect(result.current.error).toBeNull();
    expect(warn).toHaveBeenCalled();
  });

  it('a pull after a notice that fails once is retried and applied without an error', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { api, state, notify } = fakeApi();
    const { result } = renderHook(() => useNotificationList(api, true, 0));
    await waitFor(() => expect(result.current.entries).toHaveLength(1));
    await waitFor(() => expect(api.subscribe).toHaveBeenCalled());
    state.current = listOf(9, []);
    vi.mocked(api.getList).mockRejectedValueOnce('busy');
    await act(async () => notify(9));
    await waitFor(() => expect(result.current.entries).toHaveLength(0));
    expect(result.current.error).toBeNull();
    expect(warn).toHaveBeenCalled();
  });

  it('subscribes before it fetches, and keeps the newer list', async () => {
    let resolveFirst: (l: NotificationListView) => void = () => {};
    const getList = vi
      .fn()
      .mockImplementationOnce(() => new Promise<NotificationListView>((r) => (resolveFirst = r)))
      .mockResolvedValueOnce(listOf(5, []));
    const { api, notify } = fakeApi({ getList });
    const { result } = renderHook(() => useNotificationList(api, true, 0));
    await waitFor(() => expect(api.getList).toHaveBeenCalled());
    expect(vi.mocked(api.subscribe).mock.invocationCallOrder[0]!).toBeLessThan(getList.mock.invocationCallOrder[0]!);
    // A notice lands while the first fetch is in flight; its pull is newer.
    await act(async () => notify(5));
    await act(async () => resolveFirst(listOf(4, [base])));
    expect(result.current.entries).toHaveLength(0);
  });

  it('retries a failed fetch once, then says so', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { api } = fakeApi({ getList: vi.fn(async () => Promise.reject('down')) });
    const { result } = renderHook(() => useNotificationList(api, true, 0));
    await waitFor(() => expect(result.current.error).toMatch(/could not be loaded/));
    expect(api.getList).toHaveBeenCalledTimes(2);
    expect(warn).toHaveBeenCalled();
  });

  it('warns and says so when updates cannot be subscribed, then re-pulls once', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { api } = fakeApi({ subscribe: vi.fn(async () => Promise.reject('no listener')) });
    const { result } = renderHook(() => useNotificationList(api, true, 0));
    await waitFor(() => expect(result.current.error).toMatch(/may be out of date/));
    await waitFor(() => expect(api.getList).toHaveBeenCalledTimes(2));
    expect(result.current.entries).toHaveLength(1);
    expect(warn).toHaveBeenCalled();
  });

  it('stays empty and calls nothing outside Tauri', () => {
    const { api } = fakeApi();
    const { result } = renderHook(() => useNotificationList(api, false, 0));
    expect(result.current.entries).toEqual([]);
    expect(result.current.messages).toEqual([]);
    expect(api.getList).not.toHaveBeenCalled();
    expect(api.subscribe).not.toHaveBeenCalled();
  });
});

