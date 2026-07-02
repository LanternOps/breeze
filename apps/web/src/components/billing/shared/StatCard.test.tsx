import { render, screen, fireEvent } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { StatCard } from './StatCard';

describe('StatCard', () => {
  it('renders a static card as a non-interactive div', () => {
    render(<StatCard label="Est. monthly recurring" value="$1,200.00" hint="4 active" testId="mrr" />);
    const card = screen.getByTestId('mrr');
    expect(card.tagName).toBe('DIV');
    expect(card).toHaveTextContent('Est. monthly recurring');
    expect(card).toHaveTextContent('$1,200.00');
    expect(card).toHaveTextContent('4 active');
  });

  it('renders a clickable card as a button and fires onClick', () => {
    const onClick = vi.fn();
    render(<StatCard label="Drafts" value={3} onClick={onClick} testId="drafts" />);
    const card = screen.getByTestId('drafts');
    expect(card.tagName).toBe('BUTTON');
    fireEvent.click(card);
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it('reflects the active filter via aria-pressed', () => {
    const { rerender } = render(<StatCard label="Drafts" value={3} onClick={() => {}} active={false} testId="drafts" />);
    expect(screen.getByTestId('drafts')).toHaveAttribute('aria-pressed', 'false');
    rerender(<StatCard label="Drafts" value={3} onClick={() => {}} active testId="drafts" />);
    expect(screen.getByTestId('drafts')).toHaveAttribute('aria-pressed', 'true');
  });

  it('does not fire on a static card (no onClick, no button)', () => {
    render(<StatCard label="Outstanding" value="$0.00" testId="out" />);
    const card = screen.getByTestId('out');
    // A static card must not be a button — it carries no filter affordance.
    expect(card.tagName).not.toBe('BUTTON');
  });
});
