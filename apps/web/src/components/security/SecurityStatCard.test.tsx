import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { Shield } from 'lucide-react';

import SecurityStatCard from './SecurityStatCard';

function card(props: Partial<Parameters<typeof SecurityStatCard>[0]> = {}) {
  return <SecurityStatCard icon={Shield} label="Stat" value={7} {...props} />;
}

describe('SecurityStatCard', () => {
  it('renders label, value, and detail with no interactive styling by default', () => {
    const { container } = render(card({ detail: '7 things' }));
    expect(screen.getByText('Stat')).toBeInTheDocument();
    expect(screen.getByText('7')).toBeInTheDocument();
    expect(screen.getByText('7 things')).toBeInTheDocument();
    const root = container.firstElementChild as HTMLElement;
    // Additive props default off — existing consumers keep the static card.
    expect(root.className).not.toContain('hover:');
    expect(root).not.toHaveAttribute('data-active');
  });

  it('adds a hover affordance when interactive', () => {
    const { container } = render(card({ interactive: true }));
    const root = container.firstElementChild as HTMLElement;
    expect(root.className).toContain('hover:shadow-sm');
    expect(root.className).toContain('hover:border-primary/40');
  });

  it('renders the selected treatment (and data-active hook) when active', () => {
    const { container } = render(card({ interactive: true, active: true }));
    const root = container.firstElementChild as HTMLElement;
    expect(root.className).toContain('border-primary');
    expect(root.className).toContain('bg-primary/5');
    expect(root).toHaveAttribute('data-active', 'true');
  });

  it('still shows the loading skeleton with the new props set', () => {
    render(card({ interactive: true, active: true, loading: true }));
    expect(screen.getByTestId('stat-card-skeleton')).toBeInTheDocument();
    expect(screen.queryByText('7')).toBeNull();
  });
});
