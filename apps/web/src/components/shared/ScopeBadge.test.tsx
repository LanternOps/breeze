// apps/web/src/components/shared/ScopeBadge.test.tsx
import { render, screen } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import { ScopeBadge } from './ScopeBadge';

describe('ScopeBadge', () => {
  it('renders Partner-wide for org-NULL + partner-set records', () => {
    render(<ScopeBadge orgId={null} partnerId="p1" isSystem={false} />);
    expect(screen.getByText(/partner-wide/i)).toBeInTheDocument();
  });
  it('renders System for system records', () => {
    render(<ScopeBadge orgId={null} partnerId={null} isSystem />);
    expect(screen.getByText(/system/i)).toBeInTheDocument();
  });
  it('renders the org name for org-scoped records', () => {
    render(<ScopeBadge orgId="o1" partnerId="p1" isSystem={false} orgName="Acme Corp" />);
    expect(screen.getByText('Acme Corp')).toBeInTheDocument();
  });
});
