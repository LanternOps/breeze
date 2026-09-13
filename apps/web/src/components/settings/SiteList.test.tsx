import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import SiteList, { SITE_SEARCH_THRESHOLD, type Site } from './SiteList';

const site = (n: number): Site => ({ id: `s${n}`, name: `Site ${n}`, timezone: 'UTC', deviceCount: n });
const few = [site(1)];
const many = Array.from({ length: SITE_SEARCH_THRESHOLD }, (_, i) => site(i + 1));

describe('SiteList', () => {
  it('card variant (default) keeps its own card chrome, h2 heading, count and search', () => {
    render(<SiteList sites={few} />);

    expect(screen.getByRole('heading', { level: 2, name: 'Sites' })).toBeInTheDocument();
    expect(screen.getByText('1 of 1 sites')).toBeInTheDocument();
    expect(screen.getByRole('searchbox', { name: 'Search sites' })).toBeInTheDocument();
  });

  it('section variant renders flat with an h3 and hides count + search below the threshold', () => {
    const { container } = render(<SiteList sites={few} variant="section" />);

    expect(screen.getByRole('heading', { level: 3, name: 'Sites' })).toBeInTheDocument();
    expect(screen.queryByText(/of \d+ sites/)).not.toBeInTheDocument();
    expect(screen.queryByRole('searchbox')).not.toBeInTheDocument();
    // No card-in-card: the section's root is not itself a bordered card.
    expect(container.firstElementChild?.className).not.toMatch(/\bborder\b/);
  });

  it('section variant shows count + search once the list reaches the threshold', () => {
    render(<SiteList sites={many} variant="section" />);

    expect(screen.getByText(`${many.length} of ${many.length} sites`)).toBeInTheDocument();
    expect(screen.getByRole('searchbox', { name: 'Search sites' })).toBeInTheDocument();
  });
});
