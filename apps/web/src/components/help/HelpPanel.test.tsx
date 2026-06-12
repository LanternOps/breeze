import { render } from '@testing-library/react';
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
