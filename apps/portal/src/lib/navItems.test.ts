import { describe, it, expect } from 'vitest';
import { buildPortalNavItems } from './navItems';

describe('buildPortalNavItems — enable_tickets nav gating (#2345)', () => {
  it('hides the Tickets entry when enableTickets is explicitly false', () => {
    const items = buildPortalNavItems({ enableTickets: false });
    expect(items.map((i) => i.href)).not.toContain('/tickets');
    // Only Tickets is affected — the rest of the nav is untouched.
    expect(items.map((i) => i.href)).toEqual([
      '/devices',
      '/quotes',
      '/invoices',
      '/assets',
      '/profile'
    ]);
  });

  it('shows Tickets when enableTickets is true', () => {
    expect(buildPortalNavItems({ enableTickets: true }).map((i) => i.href)).toContain('/tickets');
  });

  it('fails OPEN: shows Tickets when the flag is absent (no branding row / default branding)', () => {
    expect(buildPortalNavItems({}).map((i) => i.href)).toContain('/tickets');
    expect(
      buildPortalNavItems({ enableTickets: undefined }).map((i) => i.href)
    ).toContain('/tickets');
  });
});
