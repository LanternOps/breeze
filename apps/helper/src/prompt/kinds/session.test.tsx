// @vitest-environment jsdom
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { PromptCardWindow, type PromptCardApi } from '../PromptCardWindow';
import type { PromptView, VersionNotice } from '../types';
import { cardForKind } from './registry';
import { SessionCard } from './session';

/*
 * `remote.session@1` (#10190 W06, contract section 3): the remote-session
 * indicator as a clickable pill. Expanding / collapsing is renderer-local (P7:
 * `details` is not a wire action). The actions are exactly what the agent
 * sent; the End-session confirmation is the agent's `prompt_update` swapping
 * the action set, never a renderer-made step.
 */

const NOW = new Date(2026, 9, 27, 10, 0, 0).getTime();
const STARTED = new Date(2026, 9, 27, 9, 46, 0).getTime();

const NORMAL_ACTIONS: PromptView['actions'] = [
  { id: 'end_session', label: 'End session', role: 'neutral' },
  { id: 'report_problem', label: 'Report a problem', role: 'neutral' },
];

/** What Rust hands the pill for a session prompt (policy allows ending it). */
const session: PromptView = {
  promptId: 'session:8d1f6c2e-0b5a-4f7e-9a3c-2e4b6d8f0a1c',
  kind: 'remote.session',
  kindVersion: 1,
  state: 'pending',
  presentation: 'indicator',
  copy: { title: 'Remote session in progress', body: 'Your IT support team is connected to this computer.' },
  facts: [
    { label: 'Technician', value: 'Alex Rivera' },
    { label: 'Access', value: 'View and control' },
    { label: 'Started', value: `{time:${STARTED}}` },
  ],
  actions: NORMAL_ACTIONS,
  defaultActionId: null,
  decision: false,
  safeActionId: null,
  countdownDeadlineUnixMs: null,
  expiryText: null,
  locale: 'en',
  direction: 'ltr',
  pendingActionId: null,
  lastOutcome: null,
  closed: false,
  card: true,
  lastError: null,
  version: 1,
};

/** The agent's confirm step: same state, the action set swapped (contract section 3). */
const confirming: PromptView = {
  ...session,
  copy: { ...session.copy, stateDetail: 'End this remote session? The technician will be disconnected.' },
  actions: [
    { id: 'end_confirm', label: 'End session', role: 'proceed' },
    { id: 'keep_session', label: 'Keep session', role: 'safe' },
  ],
  defaultActionId: 'keep_session',
  version: 2,
};

function renderPill(view: PromptView = session) {
  const onAction = vi.fn();
  const onHide = vi.fn();
  const onExpandedChange = vi.fn();
  const utils = render(
    <SessionCard view={view} nowMs={NOW} onAction={onAction} onHide={onHide} onExpandedChange={onExpandedChange} />,
  );
  const rerenderWith = (next: PromptView) =>
    utils.rerender(
      <SessionCard view={next} nowMs={NOW} onAction={onAction} onHide={onHide} onExpandedChange={onExpandedChange} />,
    );
  return { onAction, onHide, onExpandedChange, rerenderWith, ...utils };
}

const pillButton = () => screen.getByRole('button', { name: /Remote session in progress/ });

describe('remote.session pill', () => {
  it('is the card the registry picks for remote.session', () => {
    expect(cardForKind('remote.session')).toBe(SessionCard);
  });

  it('starts collapsed: the title as a clickable pill, no actions, and it never takes focus', () => {
    renderPill();
    const pill = pillButton();
    expect(pill).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByRole('button', { name: 'End session' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Report a problem' })).not.toBeInTheDocument();
    expect(screen.queryByText('Alex Rivera')).not.toBeInTheDocument();
    expect(document.activeElement).toBe(document.body);
    expect(screen.getByTestId('prompt-card')).toHaveAttribute('data-kind', 'remote.session');
    expect(screen.getByTestId('prompt-card')).toHaveAttribute('data-activation', 'none');
  });

  it('pill expands locally without a wire action', () => {
    const { onAction, onHide, onExpandedChange } = renderPill();
    fireEvent.click(pillButton(), { detail: 1 });
    // Expanded: the facts and the actions the agent sent.
    expect(pillButton()).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByText('Alex Rivera')).toBeInTheDocument();
    expect(screen.getByText('View and control')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'End session' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Report a problem' })).toBeInTheDocument();
    // `{time:}` in a fact is the renderer's to fill.
    expect(screen.queryByText(/\{time:/)).not.toBeInTheDocument();
    // Nothing went to the agent; only the window was asked to grow.
    expect(onAction).not.toHaveBeenCalled();
    expect(onHide).not.toHaveBeenCalled();
    expect(onExpandedChange).toHaveBeenLastCalledWith(true);
    // Collapsing is local too (the pill, or the Show less control).
    fireEvent.click(screen.getByRole('button', { name: 'Show less' }), { detail: 1 });
    expect(pillButton()).toHaveAttribute('aria-expanded', 'false');
    expect(onExpandedChange).toHaveBeenLastCalledWith(false);
    expect(onAction).not.toHaveBeenCalled();
  });

  it('shows End session only when the agent sent it', () => {
    renderPill({ ...session, actions: [{ id: 'report_problem', label: 'Report a problem', role: 'neutral' }] });
    fireEvent.click(pillButton(), { detail: 1 });
    expect(screen.getByRole('button', { name: 'Report a problem' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'End session' })).not.toBeInTheDocument();
  });

  it('Esc collapses an expanded pill and never hides it or acts', () => {
    const { onAction, onHide } = renderPill();
    fireEvent.click(pillButton(), { detail: 1 });
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(pillButton()).toHaveAttribute('aria-expanded', 'false');
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onAction).not.toHaveBeenCalled();
    expect(onHide).not.toHaveBeenCalled();
  });

  it('the confirm step from the agent: Keep session is first, focused, and Esc keeps the session', () => {
    const { onAction, rerenderWith } = renderPill();
    fireEvent.click(pillButton(), { detail: 1 });
    rerenderWith(confirming);
    expect(screen.getByText('End this remote session? The technician will be disconnected.')).toBeInTheDocument();
    const actions = within(screen.getByTestId('session-actions')).getAllByRole('button');
    expect(actions.map((b) => b.textContent)).toEqual(['Keep session', 'End session']);
    expect(document.activeElement).toBe(actions[0]);
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onAction).toHaveBeenCalledTimes(1);
    expect(onAction).toHaveBeenCalledWith('keep_session', 'keyboard');
  });

  it('a confirm step that arrives while collapsed (a replay) opens the pill to show it', () => {
    const { onExpandedChange } = renderPill(confirming);
    expect(pillButton()).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByRole('button', { name: 'Keep session' })).toBeInTheDocument();
    expect(onExpandedChange).toHaveBeenLastCalledWith(true);
  });

  it('opens itself to show a failed action: timed_out gives an alert and the actions are enabled again', () => {
    const { onExpandedChange } = renderPill({ ...session, lastOutcome: 'timed_out' });
    expect(pillButton()).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByRole('alert')).toHaveTextContent("No answer from your IT provider's agent. Try again.");
    expect(screen.getByRole('button', { name: 'End session' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Report a problem' })).toBeEnabled();
    expect(onExpandedChange).toHaveBeenLastCalledWith(true);
  });

  it('opens itself for a rejected result or an error that arrives while collapsed', () => {
    const { rerenderWith } = renderPill();
    expect(pillButton()).toHaveAttribute('aria-expanded', 'false');
    rerenderWith({ ...session, lastOutcome: 'rejected_invalid', version: 2 });
    expect(pillButton()).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByRole('alert')).toHaveTextContent('That choice could not be applied.');
  });

  it('shows Working… and disables the actions while one is in flight', () => {
    renderPill({ ...session, pendingActionId: 'report_problem' });
    fireEvent.click(pillButton(), { detail: 1 });
    expect(screen.getByText('Working…')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Report a problem' })).toBeDisabled();
  });
});

/** A Rust stand-in for the card window: `getView` answers from `current`; `notify` fires a version notice. */
function fakeApi(initial: PromptView) {
  let notify: ((n: VersionNotice) => void) | null = null;
  const state = { current: initial };
  const api: PromptCardApi = {
    getView: vi.fn(async () => state.current),
    action: vi.fn(async () => {}),
    hide: vi.fn(async () => {}),
    setExpanded: vi.fn(async () => {}),
    subscribe: vi.fn(async (onNotice: (n: VersionNotice) => void) => {
      notify = onNotice;
      return () => {
        notify = null;
      };
    }),
  };
  return { api, state, notify: (version: number) => notify?.({ version }) };
}

describe('remote.session pill in its window', () => {
  it('expanding asks Rust to resize the pill window and sends nothing to the agent', async () => {
    const { api } = fakeApi(session);
    render(<PromptCardWindow promptId={session.promptId} api={api} clock={() => NOW} retryDelayMs={0} identityEnabled={false} />);
    fireEvent.click(await screen.findByRole('button', { name: /Remote session in progress/ }), { detail: 1 });
    await waitFor(() => expect(api.setExpanded).toHaveBeenCalledWith(session.promptId, true));
    expect(api.action).not.toHaveBeenCalled();
    expect(api.hide).not.toHaveBeenCalled();
  });

  it('end session asks for confirmation', async () => {
    const { api, state, notify } = fakeApi(session);
    render(<PromptCardWindow promptId={session.promptId} api={api} clock={() => NOW} retryDelayMs={0} identityEnabled={false} />);
    fireEvent.click(await screen.findByRole('button', { name: /Remote session in progress/ }), { detail: 1 });
    fireEvent.click(screen.getByRole('button', { name: 'End session' }), { detail: 1 });
    // The click is a wire action; the renderer draws no confirm of its own.
    expect(api.action).toHaveBeenCalledWith(session.promptId, 'end_session', 'click');
    expect(screen.queryByRole('button', { name: 'Keep session' })).not.toBeInTheDocument();
    // The agent's prompt_update swaps the action set: the confirm comes from it.
    state.current = confirming;
    await act(async () => {
      notify(2);
    });
    const keep = await screen.findByRole('button', { name: 'Keep session' });
    expect(document.activeElement).toBe(keep);
    fireEvent.click(screen.getByRole('button', { name: 'End session' }), { detail: 1 });
    expect(api.action).toHaveBeenLastCalledWith(session.promptId, 'end_confirm', 'click');
  });

  it('a failed resize reverts the expand (actions never clipped), and Esc on the confirm step still keeps the session', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { api, state, notify } = fakeApi(session);
    vi.mocked(api.setExpanded!).mockRejectedValue('not a session indicator');
    render(<PromptCardWindow promptId={session.promptId} api={api} clock={() => NOW} retryDelayMs={0} identityEnabled={false} />);
    const pill = await screen.findByRole('button', { name: /Remote session in progress/ });
    fireEvent.click(pill, { detail: 1 });
    await waitFor(() => expect(pill).toHaveAttribute('aria-expanded', 'false'));
    expect(screen.queryByRole('button', { name: 'End session' })).not.toBeInTheDocument();
    expect(warn).toHaveBeenCalled();
    // The agent's confirm step tries to open the pill; the resize fails again.
    state.current = confirming;
    await act(async () => {
      notify(2);
    });
    const expands = () => vi.mocked(api.setExpanded!).mock.calls.filter(([, expanded]) => expanded).length;
    await waitFor(() => expect(expands()).toBe(2));
    await waitFor(() => expect(pill).toHaveAttribute('aria-expanded', 'false'));
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(api.action).toHaveBeenCalledWith(session.promptId, 'keep_session', 'keyboard');
    expect(api.action).not.toHaveBeenCalledWith(session.promptId, 'end_confirm', expect.anything());
  });

  it('an action that cannot be sent opens the collapsed pill with the error', async () => {
    const { api } = fakeApi(session);
    let fail: (reason: unknown) => void = () => {};
    vi.mocked(api.action).mockImplementation(
      () =>
        new Promise<void>((_, reject) => {
          fail = reject;
        }),
    );
    render(<PromptCardWindow promptId={session.promptId} api={api} clock={() => NOW} retryDelayMs={0} identityEnabled={false} />);
    const pill = await screen.findByRole('button', { name: /Remote session in progress/ });
    fireEvent.click(pill, { detail: 1 });
    fireEvent.click(screen.getByRole('button', { name: 'End session' }), { detail: 1 });
    // The person collapses the pill while End session is on its way...
    fireEvent.click(screen.getByRole('button', { name: 'Show less' }), { detail: 1 });
    expect(pill).toHaveAttribute('aria-expanded', 'false');
    // ...and it fails: the pill opens to say so.
    await act(async () => {
      fail("Not connected to your IT provider's agent. Try again in a moment.");
    });
    expect(pill).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByRole('alert')).toHaveTextContent("Not connected to your IT provider's agent.");
    expect(screen.getByRole('button', { name: 'End session' })).toBeEnabled();
  });

  it('report a problem sends report_problem and opens nothing itself', async () => {
    const { api } = fakeApi(session);
    render(<PromptCardWindow promptId={session.promptId} api={api} clock={() => NOW} retryDelayMs={0} identityEnabled={false} />);
    fireEvent.click(await screen.findByRole('button', { name: /Remote session in progress/ }), { detail: 1 });
    fireEvent.click(screen.getByRole('button', { name: 'Report a problem' }), { detail: 1 });
    // The main window is opened by Rust on the agent's `accepted` only (lib.rs
    // open_request_support); the card has no way to surface it.
    expect(api.action).toHaveBeenCalledWith(session.promptId, 'report_problem', 'click');
    expect(api.action).toHaveBeenCalledTimes(1);
  });
});
