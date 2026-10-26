// @vitest-environment jsdom
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { PromptCardWindow, type PromptCardApi } from './PromptCardWindow';
import type { PromptView } from './types';

const view: PromptView = {
  promptId: 'notice:safe_mode:7f3c2a10',
  kind: 'notice.info',
  kindVersion: 1,
  state: 'pending',
  presentation: 'card',
  copy: { title: 'Your computer restarted in safe mode', body: 'It restarts normally when the repair is done.' },
  facts: [],
  actions: [{ id: 'ok', label: 'OK', role: 'safe' }],
  defaultActionId: 'ok',
  decision: true,
  safeActionId: 'ok',
  countdownDeadlineUnixMs: null,
  expiryText: null,
  locale: 'en',
  direction: 'ltr',
  pendingActionId: null,
  lastOutcome: null,
  closed: false,
  card: true,
  lastError: null,
  version: 3,
};

function fakeApi(overrides: Partial<PromptCardApi> = {}) {
  let push: ((v: PromptView) => void) | null = null;
  const api: PromptCardApi = {
    getView: vi.fn(async () => view),
    action: vi.fn(async () => {}),
    hide: vi.fn(async () => {}),
    subscribe: vi.fn(async (_id: string, onView: (v: PromptView) => void) => {
      push = onView;
      return () => {
        push = null;
      };
    }),
    ...overrides,
  };
  return { api, push: (v: PromptView) => push?.(v) };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('PromptCardWindow', () => {
  it('pulls its view and sends the chosen action for its own prompt', async () => {
    const { api } = fakeApi();
    render(<PromptCardWindow promptId={view.promptId} api={api} retryDelayMs={0} />);
    const ok = await screen.findByRole('button', { name: 'OK' });
    expect(api.getView).toHaveBeenCalledWith(view.promptId);
    fireEvent.click(ok, { detail: 1 });
    expect(api.action).toHaveBeenCalledWith(view.promptId, 'ok', 'click');
  });

  it('applies updates pushed for this prompt', async () => {
    const { api, push } = fakeApi();
    render(<PromptCardWindow promptId={view.promptId} api={api} retryDelayMs={0} />);
    await screen.findByText('Your computer restarted in safe mode');
    await waitFor(() => expect(api.subscribe).toHaveBeenCalled());
    act(() => push({ ...view, version: 4, copy: { title: 'Repair finished' } }));
    expect(screen.getByText('Repair finished')).toBeInTheDocument();
  });

  it('subscribes before it fetches, and a fetched snapshot never overwrites a newer update', async () => {
    let resolveView: (v: PromptView) => void = () => {};
    const { api, push } = fakeApi({
      getView: vi.fn(() => new Promise<PromptView>((r) => (resolveView = r))),
    });
    render(<PromptCardWindow promptId={view.promptId} api={api} retryDelayMs={0} />);
    await waitFor(() => expect(api.getView).toHaveBeenCalled());
    const subscribeOrder = vi.mocked(api.subscribe).mock.invocationCallOrder[0]!;
    const fetchOrder = vi.mocked(api.getView).mock.invocationCallOrder[0]!;
    expect(subscribeOrder).toBeLessThan(fetchOrder);
    // The action's result lands while the fetch is in flight...
    act(() => push({ ...view, version: 5, pendingActionId: null, copy: { title: 'Newer' } }));
    // ...and the older snapshot (still "Working…") arrives afterwards.
    await act(async () => resolveView({ ...view, version: 4, pendingActionId: 'ok' }));
    expect(screen.getByText('Newer')).toBeInTheDocument();
    expect(screen.queryByText('Working…')).toBeNull();
    expect(screen.getByRole('button', { name: 'OK' })).toBeEnabled();
  });

  it('shows why an action could not be sent, and keeps the card', async () => {
    const { api } = fakeApi({
      action: vi.fn(async () => {
        throw "Not connected to your IT provider's agent. Try again in a moment.";
      }),
    });
    render(<PromptCardWindow promptId={view.promptId} api={api} retryDelayMs={0} />);
    fireEvent.click(await screen.findByRole('button', { name: 'OK' }), { detail: 1 });
    expect(await screen.findByRole('alert')).toHaveTextContent('Not connected');
    expect(api.hide).not.toHaveBeenCalled();
  });

  it('shows the error Rust recorded for a refused close box', async () => {
    const { api } = fakeApi({ getView: vi.fn(async () => ({ ...view, lastError: 'Your earlier choice is still being sent.' })) });
    render(<PromptCardWindow promptId={view.promptId} api={api} retryDelayMs={0} />);
    expect(await screen.findByRole('alert')).toHaveTextContent('Your earlier choice is still being sent.');
  });

  it('Esc on a non-decision hides the card through Rust, as a keyboard action', async () => {
    const { api } = fakeApi({
      getView: vi.fn(async () => ({ ...view, state: 'approved' as const, decision: false, safeActionId: null })),
    });
    render(<PromptCardWindow promptId={view.promptId} api={api} retryDelayMs={0} />);
    await screen.findByRole('button', { name: 'OK' });
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(api.hide).toHaveBeenCalledWith(view.promptId, 'keyboard');
  });

  it('retries a failed fetch once before giving up', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const getView = vi.fn().mockRejectedValueOnce('busy').mockResolvedValueOnce(view);
    const { api } = fakeApi({ getView });
    render(<PromptCardWindow promptId={view.promptId} api={api} retryDelayMs={0} />);
    expect(await screen.findByRole('button', { name: 'OK' })).toBeInTheDocument();
    expect(getView).toHaveBeenCalledTimes(2);
    expect(api.hide).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalled();
  });

  it('closes its empty frame when the prompt is gone before it painted', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { api } = fakeApi({ getView: vi.fn(async () => Promise.reject('prompt unavailable')) });
    render(<PromptCardWindow promptId={view.promptId} api={api} retryDelayMs={0} />);
    await waitFor(() => expect(api.hide).toHaveBeenCalledWith(view.promptId, 'click'));
    expect(api.getView).toHaveBeenCalledTimes(2);
    expect(screen.queryAllByRole('button')).toHaveLength(0);
    expect(warn).toHaveBeenCalled();
  });

  it('warns and says so when live updates cannot be subscribed, then re-pulls once', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { api } = fakeApi({ subscribe: vi.fn(async () => Promise.reject('no listener')) });
    render(<PromptCardWindow promptId={view.promptId} api={api} retryDelayMs={0} />);
    expect(await screen.findByRole('alert')).toHaveTextContent('may be out of date');
    await waitFor(() => expect(api.getView).toHaveBeenCalledTimes(2));
    expect(warn).toHaveBeenCalled();
  });
});
