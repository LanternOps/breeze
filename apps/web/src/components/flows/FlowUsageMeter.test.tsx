/** Tool Catalog W05 (#5220) Task D3 — usage meter and the cap refusal banner. */
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { FlowRefusalBanner, FlowUsageMeter } from './FlowUsageMeter';

describe('FlowUsageMeter', () => {
  it("shows this month's runs against the flow and owner caps", () => {
    render(<FlowUsageMeter usage={{ periodKey: '2026-10', flowRuns: 1234, flowCap: 10_000, ownerRuns: 99_000, ownerCap: 100_000 }} />);
    expect(screen.getByTestId('flow-usage-period').textContent).toContain('2026-10');
    expect(screen.getByTestId('flow-usage-flow').textContent).toMatch(/1,234 of 10,000/);
    expect(screen.getByTestId('flow-usage-owner').textContent).toMatch(/99,000 of 100,000/);
    // Near the cap the owner bar is highlighted.
    expect(screen.getByTestId('flow-usage-owner-bar').getAttribute('data-level')).toBe('high');
    expect(screen.getByTestId('flow-usage-flow-bar').getAttribute('data-level')).toBe('ok');
    expect(screen.getByTestId('flow-usage-limits-link').getAttribute('href')).toBe('/settings/flow-limits');
  });

  it('a cap that is reached reads as full', () => {
    render(<FlowUsageMeter usage={{ periodKey: '2026-10', flowRuns: 5, flowCap: 5, ownerRuns: 5, ownerCap: 100 }} />);
    expect(screen.getByTestId('flow-usage-flow-bar').getAttribute('data-level')).toBe('full');
  });
});

describe('FlowRefusalBanner', () => {
  it('shows the refusal code as localized copy and when it last happened', () => {
    render(<FlowRefusalBanner refusal={{ at: '2026-10-25T02:00:00.000Z', code: 'flow_monthly_cap_reached' }} />);
    const banner = screen.getByTestId('flow-refusal-banner');
    expect(banner.textContent).toMatch(/monthly run limit/i);
    expect(banner.textContent).toMatch(/stays enabled/i);
    expect(banner.textContent).not.toContain('flow_monthly_cap_reached');
  });

  it('renders nothing without a refusal', () => {
    const { container } = render(<FlowRefusalBanner refusal={null} />);
    expect(container.textContent).toBe('');
  });
});
