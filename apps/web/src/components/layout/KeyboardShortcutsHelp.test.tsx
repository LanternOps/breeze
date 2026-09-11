import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';

import KeyboardShortcutsHelp from './KeyboardShortcutsHelp';
import { GO_TO_SHORTCUTS } from '../../lib/keyboard/goToShortcuts';
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
