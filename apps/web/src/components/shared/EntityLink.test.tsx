import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { EntityLink, entityHref, type EntityKind } from './EntityLink';

const navigateTo = vi.fn();
vi.mock('@/lib/navigation', () => ({
  navigateTo: (...args: unknown[]) => navigateTo(...args),
}));

beforeEach(() => {
  navigateTo.mockReset();
});

describe('entityHref', () => {
  it.each<[EntityKind, string]>([
    ['org', '/organizations/x-1'],
    ['site', '/settings/sites/x-1'],
    ['device', '/devices/x-1'],
    ['ticket', '/tickets/x-1'],
    ['alert', '/alerts/x-1'],
  ])('maps %s to %s', (kind, href) => {
    expect(entityHref(kind, 'x-1')).toBe(href);
  });

  it('appends a hash with or without its leading #', () => {
    expect(entityHref('org', 'o1', 'billing')).toBe('/organizations/o1#billing');
    expect(entityHref('org', 'o1', '#contacts')).toBe('/organizations/o1#contacts');
  });

  it('encodes the id as one path segment', () => {
    expect(entityHref('device', 'a b/c')).toBe('/devices/a%20b%2Fc');
  });
});

describe('EntityLink', () => {
  it('renders an anchor with the kind testid, href and name', () => {
    render(<EntityLink kind="site" id="s-1" name="HQ" />);
    const link = screen.getByTestId('site-record-link');
    expect(link.tagName).toBe('A');
    expect(link).toHaveAttribute('href', '/settings/sites/s-1');
    expect(link).toHaveTextContent('HQ');
  });

  it('keeps the legacy org-record-link testid', () => {
    render(<EntityLink kind="org" id="o1" name="Acme" />);
    expect(screen.getByTestId('org-record-link')).toHaveAttribute('href', '/organizations/o1');
  });

  it('stops propagation and soft-navigates on a plain click', () => {
    const row = vi.fn();
    render(
      <div onClick={row}>
        <EntityLink kind="org" id="o1" name="Acme" hash="billing" />
      </div>,
    );
    const link = screen.getByTestId('org-record-link');
    expect(fireEvent.click(link)).toBe(false);
    expect(row).not.toHaveBeenCalled();
    expect(navigateTo).toHaveBeenCalledWith('/organizations/o1#billing');
  });

  it('hands a modified click to the browser and still stops propagation', () => {
    const row = vi.fn();
    render(
      <div onClick={row}>
        <EntityLink kind="org" id="o1" name="Acme" />
      </div>,
    );
    const link = screen.getByTestId('org-record-link');
    expect(fireEvent.click(link, { metaKey: true })).toBe(true);
    expect(row).not.toHaveBeenCalled();
    expect(navigateTo).not.toHaveBeenCalled();
  });

  it.each([{ ctrlKey: true }, { shiftKey: true }, { altKey: true }, { button: 1 }])(
    'leaves a %o click to the browser',
    (init) => {
      const row = vi.fn();
      render(
        <div onClick={row}>
          <EntityLink kind="org" id="o1" name="Acme" />
        </div>,
      );
      expect(fireEvent.click(screen.getByTestId('org-record-link'), init)).toBe(true);
      expect(row).not.toHaveBeenCalled();
      expect(navigateTo).not.toHaveBeenCalled();
    },
  );

  it('renders plain text when id is empty', () => {
    render(<EntityLink kind="site" id="" name="Unknown Site" />);
    expect(screen.queryByRole('link')).toBeNull();
    expect(screen.queryByTestId('site-record-link')).toBeNull();
    expect(screen.getByText('Unknown Site')).toBeInTheDocument();
  });

  it('renders no empty tab stop when the name is empty', () => {
    render(<EntityLink kind="site" id="s-1" name="" />);
    expect(screen.queryByRole('link')).toBeNull();
  });

  it('merges className', () => {
    render(<EntityLink kind="org" id="o1" name="Acme" className="block truncate" />);
    expect(screen.getByTestId('org-record-link')).toHaveClass('hover:underline', 'block', 'truncate');
  });
});
