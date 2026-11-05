import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { StatusBadge } from './ui';
import { statusBadgeClass } from './types';

describe('StatusBadge', () => {
  it('renders Withdrawn for a withdrawn request, in the same neutral family as expired', () => {
    render(<StatusBadge status="withdrawn" />);
    expect(screen.getByText('Withdrawn')).toBeInTheDocument();
    expect(statusBadgeClass('withdrawn')).toBe(statusBadgeClass('expired'));
  });
});
