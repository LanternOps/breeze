// @vitest-environment jsdom
import { act, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { NotificationsTab, usePromptList, type PromptListApi } from './NotificationsTab';
import type { PromptListView, PromptView } from './types';

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
});

describe('usePromptList', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  function fakeApi(overrides: Partial<PromptListApi> = {}) {
    let push: ((l: PromptListView) => void) | null = null;
    const api: PromptListApi = {
      getList: vi.fn(async () => ({ version: 3, entries: [base] })),
      action: vi.fn(async () => {}),
      subscribe: vi.fn(async (onList: (l: PromptListView) => void) => {
        push = onList;
        return () => {
          push = null;
        };
      }),
      ...overrides,
    };
    return { api, push: (l: PromptListView) => push?.(l) };
  }

  it('loads the list and follows updates from Rust', async () => {
    const { api, push } = fakeApi();
    const { result } = renderHook(() => usePromptList(api, true, 0));
    await waitFor(() => expect(result.current.entries).toHaveLength(1));
    await waitFor(() => expect(api.subscribe).toHaveBeenCalled());
    act(() => push({ version: 4, entries: [] }));
    expect(result.current.entries).toHaveLength(0);
    await act(() => result.current.act('restart:42', 'postpone'));
    expect(api.action).toHaveBeenCalledWith('restart:42', 'postpone');
  });

  it('subscribes before it fetches, and keeps the newer list', async () => {
    let resolveList: (l: PromptListView) => void = () => {};
    const { api, push } = fakeApi({ getList: vi.fn(() => new Promise<PromptListView>((r) => (resolveList = r))) });
    const { result } = renderHook(() => usePromptList(api, true, 0));
    await waitFor(() => expect(api.getList).toHaveBeenCalled());
    expect(vi.mocked(api.subscribe).mock.invocationCallOrder[0]!).toBeLessThan(
      vi.mocked(api.getList).mock.invocationCallOrder[0]!,
    );
    act(() => push({ version: 5, entries: [] }));
    await act(async () => resolveList({ version: 4, entries: [base] }));
    expect(result.current.entries).toHaveLength(0);
  });

  it('retries a failed fetch once, then says so', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { api } = fakeApi({ getList: vi.fn(async () => Promise.reject('down')) });
    const { result } = renderHook(() => usePromptList(api, true, 0));
    await waitFor(() => expect(result.current.error).toMatch(/could not be loaded/));
    expect(api.getList).toHaveBeenCalledTimes(2);
    expect(warn).toHaveBeenCalled();
  });

  it('warns and says so when updates cannot be subscribed, then re-pulls once', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { api } = fakeApi({ subscribe: vi.fn(async () => Promise.reject('no listener')) });
    const { result } = renderHook(() => usePromptList(api, true, 0));
    await waitFor(() => expect(result.current.error).toMatch(/may be out of date/));
    await waitFor(() => expect(api.getList).toHaveBeenCalledTimes(2));
    expect(result.current.entries).toHaveLength(1);
    expect(warn).toHaveBeenCalled();
  });

  it('stays empty and calls nothing outside Tauri', () => {
    const { api } = fakeApi();
    const { result } = renderHook(() => usePromptList(api, false, 0));
    expect(result.current.entries).toEqual([]);
    expect(api.getList).not.toHaveBeenCalled();
    expect(api.subscribe).not.toHaveBeenCalled();
  });
});

