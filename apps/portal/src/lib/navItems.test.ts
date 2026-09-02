import { describe, it, expect } from 'vitest';
import { buildPortalNavItems } from './navItems';

describe('buildPortalNavItems — enable_tickets nav gating (#2345)', () => {
  it('hides the Tickets entry when enableTickets is explicitly false', () => {
    const items = buildPortalNavItems({ enableTickets: false, enableAssetCheckout: true });
    expect(items.map((i) => i.href)).not.toContain('/tickets');
    // Only Tickets is affected — the rest of the nav is untouched.
    expect(items.map((i) => i.href)).toEqual([
      '/quotes',
      '/invoices',
      '/devices',
      '/assets',
      '/profile'
    ]);
  });

  it('leads with what a customer actually came for', () => {
    // A portal customer approves a proposal or pays a bill; /devices is a
    // read-only inventory and used to sit first.
    const items = buildPortalNavItems({});
    expect(items[0]).toEqual({ label: 'Proposals', href: '/quotes' });
    expect(items[1]).toEqual({ label: 'Invoices', href: '/invoices' });
  });

  it('labels /quotes "Proposals", matching every page it leads to', () => {
    const quotes = buildPortalNavItems({}).find((i) => i.href === '/quotes');
    expect(quotes?.label).toBe('Proposals');
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

describe('buildPortalNavItems — Equipment (/assets) gating', () => {
  it('shows Equipment only when asset checkout is enabled', () => {
    expect(
      buildPortalNavItems({ enableAssetCheckout: true }).map((i) => i.href)
    ).toContain('/assets');
  });

  // Fails CLOSED, unlike Tickets: /assets reads the same devices table as
  // /devices minus a column, so without checkout it is a second nav word for
  // the same machines.
  it.each([{}, { enableAssetCheckout: false }, { enableAssetCheckout: undefined }])(
    'hides Equipment when checkout is not explicitly enabled (%j)',
    (branding) => {
      expect(buildPortalNavItems(branding).map((i) => i.href)).not.toContain('/assets');
    }
  );
});
