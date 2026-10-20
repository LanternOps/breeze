import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import SiteList, { SITE_SEARCH_THRESHOLD, type Site } from './SiteList';

const site = (n: number): Site => ({ id: `s${n}`, name: `Site ${n}`, timezone: 'UTC', deviceCount: n });
const few = [site(1)];
const many = Array.from({ length: SITE_SEARCH_THRESHOLD }, (_, i) => site(i + 1));

describe('SiteList', () => {
  it('keeps its h2 heading and Add, but no count or search below the threshold (#9022)', () => {
    render(<SiteList sites={few} onAddSite={() => undefined} />);

    expect(screen.getByRole('heading', { level: 2, name: 'Sites' })).toBeInTheDocument();
    expect(screen.queryByText('1 of 1 sites')).toBeNull();
    expect(screen.queryByRole('searchbox', { name: 'Search sites' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Add site' })).toBeInTheDocument();
  });

  it('shows the count and search once the list reaches the threshold, and filters by name', () => {
    render(<SiteList sites={many} onAddSite={() => undefined} />);

    expect(screen.getByText(`${SITE_SEARCH_THRESHOLD} of ${SITE_SEARCH_THRESHOLD} sites`)).toBeInTheDocument();
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search sites' }), { target: { value: 'Site 2' } });
    expect(screen.getByText(`1 of ${SITE_SEARCH_THRESHOLD} sites`)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Add site' })).toBeInTheDocument();
  });

  it('labels the navigating row action "Open", not "Edit", and opens the site from it (#9022)', () => {
    const onSiteClick = vi.fn();
    render(<SiteList sites={few} onSiteClick={onSiteClick} onEdit={vi.fn()} onDelete={vi.fn()} />);

    const open = screen.getAllByRole('button', { name: 'Open Site 1' })[0];
    expect(open.textContent).toBe('Open');
    expect(screen.queryByRole('button', { name: 'Edit Site 1' })).toBeNull();
    fireEvent.click(open);
    expect(onSiteClick).toHaveBeenCalledTimes(1);
    expect(onSiteClick).toHaveBeenCalledWith(few[0]);
  });

  it('keeps "Edit" as the primary action when there is nothing to open', () => {
    const onEdit = vi.fn();
    render(<SiteList sites={few} onEdit={onEdit} onDelete={vi.fn()} />);

    fireEvent.click(screen.getAllByRole('button', { name: 'Edit Site 1' })[0]);
    expect(onEdit).toHaveBeenCalledWith(few[0]);
  });

  it('opens the site on a row click, but not from clicks on the row\'s own controls', () => {
    const onSiteClick = vi.fn();
    const onDelete = vi.fn();
    render(<SiteList sites={few} onSiteClick={onSiteClick} onDelete={onDelete} />);

    fireEvent.click(within(screen.getByTestId('site-row-s1')).getByText('UTC'));
    expect(onSiteClick).toHaveBeenCalledTimes(1);

    // The overflow trigger and its (portalled) item must not also open the site.
    fireEvent.click(screen.getAllByTestId('site-s1-menu')[0]);
    fireEvent.click(screen.getByRole('menuitem', { name: 'Delete' }));
    expect(onDelete).toHaveBeenCalledWith(few[0]);
    expect(onSiteClick).toHaveBeenCalledTimes(1);
  });

  it('stops filtering by a leftover query once the list drops below the threshold', () => {
    const { rerender } = render(<SiteList sites={many} />);
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search sites' }), { target: { value: 'Site 2' } });
    expect(screen.queryByTestId('site-row-s1')).toBeNull();

    rerender(<SiteList sites={few} />);
    expect(screen.queryByRole('searchbox', { name: 'Search sites' })).toBeNull();
    expect(screen.getByTestId('site-row-s1')).toBeInTheDocument();
  });

  it('the tel: link and the mobile card behave: a call never opens the site, a card tap opens it once', () => {
    const onSiteClick = vi.fn();
    render(<SiteList sites={[{ ...site(1), contact: { phone: '+1 555 0100' } }]} onSiteClick={onSiteClick} />);

    for (const phone of screen.getAllByTestId('site-s1-contact-phone')) fireEvent.click(phone);
    expect(onSiteClick).not.toHaveBeenCalled();

    const cards = screen.getByTestId('responsive-table-cards');
    fireEvent.click(within(cards).getByText('Site 1'));
    expect(onSiteClick).toHaveBeenCalledTimes(1);
    fireEvent.click(within(cards).getByRole('button', { name: 'Open Site 1' }));
    expect(onSiteClick).toHaveBeenCalledTimes(2);
  });

  it('moves Delete off the row into a destructive overflow menu item (#9022)', () => {
    const onDelete = vi.fn();
    render(<SiteList sites={few} onSiteClick={vi.fn()} onEdit={vi.fn()} onDelete={onDelete} />);

    // No standalone Delete button on the row any more.
    expect(screen.queryByRole('button', { name: 'Delete Site 1' })).toBeNull();
    const trigger = screen.getAllByTestId('site-s1-menu')[0];
    expect(trigger.getAttribute('aria-label')).toBe('Actions for Site 1');
    fireEvent.click(trigger);
    const del = screen.getByRole('menuitem', { name: 'Delete' });
    expect(del.className).toContain('text-destructive');
    // The in-place edit dialog is still reachable from the menu.
    expect(screen.getByRole('menuitem', { name: 'Edit' })).toBeInTheDocument();
    fireEvent.click(del);
    expect(onDelete).toHaveBeenCalledWith(few[0]);
  });

  it('draws one border: the desktop table sits flat inside the card (#9022)', () => {
    render(<SiteList sites={few} />);

    const desktop = screen.getByTestId('responsive-table-desktop');
    expect(desktop.className).not.toMatch(/(^|\s)border(\s|$)/);
    expect(desktop.className).not.toContain('bg-card');
    expect(desktop.className).not.toContain('shadow');
    // Header styling stays.
    expect(desktop.querySelector('thead')?.className).toContain('bg-muted/40');
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
