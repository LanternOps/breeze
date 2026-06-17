import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useHelpStore } from '@/stores/helpStore';
import HelpPanel from './HelpPanel';

// Mock the aiStore lazy import inside helpStore
vi.mock('@/stores/aiStore', () => ({
  useAiStore: Object.assign(vi.fn(), { getState: () => ({ close: vi.fn() }) }),
}));

// Stub open to suppress navigation side-effects
vi.stubGlobal('open', vi.fn());

beforeEach(() => {
  useHelpStore.setState({ isOpen: false });
});

describe('HelpPanel keyboard shortcut', () => {
  it('Cmd+Shift+H (uppercase H) toggles the panel open', () => {
    render(<HelpPanel />);
    expect(useHelpStore.getState().isOpen).toBe(false);

    window.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'H', metaKey: true, shiftKey: true, bubbles: true })
    );

    expect(useHelpStore.getState().isOpen).toBe(true);
  });

  it('Ctrl+Shift+h (lowercase) also toggles', () => {
    render(<HelpPanel />);
    window.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'h', ctrlKey: true, shiftKey: true, bubbles: true })
    );
    expect(useHelpStore.getState().isOpen).toBe(true);
  });

  it('Cmd+Shift+H while open closes the panel', () => {
    useHelpStore.setState({ isOpen: true });
    render(<HelpPanel />);

    window.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'H', metaKey: true, shiftKey: true, bubbles: true })
    );

    expect(useHelpStore.getState().isOpen).toBe(false);
  });

  it('does not trigger without shift', () => {
    render(<HelpPanel />);
    window.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'h', metaKey: true, bubbles: true })
    );
    expect(useHelpStore.getState().isOpen).toBe(false);
  });
});

// #1419: the off-canvas shell stays mounted (transition:persist), so when
// collapsed it must be inert + pointer-events-none — otherwise it intercepts
// clicks on wide layouts and exposes an off-viewport Close control.
describe('HelpPanel collapsed-shell interactivity', () => {
  it('is inert and pointer-events-none when collapsed', () => {
    useHelpStore.setState({ isOpen: false });
    render(<HelpPanel />);
    const shell = screen.getByTestId('help-panel');
    expect(shell).toHaveAttribute('inert');
    expect(shell.className).toContain('pointer-events-none');
  });

  it('is interactive (no inert, no pointer-events-none) when open', () => {
    useHelpStore.setState({ isOpen: true });
    render(<HelpPanel />);
    const shell = screen.getByTestId('help-panel');
    expect(shell).not.toHaveAttribute('inert');
    expect(shell.className).not.toContain('pointer-events-none');
  });
});
