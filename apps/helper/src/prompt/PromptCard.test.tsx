// @vitest-environment jsdom
import { act, fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { PromptCard } from './PromptCard';
import type { PromptView } from './types';

const NOW = new Date(2026, 9, 26, 14, 30, 0).getTime();
const DEADLINE = NOW + 125_000;
const POSTPONE_AT = new Date(2026, 9, 26, 15, 30, 0).getTime();

/** A pending restart decision; the safe action deliberately comes second on the wire. */
const decision: PromptView = {
  promptId: 'restart:42',
  kind: 'restart.prompt',
  kindVersion: 1,
  state: 'pending',
  presentation: 'card',
  copy: {
    title: 'Restart to finish installing updates',
    body: 'Save your work before the restart.',
    consequence: 'Time left: {remaining}.',
    operatorNote: 'Questions? Call the help desk. {{countdown}}',
  },
  facts: [],
  actions: [
    { id: 'restart_now', label: 'Restart now', role: 'proceed' },
    { id: 'postpone', label: `Postpone until {time:${POSTPONE_AT}}`, role: 'safe' },
  ],
  defaultActionId: 'postpone',
  decision: true,
  safeActionId: 'postpone',
  countdownDeadlineUnixMs: DEADLINE,
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

/** A waiting elevation request: not a decision. */
const waiting: PromptView = {
  ...decision,
  promptId: 'elevation:e1',
  kind: 'elevation.request',
  state: 'waiting',
  copy: { title: 'Waiting for your IT support team', stateDetail: 'Sent.' },
  facts: [{ label: 'Program', value: '<b>7-Zip</b>' }],
  actions: [
    { id: 'hide', label: 'Hide', role: 'neutral' },
    { id: 'cancel_request', label: 'Cancel request', role: 'safe' },
  ],
  defaultActionId: 'hide',
  decision: false,
  safeActionId: null,
  countdownDeadlineUnixMs: null,
};

function renderCard(view: PromptView, nowMs = NOW) {
  const onAction = vi.fn();
  const onHide = vi.fn();
  const utils = render(<PromptCard view={view} nowMs={nowMs} onAction={onAction} onHide={onHide} />);
  return { onAction, onHide, ...utils };
}

describe('PromptCard', () => {
  it('PromptCard: safe action is first in tab order and focused', () => {
    renderCard(decision);
    const buttons = screen.getAllByRole('button');
    expect(buttons[0]).toHaveTextContent(/^Postpone until/);
    expect(buttons[1]).toHaveTextContent('Restart now');
    expect(document.activeElement).toBe(buttons[0]);
    for (const b of buttons) {
      expect(Number(b.getAttribute('tabindex') ?? 0)).toBeLessThanOrEqual(0);
    }
    // Same rule when the safe action is not the default (a waiting card).
    renderCard(waiting);
    const second = screen.getAllByRole('button').slice(2);
    expect(second[0]).toHaveTextContent('Cancel request');
  });

  it('Esc triggers the safe action on a pending decision and hide otherwise', () => {
    const d = renderCard(decision);
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(d.onAction).toHaveBeenCalledWith('postpone', 'keyboard');
    expect(d.onHide).not.toHaveBeenCalled();
    d.unmount();

    const w = renderCard(waiting);
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(w.onHide).toHaveBeenCalledTimes(1);
    expect(w.onAction).not.toHaveBeenCalled();
    w.unmount();

    // A decision whose safe action is already on its way is neither re-sent nor hidden.
    const p = renderCard({ ...decision, pendingActionId: 'postpone' });
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(p.onAction).not.toHaveBeenCalled();
    expect(p.onHide).not.toHaveBeenCalled();
  });

  it('fills placeholders in copy slots and action labels only', () => {
    renderCard(decision);
    expect(screen.getByText('Time left: 2:05.')).toBeInTheDocument();
    const time = new Intl.DateTimeFormat('en', { hour: 'numeric', minute: '2-digit' }).format(new Date(POSTPONE_AT));
    expect(screen.getByRole('button', { name: `Postpone until ${time}` })).toBeInTheDocument();
    // Operator text is shown verbatim: {{countdown}} stays literal, in its own block.
    expect(screen.getByTestId('prompt-operator-note')).toHaveTextContent('Questions? Call the help desk. {{countdown}}');
  });

  it('renders facts as text, never markup', () => {
    renderCard(waiting);
    expect(screen.getByText('<b>7-Zip</b>')).toBeInTheDocument();
    expect(document.querySelector('b')).toBeNull();
  });

  it('reports click versus keyboard activation', () => {
    const { onAction } = renderCard(decision);
    fireEvent.click(screen.getByRole('button', { name: 'Restart now' }), { detail: 1 });
    expect(onAction).toHaveBeenLastCalledWith('restart_now', 'click');
    fireEvent.click(screen.getByRole('button', { name: 'Restart now' }), { detail: 0 });
    expect(onAction).toHaveBeenLastCalledWith('restart_now', 'keyboard');
  });

  it('shows a working state while an action is in flight and no actions once closed', () => {
    const { rerender, onAction, onHide } = renderCard({ ...decision, pendingActionId: 'postpone' });
    expect(screen.getByText('Working…')).toBeInTheDocument();
    for (const b of screen.getAllByRole('button')) expect(b).toBeDisabled();
    rerender(<PromptCard view={{ ...decision, closed: true, actions: [], decision: false }} nowMs={NOW} onAction={onAction} onHide={onHide} />);
    expect(screen.queryAllByRole('button')).toHaveLength(0);
    rerender(<PromptCard view={{ ...decision, lastOutcome: 'rejected_stale' }} nowMs={NOW} onAction={onAction} onHide={onHide} />);
    expect(screen.getByRole('alert')).toHaveTextContent('That choice is no longer available.');
    // A refusal Rust recorded (e.g. the close box with no agent session) is shown too.
    rerender(<PromptCard view={{ ...decision, lastError: 'Not connected.' }} nowMs={NOW} onAction={onAction} onHide={onHide} />);
    expect(screen.getByRole('alert')).toHaveTextContent('Not connected.');
  });

  it('announces the countdown only when it crosses 60, 30 or 10 seconds', () => {
    const { rerender, onAction, onHide } = renderCard(decision, DEADLINE - 61_000);
    const live = screen.getByTestId('prompt-announce');
    expect(live).toHaveAttribute('aria-live', 'polite');
    expect(live).toBeEmptyDOMElement();
    const at = (now: number) =>
      act(() => {
        rerender(<PromptCard view={decision} nowMs={now} onAction={onAction} onHide={onHide} />);
      });
    at(DEADLINE - 60_500); // 61 s, rounded up: not yet
    expect(live).toBeEmptyDOMElement();
    at(DEADLINE - 60_000);
    expect(live).toHaveTextContent('60 seconds remaining');
    at(DEADLINE - 45_000);
    expect(live).toHaveTextContent('60 seconds remaining');
    at(DEADLINE - 29_500);
    expect(live).toHaveTextContent('30 seconds remaining');
  });

  it("chrome strings render in the prompt's locale", () => {
    const { rerender, onAction, onHide } = renderCard({ ...decision, locale: 'de-DE', pendingActionId: 'postpone' }, DEADLINE - 60_000);
    expect(screen.getByText('Wird bearbeitet…')).toBeInTheDocument();
    // No synced identity: the localized generic name.
    expect(screen.getByTestId('prompt-identity')).toHaveTextContent('Ihr IT-Support-Team');
    rerender(
      <PromptCard view={{ ...decision, locale: 'de-DE' }} nowMs={DEADLINE - 30_000} onAction={onAction} onHide={onHide} />,
    );
    expect(screen.getByTestId('prompt-announce')).toHaveTextContent('Noch 30 Sekunden');
  });

  it('shows the synced MSP identity in its header', () => {
    render(
      <PromptCard
        view={decision}
        nowMs={NOW}
        onAction={vi.fn()}
        onHide={vi.fn()}
        identity={{ partnerName: 'Example IT Services', primaryColor: '#1F5FAD', logo: null }}
        logoUrl="blob:assist/1"
      />,
    );
    const header = screen.getByTestId('prompt-identity');
    expect(header).toHaveTextContent('Example IT Services');
    expect(header.querySelector('img')).toHaveAttribute('src', 'blob:assist/1');
  });
});
