// @vitest-environment jsdom
import { act, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { NotificationsTab, usePromptList, type PromptListApi } from './NotificationsTab';
import type { PromptView } from './types';

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
});

describe('usePromptList', () => {
  function fakeApi() {
    let push: ((l: PromptView[]) => void) | null = null;
    const api: PromptListApi = {
      getList: vi.fn(async () => [base]),
      action: vi.fn(async () => {}),
      subscribe: vi.fn(async (onList: (l: PromptView[]) => void) => {
        push = onList;
        return () => {
          push = null;
        };
      }),
    };
    return { api, push: (l: PromptView[]) => push?.(l) };
  }

  it('loads the list and follows updates from Rust', async () => {
    const { api, push } = fakeApi();
    const { result } = renderHook(() => usePromptList(api, true));
    await waitFor(() => expect(result.current.entries).toHaveLength(1));
    await waitFor(() => expect(api.subscribe).toHaveBeenCalled());
    act(() => push([]));
    expect(result.current.entries).toHaveLength(0);
    await act(() => result.current.act('restart:42', 'postpone'));
    expect(api.action).toHaveBeenCalledWith('restart:42', 'postpone');
  });

  it('stays empty and calls nothing outside Tauri', () => {
    const { api } = fakeApi();
    const { result } = renderHook(() => usePromptList(api, false));
    expect(result.current.entries).toEqual([]);
    expect(api.getList).not.toHaveBeenCalled();
    expect(api.subscribe).not.toHaveBeenCalled();
  });
});
