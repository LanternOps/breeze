import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';

import KeyboardShortcutsHelp from './KeyboardShortcutsHelp';
import { GO_TO_SHORTCUTS } from '../../lib/keyboard/goToShortcuts';
import { QUEUE_SHORTCUTS, queueKeyLabel } from '../tickets/queueShortcuts';
import { useUiStore } from '../../stores/uiStore';
import { i18n } from '../../lib/i18n';

beforeEach(async () => {
  useUiStore.setState({ isShortcutsHelpOpen: false, isCommandPaletteOpen: false });
  await i18n.changeLanguage('en');
});

describe('KeyboardShortcutsHelp', () => {
  it('stays out of the DOM until opened', () => {
    render(<KeyboardShortcutsHelp />);
    expect(screen.queryByRole('dialog')).toBeNull();
    act(() => { useUiStore.getState().openShortcutsHelp(); });
    expect(screen.getByRole('dialog', { name: 'Keyboard shortcuts' })).toBeInTheDocument();
  });

  it('lists every go-to chord with its destination label', () => {
    render(<KeyboardShortcutsHelp />);
    act(() => { useUiStore.getState().openShortcutsHelp(); });
    const rows = screen.getAllByTestId('shortcut-goto');
    expect(rows).toHaveLength(GO_TO_SHORTCUTS.length);
    for (const [i, s] of GO_TO_SHORTCUTS.entries()) {
      expect(rows[i]).toHaveTextContent(i18n.t(s.labelKey, { ns: 'common' }));
      expect(within(rows[i]).getAllByText(s.key, { selector: 'kbd' })).toHaveLength(1);
    }
    expect(screen.getByText('Devices & Assets')).toBeInTheDocument();
  });

  it('documents the single-key and modifier shortcuts', () => {
    render(<KeyboardShortcutsHelp />);
    act(() => { useUiStore.getState().openShortcutsHelp(); });
    for (const key of ['/', '[', '?', 'Esc', 'Ctrl+K', 'Ctrl+Shift+H']) {
      expect(screen.getByText(key, { selector: 'kbd' })).toBeInTheDocument();
    }
  });

  it('lists the org switcher and AI sidebar chords', () => {
    render(<KeyboardShortcutsHelp />);
    act(() => { useUiStore.getState().openShortcutsHelp(); });
    expect(screen.getByText('Ctrl+O', { selector: 'kbd' })).toBeInTheDocument();
    expect(screen.getByText('Ctrl+Shift+A', { selector: 'kbd' })).toBeInTheDocument();
    expect(screen.getByText('Open the organization switcher')).toBeInTheDocument();
    expect(screen.getByText('Toggle Breeze AI')).toBeInTheDocument();
  });

  // The ticket queue's single keys were undiscoverable: the card listed only
  // the g/c chords. Rows come from the table the queue hook dispatches from.
  it('lists every ticket-queue shortcut in its own section', () => {
    render(<KeyboardShortcutsHelp />);
    act(() => { useUiStore.getState().openShortcutsHelp(); });
    const section = screen.getByRole('region', { name: 'Tickets queue' });
    const rows = within(section).getAllByTestId('shortcut-queue');
    expect(rows).toHaveLength(QUEUE_SHORTCUTS.length);
    for (const [i, s] of QUEUE_SHORTCUTS.entries()) {
      const label = i18n.t(s.labelKey, { ns: 'common' });
      expect(label).not.toBe(s.labelKey);
      expect(rows[i]).toHaveTextContent(label);
      for (const key of s.keys) {
        expect(within(rows[i]).getByText(queueKeyLabel(key), { selector: 'kbd' })).toBeInTheDocument();
      }
    }
    expect(within(section).getByText('Next ticket')).toBeInTheDocument();
    expect(within(section).getByText('Add to or remove from the bulk selection')).toBeInTheDocument();
  });

  it('closes from its button and from Escape', () => {
    render(<KeyboardShortcutsHelp />);
    act(() => { useUiStore.getState().openShortcutsHelp(); });
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(useUiStore.getState().isShortcutsHelpOpen).toBe(false);

    act(() => { useUiStore.getState().openShortcutsHelp(); });
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
    expect(useUiStore.getState().isShortcutsHelpOpen).toBe(false);
  });
});
