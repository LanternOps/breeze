// @vitest-environment jsdom
import { act, fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { PromptCardWindow, type PromptCardApi } from '../PromptCardWindow';
import type { PromptView } from '../types';
import { ConsentCard } from './consent';
import { cardForKind } from './registry';

/*
 * `remote.consent@1` (#10190 W06, contract section 3): the Assist consent card
 * on the prompt contract. Ported from the legacy ConsentDialog behaviour
 * (Deny focused, Esc = deny), which the card must keep: Deny is the safe,
 * default action, first in the tab order and focused on paint, and Esc and
 * the close box choose it. The countdown is display only (the agent's timer
 * decides expiry).
 */

const NOW = new Date(2026, 9, 27, 10, 0, 0).getTime();

/** What Rust hands the card for a consent prompt (Allow deliberately first on the wire). */
const consent: PromptView = {
  promptId: 'consent:9f2c4e1a',
  kind: 'remote.consent',
  kindVersion: 1,
  state: 'pending',
  presentation: 'modal',
  copy: {
    title: 'Remote support request',
    body: 'A technician wants to start a remote session on this computer.',
  },
  facts: [
    { label: 'Technician', value: 'Alex Rivera' },
    { label: 'Email', value: 'alex@example.test' },
  ],
  actions: [
    { id: 'allow', label: 'Allow', role: 'proceed' },
    { id: 'deny', label: 'Deny', role: 'safe' },
  ],
  defaultActionId: 'deny',
  decision: true,
  safeActionId: 'deny',
  countdownDeadlineUnixMs: NOW + 30_000,
  expiryText: 'If no one answers, the session is declined in {remaining}.',
  locale: 'en',
  direction: 'ltr',
  pendingActionId: null,
  lastOutcome: null,
  closed: false,
  card: true,
  lastError: null,
  version: 1,
};

function renderConsent(view: PromptView = consent, nowMs = NOW) {
  const onAction = vi.fn();
  const onHide = vi.fn();
  const utils = render(<ConsentCard view={view} nowMs={nowMs} onAction={onAction} onHide={onHide} />);
  return { onAction, onHide, ...utils };
}

describe('remote.consent card', () => {
  it('is the card the registry picks for remote.consent', () => {
    expect(cardForKind('remote.consent')).toBe(ConsentCard);
  });

  it('Deny is focused on paint and first in the tab order (ported from ConsentWindow)', () => {
    renderConsent();
    const buttons = screen.getAllByRole('button');
    expect(buttons.map((b) => b.textContent)).toEqual(['Deny', 'Allow']);
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Deny' }));
    expect(document.activeElement).not.toBe(screen.getByRole('button', { name: 'Allow' }));
  });

  it('Esc denies (ported from ConsentWindow), from the keyboard, and never allows', () => {
    const { onAction, onHide } = renderConsent();
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onAction).toHaveBeenCalledTimes(1);
    expect(onAction).toHaveBeenCalledWith('deny', 'keyboard');
    expect(onAction).not.toHaveBeenCalledWith('allow', expect.anything());
    expect(onHide).not.toHaveBeenCalled();
  });

  it('Allow and Deny each send their own action', () => {
    const { onAction } = renderConsent();
    fireEvent.click(screen.getByRole('button', { name: 'Allow' }), { detail: 1 });
    expect(onAction).toHaveBeenCalledWith('allow', 'click');
    fireEvent.click(screen.getByRole('button', { name: 'Deny' }), { detail: 1 });
    expect(onAction).toHaveBeenCalledWith('deny', 'click');
  });

  it('is an alertdialog with the identity header and the technician facts', () => {
    renderConsent();
    const card = screen.getByRole('alertdialog');
    expect(card).toHaveAttribute('data-kind', 'remote.consent');
    expect(card).toHaveAccessibleName('Remote support request');
    expect(screen.getByTestId('prompt-identity')).toBeInTheDocument();
    expect(screen.getByText('Technician')).toBeInTheDocument();
    expect(screen.getByText('Alex Rivera')).toBeInTheDocument();
    expect(screen.getByText('alex@example.test')).toBeInTheDocument();
  });

  it('fills {remaining} from the deadline and floors it at 0:00', () => {
    const { rerender, onAction, onHide } = renderConsent();
    expect(screen.getByText('If no one answers, the session is declined in 0:30.')).toBeInTheDocument();
    // A sleep past the deadline: 0:00, never negative, and the card does not act.
    rerender(<ConsentCard view={consent} nowMs={NOW + 95_000} onAction={onAction} onHide={onHide} />);
    expect(screen.getByText('If no one answers, the session is declined in 0:00.')).toBeInTheDocument();
    expect(onAction).not.toHaveBeenCalled();
  });

  it('announces the countdown at 60, 30 and 10 s only', () => {
    const long = { ...consent, countdownDeadlineUnixMs: NOW + 75_000 };
    const { rerender, onAction, onHide } = renderConsent(long);
    const at = (s: number) =>
      rerender(<ConsentCard view={long} nowMs={NOW + 75_000 - s * 1000} onAction={onAction} onHide={onHide} />);
    const announced: string[] = [];
    for (let s = 74; s >= 0; s--) {
      at(s);
      const text = screen.getByTestId('prompt-announce').textContent ?? '';
      if (text && announced[announced.length - 1] !== text) announced.push(text);
    }
    expect(announced).toEqual(['60 seconds remaining', '30 seconds remaining', '10 seconds remaining']);
  });

  it('is drawn by the card window for a consent prompt: Deny focused, Esc sends deny through the api', async () => {
    const api: PromptCardApi = {
      getView: vi.fn(async () => consent),
      action: vi.fn(async () => {}),
      hide: vi.fn(async () => {}),
      subscribe: vi.fn(async () => () => {}),
    };
    render(
      <PromptCardWindow
        promptId={consent.promptId}
        api={api}
        clock={() => NOW}
        retryDelayMs={0}
        identityEnabled={false}
      />,
    );
    const deny = await screen.findByRole('button', { name: 'Deny' });
    expect(document.activeElement).toBe(deny);
    await act(async () => {
      fireEvent.keyDown(window, { key: 'Escape' });
    });
    expect(api.action).toHaveBeenCalledWith(consent.promptId, 'deny', 'keyboard');
    expect(api.hide).not.toHaveBeenCalled();
  });
});
