import '../../lib/i18n';

import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import Breadcrumbs from './Breadcrumbs';

// #7178: on mobile (390px) a long breadcrumb row neither wraps nor scrolls —
// the middle crumb wraps onto two lines and the last crumb gets clipped mid-word
// before its own `truncate` can apply. jsdom has no layout engine, so these
// assertions target the markup/classes that carry the fix (min-w-0 so flex
// items can shrink below content size, truncate on every crumb) rather than
// pixel measurements.
describe('Breadcrumbs (#7178 mobile overflow)', () => {
  const items = [
    { label: 'Settings', href: '/settings' },
    { label: 'Organizations', href: '/settings/organizations' },
    { label: 'Default Organization', href: '/settings/organizations/org-1' },
    { label: 'Default Site' },
  ];

  it('gives every crumb (not just the last) min-w-0 so it can shrink instead of wrapping', () => {
    render(<Breadcrumbs items={items} />);
    const listItems = screen.getAllByRole('listitem');
    expect(listItems.length).toBe(items.length);
    for (const li of listItems) {
      expect(li.className).toMatch(/\bmin-w-0\b/);
    }
  });

  it('truncates every crumb label, not only the last one', () => {
    render(<Breadcrumbs items={items} />);
    const middleLink = screen.getByRole('link', { name: 'Default Organization' });
    expect(middleLink.className).toMatch(/\btruncate\b/);

    const lastCrumb = screen.getByText('Default Site');
    expect(lastCrumb.className).toMatch(/\btruncate\b/);
  });

  it('the list itself allows shrinking below its content width (min-w-0) so it can be constrained by an ancestor', () => {
    render(<Breadcrumbs items={items} />);
    const list = screen.getByRole('list');
    expect(list.className).toMatch(/\bmin-w-0\b/);
  });
});
