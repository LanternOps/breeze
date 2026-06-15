// apps/web/src/components/layout/PageScopeIndicator.test.tsx
import { render, screen } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import { PageScopeIndicator } from './PageScopeIndicator';

describe('PageScopeIndicator', () => {
  it('says shared across all organizations on a global route', () => {
    render(<PageScopeIndicator pathname="/scripts" orgName="Acme Corp" />);
    expect(screen.getByText(/shared across all organizations/i)).toBeInTheDocument();
  });
  it('shows the active org on a scoped route', () => {
    render(<PageScopeIndicator pathname="/devices" orgName="Acme Corp" />);
    expect(screen.getByText(/acme corp/i)).toBeInTheDocument();
  });
});
