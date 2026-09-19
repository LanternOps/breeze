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
});
