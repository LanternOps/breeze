// apps/web/src/components/shared/ScopeBadge.test.tsx
import { render, screen } from '@testing-library/react';
import '../../lib/i18n';
import { describe, it, expect, vi, afterEach } from 'vitest';
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

  describe('owner-less rows (#2600)', () => {
    afterEach(() => vi.restoreAllMocks());

    it('warns in dev when a non-system row has neither orgId nor partnerId (would silently mislabel as an org)', () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      render(<ScopeBadge orgId={null} partnerId={null} isSystem={false} />);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('ScopeBadge'), expect.anything());
    });

    it('does not warn for well-formed rows', () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      render(<ScopeBadge orgId={null} partnerId="p1" isSystem={false} />);
      render(<ScopeBadge orgId={null} partnerId={null} isSystem />);
      render(<ScopeBadge orgId="o1" partnerId={null} isSystem={false} orgName="Acme" />);
      expect(warn).not.toHaveBeenCalled();
    });
  });
});
