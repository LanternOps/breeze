import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import AccessDenied from './AccessDenied';

describe('AccessDenied', () => {
  it('renders the default permission-denied message', () => {
    render(<AccessDenied />);
    expect(screen.getByTestId('access-denied')).toBeInTheDocument();
    expect(screen.getByText('Access denied')).toBeInTheDocument();
    expect(screen.getByText("You don't have permission to view this.")).toBeInTheDocument();
    // It is an alert, not a retry surface — no retry button.
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });

  it('renders a custom message and testId', () => {
    render(<AccessDenied message="You don't have permission to view invoices." testId="invoices-denied" />);
    expect(screen.getByTestId('invoices-denied')).toBeInTheDocument();
    expect(screen.getByText("You don't have permission to view invoices.")).toBeInTheDocument();
  });
});
