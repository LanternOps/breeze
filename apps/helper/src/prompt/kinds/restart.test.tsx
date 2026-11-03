// @vitest-environment jsdom
import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { NotificationsTab } from '../NotificationsTab';
import { PromptCardWindow, type PromptCardApi } from '../PromptCardWindow';
import type { PromptView } from '../types';
import { cardForKind } from './registry';
import { RestartFinalCard, RestartPromptCard } from './restart';

const NOW = new Date(2026, 9, 27, 9, 0, 0).getTime();
/** The scheduled restart: 2:05 from NOW. */
const DEADLINE = NOW + 125_000;
/** What a Postpone would move it to. */
const POSTPONED = new Date(2026, 9, 27, 10, 0, 0).getTime();

const hhmm = (ms: number) => new Intl.DateTimeFormat('en', { hour: 'numeric', minute: '2-digit' }).format(new Date(ms));

/** `restart.prompt@1` with Postpone offered: a pending decision (wire contract, PR 5A). */
const pending: PromptView = {
  promptId: 'restart:42',
  kind: 'restart.prompt',
  kindVersion: 1,
  state: 'pending',
  presentation: 'card',
  copy: {
    title: 'Restart to finish installing updates',
    body: 'This computer restarts in {remaining}. {{countdown}} stays literal.',
    consequence: `If you do nothing, this computer restarts at {time:${DEADLINE}}. Save your work before then.`,
    stateDetail: '2 postponements left',
    operatorNote: 'Questions? Call the help desk.',
  },
  facts: [],
  actions: [
    { id: 'postpone', label: `Postpone until {time:${POSTPONED}}`, role: 'safe' },
    { id: 'restart_now', label: 'Restart now', role: 'proceed' },
  ],
  defaultActionId: 'postpone',
  decision: true,
  safeActionId: 'postpone',
  countdownDeadlineUnixMs: DEADLINE,
  expiryText: `Your computer restarts at {time:${DEADLINE}}.`,
  locale: 'en',
  direction: 'ltr',
  pendingActionId: null,
  lastOutcome: null,
  closed: false,
  card: true,
  lastError: null,
  version: 1,
};

/** Postpone not offered: still a decision, OK (safe, default) beside Restart now. */
const noPostpone: PromptView = {
  ...pending,
  copy: { ...pending.copy, stateDetail: 'No postponements left' },
  actions: [
    { id: 'restart_now', label: 'Restart now', role: 'proceed' },
    { id: 'ok', label: 'OK', role: 'safe' },
  ],
  defaultActionId: 'ok',
  safeActionId: 'ok',
  version: 2,
};

/**
 * Not a shape the agent sends (5A answers "no Postpone" with OK), but nothing
 * stops the wire carrying it: a restart card that is not a decision.
 */
const nonDecision: PromptView = {
  ...pending,
  state: 'waiting',
  actions: [{ id: 'restart_now', label: 'Restart now', role: 'proceed' }],
  defaultActionId: null,
  decision: false,
  safeActionId: null,
  version: 2,
};

/** `restart.final@1`: the closing card while the OS countdown runs. */
const final: PromptView = {
  ...pending,
  promptId: 'restart:42:final',
  kind: 'restart.final',
  copy: { title: 'This computer is restarting', body: 'This computer restarts in {remaining}. Save your work now.' },
  actions: [{ id: 'ok', label: 'OK', role: 'safe' }],
  defaultActionId: 'ok',
  safeActionId: 'ok',
  countdownDeadlineUnixMs: NOW + 90_000,
  expiryText: null,
};

function api(view: PromptView): PromptCardApi {
  return {
    getView: vi.fn(async () => view),
    action: vi.fn(async () => {}),
    hide: vi.fn(async () => {}),
    subscribe: vi.fn(async () => () => {}),
  };
}

function renderCard(Card: typeof RestartPromptCard, view: PromptView, nowMs = NOW) {
  const onAction = vi.fn();
  const onHide = vi.fn();
  const utils = render(<Card view={view} nowMs={nowMs} onAction={onAction} onHide={onHide} />);
  const rerenderWith = (v: PromptView, now = nowMs) =>
    act(() => {
      utils.rerender(<Card view={v} nowMs={now} onAction={onAction} onHide={onHide} />);
    });
  return { onAction, onHide, rerenderWith, ...utils };
}

const clock = () => Date.now();

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('restart cards (#10190 W05)', () => {
  it('registers both restart kinds', () => {
    expect(cardForKind('restart.prompt')).toBe(RestartPromptCard);
    expect(cardForKind('restart.final')).toBe(RestartFinalCard);
  });

  it('restart card shows {time:} in local format and live {remaining}', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'], now: NOW });
    render(<PromptCardWindow promptId={pending.promptId} api={api(pending)} clock={clock} retryDelayMs={0} />);
    const card = await screen.findByTestId('prompt-card');
    expect(card).toHaveAttribute('data-kind', 'restart.prompt');
    // {time:} is a local wall-clock time, in the consequence and the Postpone label.
    expect(card).toHaveTextContent(`If you do nothing, this computer restarts at ${hhmm(DEADLINE)}. Save your work before then.`);
    expect(screen.getByRole('button', { name: `Postpone until ${hhmm(POSTPONED)}` })).toBeInTheDocument();
    expect(card).not.toHaveTextContent('{time:');
    // {remaining} is live; any other brace text stays literal.
    expect(card).toHaveTextContent('This computer restarts in 2:05. {{countdown}} stays literal.');
    act(() => {
      vi.advanceTimersByTime(1_000);
    });
    expect(card).toHaveTextContent('This computer restarts in 2:04.');
    act(() => {
      vi.advanceTimersByTime(65_000);
    });
    expect(card).toHaveTextContent('This computer restarts in 0:59.');
    // A sleep past the deadline floors at 0:00, never negative time.
    act(() => {
      vi.advanceTimersByTime(10 * 60_000);
    });
    expect(card).toHaveTextContent('This computer restarts in 0:00.');
    expect(card).not.toHaveTextContent('-');
    // The consequence is stated once, not again as the expiry line.
    expect(card.textContent?.match(new RegExp(`restarts at ${hhmm(DEADLINE)}`, 'g'))).toHaveLength(1);
  });

  it('keeps the expiry line when there is no consequence to state it', () => {
    const { copy } = pending;
    renderCard(RestartPromptCard, { ...pending, copy: { title: copy.title, body: copy.body } });
    expect(screen.getByTestId('prompt-card')).toHaveTextContent(`Your computer restarts at ${hhmm(DEADLINE)}.`);
  });

  it('Postpone is focused and default', () => {
    const { onAction, onHide } = renderCard(RestartPromptCard, pending);
    const card = screen.getByTestId('prompt-card');
    expect(card).toHaveAttribute('role', 'alertdialog');
    const buttons = screen.getAllByRole('button');
    expect(buttons.map((b) => b.textContent)).toEqual([`Postpone until ${hhmm(POSTPONED)}`, 'Restart now']);
    expect(document.activeElement).toBe(buttons[0]);
    expect(screen.getByText('2 postponements left')).toBeInTheDocument();
    expect(screen.getByTestId('prompt-operator-note')).toHaveTextContent('Questions? Call the help desk.');
    // Esc (and, in Rust, the close box) is Postpone.
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onAction).toHaveBeenCalledWith('postpone', 'keyboard');
    expect(onHide).not.toHaveBeenCalled();
  });

  it('no-postpone card defaults to OK', async () => {
    const { onAction, onHide } = renderCard(RestartPromptCard, noPostpone);
    const card = screen.getByTestId('prompt-card');
    expect(card).toHaveAttribute('role', 'alertdialog');
    const buttons = screen.getAllByRole('button');
    expect(buttons.map((b) => b.textContent)).toEqual(['OK', 'Restart now']);
    expect(document.activeElement).toBe(buttons[0]);
    expect(screen.getByText('No postponements left')).toBeInTheDocument();
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onAction).toHaveBeenCalledWith('ok', 'keyboard');
    expect(onAction).not.toHaveBeenCalledWith('restart_now', expect.anything());
    expect(onHide).not.toHaveBeenCalled();

    // Through the window: Esc sends OK, never Restart now.
    const a = api(noPostpone);
    render(<PromptCardWindow promptId={noPostpone.promptId} api={a} retryDelayMs={0} />);
    await screen.findAllByTestId('prompt-card');
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(a.action).toHaveBeenCalledWith(noPostpone.promptId, 'ok', 'keyboard');
    expect(a.action).not.toHaveBeenCalledWith(noPostpone.promptId, 'restart_now', expect.anything());
  });

  it('defence in depth: a restart card that is not a decision never focuses Restart now', () => {
    // Arriving that way: nothing focused, Esc only hides.
    const first = renderCard(RestartPromptCard, nonDecision);
    expect(screen.getByTestId('prompt-card')).toHaveAttribute('data-activation', 'none');
    expect(document.activeElement).toBe(document.body);
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(first.onHide).toHaveBeenCalledTimes(1);
    expect(first.onAction).not.toHaveBeenCalled();
    first.unmount();
    // Turning into one while the person had tabbed to Restart now.
    const { rerenderWith } = renderCard(RestartPromptCard, pending);
    const restartNow = screen.getByRole('button', { name: 'Restart now' });
    restartNow.focus();
    rerenderWith(nonDecision);
    expect(screen.getByRole('button', { name: 'Restart now' })).toBe(restartNow);
    expect(document.activeElement).not.toBe(restartNow);
    // Back to a decision: its safe action again.
    rerenderWith({ ...pending, version: 3 });
    expect(document.activeElement).toBe(screen.getByRole('button', { name: `Postpone until ${hhmm(POSTPONED)}` }));
  });

  it('final card steals focus once and has only OK', () => {
    const { onAction, rerenderWith } = renderCard(RestartFinalCard, final);
    const card = screen.getByTestId('prompt-card');
    expect(card).toHaveAttribute('data-kind', 'restart.final');
    expect(card).toHaveAttribute('role', 'alertdialog');
    const ok = screen.getByRole('button', { name: 'OK' });
    expect(screen.getAllByRole('button')).toEqual([ok]);
    expect(document.activeElement).toBe(ok);
    expect(card).toHaveTextContent('This computer restarts in 1:30. Save your work now.');
    // The person moves away; a refresh of the same card does not take focus again.
    ok.blur();
    rerenderWith({ ...final, version: 2 }, NOW + 1_000);
    expect(document.activeElement).toBe(document.body);
    expect(card).toHaveTextContent('This computer restarts in 1:29.');
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onAction).toHaveBeenCalledWith('ok', 'keyboard');
  });

  it('announces the countdown only at 60, 30 and 10 seconds', () => {
    const deadline = final.countdownDeadlineUnixMs!;
    const { rerenderWith } = renderCard(RestartFinalCard, final, deadline - 61_000);
    const live = screen.getByTestId('prompt-announce');
    const said: string[] = [];
    for (let s = 61; s >= 0; s--) {
      rerenderWith(final, deadline - s * 1_000);
      if (live.textContent && live.textContent !== said[said.length - 1]) said.push(live.textContent);
    }
    expect(said).toEqual(['60 seconds remaining', '30 seconds remaining', '10 seconds remaining']);
  });

  it('stays in the Notifications list after an accepted Postpone or OK, with its actions', () => {
    const collapsed: PromptView = {
      ...pending,
      card: false,
      lastOutcome: 'accepted',
      countdownDeadlineUnixMs: POSTPONED,
      version: 5,
    };
    const onAction = vi.fn(async () => {});
    render(<NotificationsTab entries={[collapsed]} onAction={onAction} clock={() => NOW} />);
    const item = screen.getByRole('listitem');
    expect(item).toHaveAttribute('data-kind', 'restart.prompt');
    expect(item).toHaveTextContent('Restart to finish installing updates');
    const postpone = screen.getByRole('button', { name: `Postpone until ${hhmm(POSTPONED)}` });
    expect(screen.getByRole('button', { name: 'Restart now' })).toBeInTheDocument();
    fireEvent.click(postpone);
    expect(onAction).toHaveBeenCalledWith('restart:42', 'postpone');
  });
});
