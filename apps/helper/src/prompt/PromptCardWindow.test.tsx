// @vitest-environment jsdom
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

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

describe('PromptCardWindow', () => {
  it('pulls its view and sends the chosen action for its own prompt', async () => {
    const { api } = fakeApi();
    render(<PromptCardWindow promptId={view.promptId} api={api} />);
    const ok = await screen.findByRole('button', { name: 'OK' });
    expect(api.getView).toHaveBeenCalledWith(view.promptId);
    fireEvent.click(ok, { detail: 1 });
    expect(api.action).toHaveBeenCalledWith(view.promptId, 'ok', 'click');
  });

  it('applies updates pushed for this prompt', async () => {
    const { api, push } = fakeApi();
    render(<PromptCardWindow promptId={view.promptId} api={api} />);
    await screen.findByText('Your computer restarted in safe mode');
    await waitFor(() => expect(api.subscribe).toHaveBeenCalled());
    act(() => push({ ...view, copy: { title: 'Repair finished' } }));
    expect(screen.getByText('Repair finished')).toBeInTheDocument();
  });

  it('shows why an action could not be sent, and keeps the card', async () => {
    const { api } = fakeApi({
      action: vi.fn(async () => {
        throw "Not connected to your IT provider's agent. Try again in a moment.";
      }),
    });
    render(<PromptCardWindow promptId={view.promptId} api={api} />);
    fireEvent.click(await screen.findByRole('button', { name: 'OK' }), { detail: 1 });
    expect(await screen.findByRole('alert')).toHaveTextContent('Not connected');
    expect(api.hide).not.toHaveBeenCalled();
  });

  it('Esc on a non-decision hides the card through Rust', async () => {
    const { api } = fakeApi({ getView: vi.fn(async () => ({ ...view, state: 'approved' as const, decision: false, safeActionId: null })) });
    render(<PromptCardWindow promptId={view.promptId} api={api} />);
    await screen.findByRole('button', { name: 'OK' });
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(api.hide).toHaveBeenCalledWith(view.promptId);
  });

  it('closes its empty frame when the prompt is gone before it painted', async () => {
    const { api } = fakeApi({ getView: vi.fn(async () => Promise.reject('prompt unavailable')) });
    render(<PromptCardWindow promptId={view.promptId} api={api} />);
    await waitFor(() => expect(api.hide).toHaveBeenCalledWith(view.promptId));
    expect(screen.queryAllByRole('button')).toHaveLength(0);
  });
});
