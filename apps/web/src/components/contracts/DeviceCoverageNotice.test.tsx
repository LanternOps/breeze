import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import DeviceCoverageNotice, { formatUncoveredBreakdown } from './DeviceCoverageNotice';

describe('DeviceCoverageNotice (#3205)', () => {
  it('renders nothing when not applicable', () => {
    const { container } = render(<DeviceCoverageNotice uncovered={null} />);
    expect(container).toBeEmptyDOMElement();
  });
  it('confirms full coverage at zero', () => {
    render(<DeviceCoverageNotice uncovered={{ total: 0, byRole: {} }} />);
    expect(screen.getByTestId('contract-coverage-ok')).toBeInTheDocument();
  });
  it('warns with the count and a per-role breakdown, largest first, using role labels', () => {
    render(<DeviceCoverageNotice uncovered={{ total: 5, byRole: { printer: 2, unknown: 3 } }} />);
    const el = screen.getByTestId('contract-coverage-warning');
    expect(el.textContent).toContain('5');
    expect(el.textContent).toContain('3 Unknown, 2 Printer');
  });
  it('formatUncoveredBreakdown sorts descending and labels roles', () => {
    expect(formatUncoveredBreakdown({ access_point: 1, server: 4 })).toBe('4 Server, 1 Access Point');
  });
});
