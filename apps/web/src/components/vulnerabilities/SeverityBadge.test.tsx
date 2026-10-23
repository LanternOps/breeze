import { describe, it, expect } from 'vitest';
import '@/lib/i18n';
import { render, screen } from '@testing-library/react';

import { SeverityBadge } from './SeverityBadge';

describe('SeverityBadge', () => {
  it('renders the ranked severities', () => {
    render(<SeverityBadge severity="critical" />);
    expect(screen.getByText('Critical')).toBeInTheDocument();
  });

  // #9533: a known-exploited CVE with no NVD score yet read "Unknown" in grey
  // next to the red KEV badge, as if Breeze could not tell. It is unscored.
  it('labels a missing severity "Unscored", not "Unknown"', () => {
    render(<SeverityBadge severity={null} />);
    const pill = screen.getByText('Unscored');
    expect(pill).toHaveAttribute('title', expect.stringContaining('No NVD severity'));
    expect(screen.queryByText(/unknown/i)).toBeNull();
  });

  it('treats an empty severity string as unscored too', () => {
    render(<SeverityBadge severity="" />);
    expect(screen.getByText('Unscored')).toBeInTheDocument();
  });

  it('passes an unrecognised vendor severity through verbatim', () => {
    render(<SeverityBadge severity="Important" />);
    expect(screen.getByText('Important')).toBeInTheDocument();
  });
});
