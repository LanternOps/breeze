import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import SiteList, { SITE_SEARCH_THRESHOLD, type Site } from './SiteList';

const site = (n: number): Site => ({ id: `s${n}`, name: `Site ${n}`, timezone: 'UTC', deviceCount: n });
const few = [site(1)];
const many = Array.from({ length: SITE_SEARCH_THRESHOLD }, (_, i) => site(i + 1));

describe('SiteList', () => {
  it('keeps its card chrome, h2 heading, count and search', () => {
    render(<SiteList sites={few} />);

    expect(screen.getByRole('heading', { level: 2, name: 'Sites' })).toBeInTheDocument();
    expect(screen.getByText('1 of 1 sites')).toBeInTheDocument();
    expect(screen.getByRole('searchbox', { name: 'Search sites' })).toBeInTheDocument();
  });

  it('shows the address as line1 · city, state and the contact with a tel: link', () => {
    render(
      <SiteList
        sites={[
          {
            ...site(1),
            address: { line1: '12 Harbour Rd', line2: 'Unit 4', city: 'Halifax', state: 'NS', postalCode: 'B3H 1A1', country: 'CA' },
            contact: { name: 'Pat Lee', phone: '+1 902 555 0100' },
          },
        ]}
      />,
    );

    expect(screen.getAllByText('12 Harbour Rd · Halifax, NS').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Pat Lee').length).toBeGreaterThan(0);
    expect(screen.getAllByRole('link', { name: '+1 902 555 0100' })[0].getAttribute('href')).toBe('tel:+1 902 555 0100');
  });

  it('falls back to an em dash with no address and no contact', () => {
    render(<SiteList sites={few} />);

    expect(screen.getAllByText('—').length).toBeGreaterThanOrEqual(2);
  });

  it('ignores non-string address values', () => {
    render(<SiteList sites={[{ ...site(1), address: { line1: { nested: true }, city: 'Austin', state: 7 } }]} />);

    expect(screen.getAllByText('Austin').length).toBeGreaterThan(0);
    expect(screen.queryByText(/object/)).toBeNull();
  });
});
