// @vitest-environment jsdom
import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import type { PromptView } from '../types';
import { ElevationCard, FACT_PREVIEW_CHARS } from './elevation';
import { cardForKind } from './registry';

/*
 * `elevation.request@1` (#10190 W07, Task 7.3): the elevation request cards.
 * The agent renders every string; Assist fills `{time:<unixMs>}` and draws:
 *   - pending: the first question (only when UAC is not on the secure
 *     desktop), a focused modal with Cancel (safe, default) and Send request;
 *   - waiting: a non-activating card, Cancel request (safe) and Hide (neutral);
 *   - approved / denied / expired / failed / cancelled: no actions, on screen
 *     until the agent closes it (the agent's 8 s linger).
 */

const NOW = new Date(2026, 9, 29, 10, 0, 0).getTime();
/** The server's pending expiry: 15 minutes from NOW. */
const DEADLINE = NOW + 15 * 60_000;
const hhmm = (ms: number) => new Intl.DateTimeFormat('en', { hour: 'numeric', minute: '2-digit' }).format(new Date(ms));

const LONG_COMMAND = `"C:\\Program Files\\7-Zip\\7zFM.exe" ${'--option-value '.repeat(20)}C:\\Users\\dana\\Downloads\\archive.7z`;

/** The waiting card (golden fixture `show.elevation.waiting.json`, as Rust hands it on). */
const waiting: PromptView = {
  promptId: 'elevation:00000000-0000-4000-8000-0000000000e1',
  kind: 'elevation.request',
  kindVersion: 1,
  state: 'waiting',
  presentation: 'card',
  copy: {
    title: 'Waiting for your IT support team',
    body: 'Your request to run this program as an administrator was sent.',
    stateDetail: `Your IT support team has until {time:${DEADLINE}} to answer.`,
  },
  facts: [
    { label: 'Program', value: '7-Zip File Manager' },
    { label: 'Publisher', value: 'Igor Pavlov' },
    { label: 'Command line', value: '"C:\\Program Files\\7-Zip\\7zFM.exe"' },
  ],
  actions: [
    { id: 'cancel_request', label: 'Cancel request', role: 'safe' },
    { id: 'hide', label: 'Hide', role: 'neutral' },
  ],
  defaultActionId: 'hide',
  decision: false,
  safeActionId: null,
  countdownDeadlineUnixMs: DEADLINE,
  expiryText: `If no one answers by {time:${DEADLINE}}, the request expires.`,
  locale: 'en',
  direction: 'ltr',
  pendingActionId: null,
  lastOutcome: null,
  closed: false,
  card: true,
  lastError: null,
  version: 1,
};

/** The first question, drawn by Assist when `PromptOnSecureDesktop` = 0. */
const firstQuestion: PromptView = {
  ...waiting,
  state: 'pending',
  presentation: 'modal',
  copy: {
    title: 'Ask your IT support team for administrator access?',
    body: '7-Zip File Manager needs administrator rights to run.',
  },
  actions: [
    { id: 'send_request', label: 'Send request', role: 'proceed' },
    { id: 'cancel', label: 'Cancel', role: 'safe' },
  ],
  defaultActionId: 'cancel',
  decision: true,
  safeActionId: 'cancel',
  countdownDeadlineUnixMs: NOW + 90_000,
  expiryText: "If you don't answer in {remaining}, nothing is sent.",
};

function terminal(state: PromptView['state'], title: string, extra: Partial<PromptView> = {}): PromptView {
  return {
    ...waiting,
    state,
    copy: { title, body: extra.copy?.body },
    actions: [],
    defaultActionId: null,
    countdownDeadlineUnixMs: null,
    expiryText: null,
    ...extra,
  };
}

function renderCard(view: PromptView, nowMs = NOW) {
  const onAction = vi.fn();
  const onHide = vi.fn();
  const utils = render(<ElevationCard view={view} nowMs={nowMs} onAction={onAction} onHide={onHide} />);
  return { onAction, onHide, ...utils };
}

describe('elevation.request card', () => {
  it('is the card the registry picks for elevation.request', () => {
    expect(cardForKind('elevation.request')).toBe(ElevationCard);
  });

  it('waiting card shows IT has until {time:}', () => {
    renderCard(waiting);
    expect(screen.getByText(`Your IT support team has until ${hhmm(DEADLINE)} to answer.`)).toBeTruthy();
    expect(screen.queryByText(/\{time:/)).toBeNull();
    expect(screen.getByRole('heading', { name: 'Waiting for your IT support team' })).toBeTruthy();
  });

  it('Cancel request is safe and Hide is neutral', () => {
    // A waiting card never moves keyboard focus (non-activating window):
    // nothing in it is focused on paint, not even the safe action.
    const focus = vi.spyOn(HTMLElement.prototype, 'focus');
    let onAction: ReturnType<typeof vi.fn>;
    try {
      ({ onAction } = renderCard(waiting));
      expect(focus).not.toHaveBeenCalled();
    } finally {
      focus.mockRestore();
    }
    const card = screen.getByTestId('prompt-card');
    expect(card.getAttribute('data-activation')).toBe('none');
    expect(card.getAttribute('role')).toBe('dialog');
    const buttons = within(card).getAllByRole('button');
    const actions = buttons.filter((b) => b.classList.contains('prompt-action'));
    expect(actions.map((b) => b.textContent)).toEqual(['Cancel request', 'Hide']);
    expect(actions[0]!.classList.contains('is-safe')).toBe(true);
    expect(actions[1]!.classList.contains('is-neutral')).toBe(true);
    fireEvent.click(actions[1]!, { detail: 1 });
    expect(onAction).toHaveBeenCalledWith('hide', 'click');
    fireEvent.click(actions[0]!, { detail: 1 });
    expect(onAction).toHaveBeenCalledWith('cancel_request', 'click');
  });

  it('Esc on the waiting card hides it and never cancels the request', () => {
    const { onAction, onHide } = renderCard(waiting);
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onHide).toHaveBeenCalledTimes(1);
    expect(onAction).not.toHaveBeenCalled();
  });

  it('first question: Cancel is the safe default, focused, and Esc cancels', () => {
    const { onAction } = renderCard(firstQuestion);
    const card = screen.getByTestId('prompt-card');
    expect(card.getAttribute('role')).toBe('alertdialog');
    const actions = within(card).getAllByRole('button').filter((b) => b.classList.contains('prompt-action'));
    expect(actions.map((b) => b.textContent)).toEqual(['Cancel', 'Send request']);
    expect(document.activeElement).toBe(actions[0]);
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onAction).toHaveBeenCalledTimes(1);
    expect(onAction).toHaveBeenCalledWith('cancel', 'keyboard');
  });

  it('Esc while an action is on its way sends nothing', () => {
    const { onAction, onHide } = renderCard({ ...firstQuestion, pendingActionId: 'send_request' });
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onAction).not.toHaveBeenCalled();
    expect(onHide).not.toHaveBeenCalled();
    // The buttons are disabled meanwhile.
    const actions = within(screen.getByTestId('prompt-card'))
      .getAllByRole('button')
      .filter((b) => b.classList.contains('prompt-action'));
    expect(actions.every((b) => (b as HTMLButtonElement).disabled)).toBe(true);
  });

  it('the first question never cuts a fact: the whole command line is shown before Send request', () => {
    renderCard({ ...firstQuestion, facts: [{ label: 'Command line', value: LONG_COMMAND }] });
    expect(screen.getByText(LONG_COMMAND)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Show more' })).toBeNull();
  });

  it('facts truncate with Show more', () => {
    const view: PromptView = {
      ...waiting,
      facts: [
        { label: 'Program', value: '7-Zip File Manager' },
        { label: 'Command line', value: LONG_COMMAND },
      ],
    };
    renderCard(view);
    expect(Array.from(LONG_COMMAND).length).toBeGreaterThan(FACT_PREVIEW_CHARS);
    // A short fact is shown in full with no toggle.
    expect(screen.getByText('7-Zip File Manager')).toBeTruthy();
    expect(screen.getAllByRole('button', { name: 'Show more' })).toHaveLength(1);
    // The long one is cut, never shown whole, until asked.
    expect(screen.queryByText(LONG_COMMAND)).toBeNull();
    const cut = screen.getByTestId('elevation-fact-value-1');
    expect(cut.textContent!.endsWith('…')).toBe(true);
    expect(Array.from(cut.textContent!).length).toBe(FACT_PREVIEW_CHARS + 1);
    const more = screen.getByRole('button', { name: 'Show more' });
    expect(more.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(more);
    expect(screen.getByTestId('elevation-fact-value-1').textContent).toBe(LONG_COMMAND);
    const less = screen.getByRole('button', { name: 'Show less' });
    expect(less.getAttribute('aria-expanded')).toBe('true');
    fireEvent.click(less);
    expect(screen.queryByText(LONG_COMMAND)).toBeNull();
  });

  it('a fact value is text, never a placeholder target', () => {
    const view: PromptView = { ...waiting, facts: [{ label: 'Command line', value: `run.exe {time:${DEADLINE}}` }] };
    renderCard(view);
    expect(screen.getByText(`run.exe {time:${DEADLINE}}`)).toBeTruthy();
  });

  it('approved card lingers 8 s', () => {
    const approved = terminal('approved', 'Request approved', {
      copy: { title: 'Request approved', body: 'Approved by Alex Rivera at Example IT.' },
    });
    const { rerender, onAction, onHide } = renderCard(approved);
    expect(screen.getByRole('heading', { name: 'Request approved' })).toBeTruthy();
    expect(screen.getByText('Approved by Alex Rivera at Example IT.')).toBeTruthy();
    // Eight seconds on, still drawn (the agent's prompt_close takes it down), and nothing to press.
    rerender(<ElevationCard view={approved} nowMs={NOW + 8_000} onAction={onAction} onHide={onHide} />);
    expect(screen.getByRole('heading', { name: 'Request approved' })).toBeTruthy();
    expect(within(screen.getByTestId('prompt-card')).queryAllByRole('button').filter((b) => b.classList.contains('prompt-action'))).toHaveLength(0);
    expect(screen.getByTestId('prompt-card').className).toContain('is-approved');
    // Esc only hides an outcome card.
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onHide).toHaveBeenCalledTimes(1);
    expect(onAction).not.toHaveBeenCalled();
  });

  it('denied shows the Reason fact', () => {
    const denied = terminal('denied', 'Request denied', {
      copy: { title: 'Request denied', body: 'Your IT support team denied this request.' },
      facts: [...waiting.facts, { label: 'Reason', value: 'Use the approved installer from the portal.' }],
    });
    renderCard(denied);
    expect(screen.getByRole('heading', { name: 'Request denied' })).toBeTruthy();
    expect(screen.getByText('Reason')).toBeTruthy();
    expect(screen.getByText('Use the approved installer from the portal.')).toBeTruthy();
  });

  it.each([
    ['expired', 'Request expired'],
    ['failed', "The program couldn't start"],
    ['cancelled', 'Request cancelled'],
  ] as const)('%s renders without actions', (state, title) => {
    renderCard(terminal(state, title));
    expect(screen.getByRole('heading', { name: title })).toBeTruthy();
    expect(screen.getByTestId('prompt-card').className).toContain(`is-${state}`);
    expect(within(screen.getByTestId('prompt-card')).queryAllByRole('button').filter((b) => b.classList.contains('prompt-action'))).toHaveLength(0);
  });
});
