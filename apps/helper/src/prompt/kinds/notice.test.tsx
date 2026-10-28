// @vitest-environment jsdom
import { fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { NotificationsTab } from '../NotificationsTab';
import { PromptCard } from '../PromptCard';
import { PromptCardWindow, type PromptCardApi } from '../PromptCardWindow';
import type { PromptView } from '../types';
import { NoticeCard } from './notice';
import { cardForKind } from './registry';

const NOW = new Date(2026, 9, 27, 9, 0, 0).getTime();

/** What Rust hands the card for the `show.notice.json` golden fixture. */
const notice: PromptView = {
  promptId: 'notice:safe_mode:7f3c2a10',
  kind: 'notice.info',
  kindVersion: 1,
  state: 'pending',
  presentation: 'card',
  copy: {
    title: 'Your computer restarted in safe mode',
    body: 'Your IT support team restarted this computer in safe mode to finish a repair.',
  },
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

const tcc: PromptView = {
  ...notice,
  promptId: 'notice:tcc:0a1b2c3d',
  copy: { title: 'Breeze needs a permission', body: 'Turn on Screen Recording for Breeze Assist.' },
  actions: [
    { id: 'open_settings', label: 'Open Settings', role: 'neutral' },
    { id: 'ok', label: 'OK', role: 'safe' },
  ],
};

function api(view: PromptView): PromptCardApi {
  return {
    getView: vi.fn(async () => view),
    action: vi.fn(async () => {}),
    hide: vi.fn(async () => {}),
    subscribe: vi.fn(async () => () => {}),
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('notice.info card (#10190 W04)', () => {
  it('notice card is non-activating and lists the entry', async () => {
    const a = api(notice);
    render(<PromptCardWindow promptId={notice.promptId} api={a} retryDelayMs={0} />);
    const card = await screen.findByTestId('prompt-card');
    // Informational: a dialog, never an alertdialog, and it takes no focus.
    expect(card).toHaveAttribute('role', 'dialog');
    expect(card).toHaveAttribute('data-activation', 'none');
    expect(card).toHaveAttribute('data-kind', 'notice.info');
    expect(document.activeElement).toBe(document.body);
    // Still keyboard-reachable: the safe action is the first tab stop, and Esc is OK.
    const ok = within(card).getByRole('button', { name: 'OK' });
    expect(within(card).getAllByRole('button')[0]).toBe(ok);
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(a.action).toHaveBeenCalledWith(notice.promptId, 'ok', 'keyboard');
    // The same entry is in the Notifications tab.
    render(<NotificationsTab entries={[notice]} onAction={vi.fn()} clock={() => NOW} />);
    const item = screen.getByRole('listitem');
    expect(item).toHaveTextContent('Your computer restarted in safe mode');
    expect(item).toHaveAttribute('data-kind', 'notice.info');
  });

  it('open_settings action sends prompt_action', async () => {
    const a = api(tcc);
    render(<PromptCardWindow promptId={tcc.promptId} api={a} retryDelayMs={0} />);
    const open = await screen.findByRole('button', { name: 'Open Settings' });
    // Safe first in the tab order, then the neutral Open Settings.
    expect(screen.getAllByRole('button').map((b) => b.textContent)).toEqual(['OK', 'Open Settings']);
    fireEvent.click(open, { detail: 1 });
    expect(a.action).toHaveBeenCalledWith(tcc.promptId, 'open_settings', 'click');
    expect(a.action).toHaveBeenCalledTimes(1);
  });

  it('picks the notice card for notice.info and the generic card otherwise', () => {
    expect(cardForKind('notice.info')).toBe(NoticeCard);
    expect(cardForKind('elevation.request')).toBe(PromptCard);
    expect(cardForKind('future.kind')).toBe(PromptCard);
    expect(cardForKind('constructor')).toBe(PromptCard);
  });

  it('a decision card still takes focus on its safe action (unchanged)', () => {
    const restart: PromptView = { ...notice, promptId: 'restart:42', kind: 'restart.prompt' };
    render(<PromptCard view={restart} nowMs={NOW} onAction={vi.fn()} onHide={vi.fn()} />);
    expect(screen.getByTestId('prompt-card')).toHaveAttribute('role', 'alertdialog');
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'OK' }));
  });
});
