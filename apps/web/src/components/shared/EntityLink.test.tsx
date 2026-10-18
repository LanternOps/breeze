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
    render(<EntityLink kind="org" id="o1" name="Acme" className="font-medium" />);
    expect(screen.getByTestId('org-record-link')).toHaveClass('underline', 'font-medium');
  });

  // #9033: a link inside a cursor-pointer row needs a visible rest affordance,
  // not just hover:underline.
  it('has a quiet underline at rest and a solid one on hover/focus', () => {
    render(<EntityLink kind="device" id="d1" name="web-01" />);
    const link = screen.getByTestId('device-record-link');
    expect(link).toHaveClass(
      'underline',
      'underline-offset-4',
      'decoration-border',
      'hover:decoration-current',
      'focus-visible:decoration-current',
    );
  });

  it('shows a focus-visible ring', () => {
    render(<EntityLink kind="device" id="d1" name="web-01" />);
    expect(screen.getByTestId('device-record-link')).toHaveClass(
      'focus-visible:ring-2',
      'focus-visible:ring-ring',
      'focus-visible:ring-offset-2',
      'rounded-sm',
    );
  });

  it('keeps a 24px minimum target', () => {
    render(<EntityLink kind="device" id="d1" name="web-01" />);
    expect(screen.getByTestId('device-record-link')).toHaveClass('inline-flex', 'items-center', 'min-h-[24px]');
    // Shrinkable as a flex item, so the inner span can ellipsize in a flex row.
    expect(screen.getByTestId('device-record-link')).toHaveClass('min-w-0');
  });

  it('defaults to the primary (foreground) tone and does not change colour on hover', () => {
    render(<EntityLink kind="device" id="d1" name="web-01" />);
    const link = screen.getByTestId('device-record-link');
    expect(link).toHaveClass('text-foreground');
    expect(link.className).not.toMatch(/hover:text-/);
  });

  it('maps tone="muted" to the muted colour', () => {
    render(<EntityLink kind="org" id="o1" name="Acme" tone="muted" />);
    const link = screen.getByTestId('org-record-link');
    expect(link).toHaveClass('text-muted-foreground');
    expect(link).not.toHaveClass('text-foreground');
  });

  it('truncates the name inside the link so a narrow cell still ellipsizes', () => {
    render(<EntityLink kind="org" id="o1" name="A very long organization name" />);
    const link = screen.getByTestId('org-record-link');
    expect(link).toHaveClass('max-w-full');
    const label = link.firstElementChild as HTMLElement;
    expect(label).toHaveClass('truncate');
    expect(label).toHaveTextContent('A very long organization name');
  });

  it('keeps the tone on the plain-text fallback', () => {
    render(<EntityLink kind="site" id="" name="Unknown Site" tone="muted" />);
    expect(screen.getByText('Unknown Site')).toHaveClass('text-muted-foreground');
  });
});

describe('EntityLink tabIndex (#9037)', () => {
  it('passes tabIndex through so a focusable row can own the tab stop', () => {
    render(<EntityLink kind="device" id="d1" name="web-01" tabIndex={-1} />);
    expect(screen.getByTestId('device-record-link')).toHaveAttribute('tabindex', '-1');
  });

  it('leaves the anchor in the tab order by default', () => {
    render(<EntityLink kind="device" id="d1" name="web-01" />);
    expect(screen.getByTestId('device-record-link')).not.toHaveAttribute('tabindex');
  });
});
