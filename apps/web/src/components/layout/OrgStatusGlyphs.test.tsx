import { render, screen } from '@testing-library/react';
import '../../lib/i18n';
import { describe, expect, it } from 'vitest';

import { OrgStatusBadge, OrgStatusDot, STATUS_DOT_CLASS } from './OrgStatusGlyphs';
import { FALLBACK_STATUS_CLASS, statusColors } from '@/lib/orgStatus';

describe('OrgStatusDot', () => {
  it('the dot is absent for active', () => {
    render(<OrgStatusDot status="active" />);
    expect(screen.queryByTestId('org-status-dot')).toBeNull();
  });

  it('trial is amber, suspended red, churned muted, each titled with the status label', () => {
    const { rerender } = render(<OrgStatusDot status="trial" />);
    let dot = screen.getByTestId('org-status-dot');
    expect(dot.className).toContain('bg-warning');
    expect(dot.getAttribute('title')).toBe('Trial');
    expect(dot.getAttribute('aria-label')).toBe('Trial');
    expect(dot.getAttribute('role')).toBe('img');

    rerender(<OrgStatusDot status="suspended" />);
    dot = screen.getByTestId('org-status-dot');
    expect(dot.className).toContain('bg-destructive');
    expect(dot.getAttribute('title')).toBe('Suspended');

    rerender(<OrgStatusDot status="churned" />);
    dot = screen.getByTestId('org-status-dot');
    expect(dot.className).toContain('bg-muted-foreground');
    expect(dot.getAttribute('title')).toBe('Churned');
    expect(STATUS_DOT_CLASS.trial).toBe('bg-warning');
  });

  it('an unknown status gets the muted dot and its raw value as label', () => {
    render(<OrgStatusDot status="inactive" />);
    const dot = screen.getByTestId('org-status-dot');
    expect(dot.className).toContain('bg-muted-foreground');
    expect(dot.getAttribute('title')).toBe('inactive');
  });
});

describe('OrgStatusBadge', () => {
  it('keeps the shared status colours', () => {
    const { rerender } = render(<OrgStatusBadge status="trial" />);
    for (const cls of statusColors.trial.split(' ')) {
      expect(screen.getByText('Trial').className).toContain(cls);
    }
    rerender(<OrgStatusBadge status="inactive" />);
    for (const cls of FALLBACK_STATUS_CLASS.split(' ')) {
      expect(screen.getByText('Inactive').className).toContain(cls);
    }
  });
});
