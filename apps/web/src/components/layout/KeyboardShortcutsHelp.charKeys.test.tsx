import { render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { useAuthStore } from '../../stores/auth';
import { useUiStore } from '../../stores/uiStore';
import KeyboardShortcutsHelp from './KeyboardShortcutsHelp';

function setPrefs(preferences: Record<string, unknown>) {
  useAuthStore.setState({ user: { id: 'u1', email: 'a@b.c', name: 'A', preferences } } as never);
}

beforeEach(() => useUiStore.setState({ isShortcutsHelpOpen: true }));
afterEach(() => {
  useAuthStore.setState({ user: null } as never);
  useUiStore.setState({ isShortcutsHelpOpen: false });
});

describe('KeyboardShortcutsHelp character-key state (#9348)', () => {
  it('shows on by default and links to the setting', () => {
    setPrefs({});
    render(<KeyboardShortcutsHelp />);
    const line = screen.getByTestId('char-key-state');
    expect(line.textContent).toMatch(/are on/i);
    expect(line.querySelector('a')?.getAttribute('href')).toBe('/settings/profile#character-key-shortcuts');
  });

  it('shows off when the preference is false', () => {
    setPrefs({ characterKeyShortcuts: false });
    render(<KeyboardShortcutsHelp />);
    expect(screen.getByTestId('char-key-state').textContent).toMatch(/are off/i);
  });
});
