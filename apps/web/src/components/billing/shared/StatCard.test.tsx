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
  it('renders a card WITHOUT `detail` byte-identically to the pre-slot markup', () => {
    render(<StatCard label="Outstanding" value="$1,200.00" hint="4 active" testId="out" />);
    // The optional slot must be additive: an undefined `detail` may not emit a
    // wrapper, a whitespace node, or reorder anything around the figure.
    expect(screen.getByTestId('out').outerHTML).toBe(
      '<div class="rounded-lg border px-4 py-3 text-left bg-card" data-testid="out">'
      + '<div class="text-xs text-muted-foreground">Outstanding</div>'
      + '<div class="mt-0.5 text-lg font-semibold tabular-nums text-foreground">$1,200.00</div>'
      + '<div class="text-xs text-muted-foreground">4 active</div>'
      + '</div>',
    );
  });

  it('renders `detail` between the figure and the hint', () => {
    render(
      <StatCard
        label="Outstanding"
        value="$1,200.00"
        detail={<span data-testid="approx">approx line</span>}
        hint="4 active"
        testId="out"
      />,
    );
    const card = screen.getByTestId('out');
    const order = [...card.children].map((el) => el.textContent);
    expect(order).toEqual(['Outstanding', '$1,200.00', 'approx line', '4 active']);
    expect(screen.getByTestId('approx')).toBeInTheDocument();
  });

  it('renders `detail` on a clickable card too', () => {
    render(
      <StatCard label="Drafts" value={3} onClick={() => {}} detail={<span data-testid="d">d</span>} testId="drafts" />,
    );
    const card = screen.getByTestId('drafts');
    expect(card.tagName).toBe('BUTTON');
    expect(card).toContainElement(screen.getByTestId('d'));
  });
});
