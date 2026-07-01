import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { StatusPill } from './StatusPill';
import { STATUS_PILL } from '../invoiceTypes';

describe('StatusPill', () => {
  it('renders the visible label', () => {
    render(<StatusPill role="success" label="Paid" />);
    expect(screen.getByText('Paid')).toBeInTheDocument();
  });

  it('renders a visually-hidden "Status:" prefix for screen readers', () => {
    render(<StatusPill role="success" label="Paid" />);
    const prefix = screen.getByText('Status:');
    expect(prefix).toHaveClass('sr-only');
  });

  it('does NOT put aria-label on the (non-interactive) span — uses sr-only text instead', () => {
    const { container } = render(<StatusPill role="info" label="Sent" />);
    const pill = container.firstElementChild as HTMLElement;
    expect(pill.getAttribute('aria-label')).toBeNull();
  });

  it('applies the STATUS_PILL classes for the given role', () => {
    render(<StatusPill role="warning" label="Overdue" testId="pill" />);
    const pill = screen.getByTestId('pill');
    for (const cls of STATUS_PILL.warning.split(' ')) {
      expect(pill.className).toContain(cls);
    }
  });

  it('passes through testId and an extra className (e.g. line-through)', () => {
    render(<StatusPill role="neutral" label="Void" className="line-through" testId="void-pill" />);
    const pill = screen.getByTestId('void-pill');
    expect(pill).toHaveClass('line-through');
    expect(pill).toHaveTextContent('Void');
  });
});
