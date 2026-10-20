import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { SavedViewsMenu } from './SavedViewsMenu';

vi.mock('../../stores/auth', () => ({
  fetchWithAuth: vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ data: [] }) })),
}));
vi.mock('../../stores/orgStore', () => ({
  useOrgStore: (selector: (s: { currentOrgId: string | null }) => unknown) => selector({ currentOrgId: null }),
}));
vi.mock('../shared/Toast', () => ({ showToast: vi.fn() }));

// #9037: the Views popover shared the Columns menu's problems — role="menu"
// with no menu items, no Escape, and clipped off the left edge at 390px.
describe('SavedViewsMenu popover (#9037)', () => {
  it('is a labelled non-modal dialog advertised by its trigger', () => {
    render(<SavedViewsMenu value={null} onApply={vi.fn()} />);
    const trigger = screen.getByTestId('saved-views-button');
    expect(trigger).toHaveAttribute('aria-haspopup', 'dialog');
    fireEvent.click(trigger);
    const panel = screen.getByTestId('saved-views-menu');
    expect(panel).toHaveAttribute('role', 'dialog');
    expect(panel).toHaveAttribute('aria-modal', 'false');
    expect(panel).toHaveAccessibleName();
  });

  it('closes on Escape and returns focus to the trigger', () => {
    render(<SavedViewsMenu value={null} onApply={vi.fn()} />);
    const trigger = screen.getByTestId('saved-views-button');
    fireEvent.click(trigger);
    fireEvent.keyDown(screen.getByTestId('saved-views-menu'), { key: 'Escape' });
    expect(screen.queryByTestId('saved-views-menu')).toBeNull();
    expect(trigger).toHaveFocus();
  });

  it('pins to the viewport gutters below sm instead of hanging off the left edge', () => {
    render(<SavedViewsMenu value={null} onApply={vi.fn()} />);
    fireEvent.click(screen.getByTestId('saved-views-button'));
    const panel = screen.getByTestId('saved-views-menu');
    expect(panel).toHaveClass('max-sm:fixed', 'max-sm:inset-x-4', 'max-sm:w-auto');
    expect(panel.innerHTML).not.toContain('text-[10px]');
  });
});
