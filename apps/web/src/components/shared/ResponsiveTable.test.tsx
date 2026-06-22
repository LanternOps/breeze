import { describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { ResponsiveTable, DataCard, CardField, CardActions } from './ResponsiveTable';

describe('ResponsiveTable', () => {
  it('renders both the desktop table and the mobile cards', () => {
    render(
      <ResponsiveTable
        table={<table><tbody><tr><td>desktop row</td></tr></tbody></table>}
        cards={<DataCard>mobile card</DataCard>}
      />,
    );
    expect(screen.getByText('desktop row')).toBeInTheDocument();
    expect(screen.getByText('mobile card')).toBeInTheDocument();
  });

  it('makes the desktop wrapper horizontally scrollable, never clipping (regression for clipped columns on mobile)', () => {
    render(<ResponsiveTable table={<table />} cards={null} />);
    const desktop = screen.getByTestId('responsive-table-desktop');
    expect(desktop.className).toContain('overflow-x-auto');
    // The original bug: `overflow-hidden` cut off right-hand columns.
    expect(desktop.className).not.toContain('overflow-hidden');
  });

  it('hides the table below sm and hides the cards at sm and up', () => {
    render(<ResponsiveTable table={<table />} cards={<div>c</div>} />);
    expect(screen.getByTestId('responsive-table-desktop').className).toContain('sm:block');
    expect(screen.getByTestId('responsive-table-desktop').className).toContain('hidden');
    expect(screen.getByTestId('responsive-table-cards').className).toContain('sm:hidden');
  });

  it('passes through a className for outer spacing', () => {
    render(<ResponsiveTable className="mt-6" table={<table />} cards={null} />);
    expect(screen.getByTestId('responsive-table').className).toContain('mt-6');
  });
});

describe('DataCard', () => {
  it('fires onClick and shows a tap affordance only when interactive', () => {
    const onClick = vi.fn();
    const { rerender } = render(<DataCard onClick={onClick}>tap me</DataCard>);
    const card = screen.getByText('tap me');
    expect(card.className).toContain('cursor-pointer');
    fireEvent.click(card);
    expect(onClick).toHaveBeenCalledOnce();

    rerender(<DataCard>static</DataCard>);
    expect(screen.getByText('static').className).not.toContain('cursor-pointer');
  });
});

describe('CardField', () => {
  it('renders a label and its value', () => {
    render(<CardField label="Type">Router</CardField>);
    expect(screen.getByText('Type')).toBeInTheDocument();
    expect(screen.getByText('Router')).toBeInTheDocument();
  });
});

describe('CardActions', () => {
  it('floors contained buttons and links to a 44px touch target on mobile', () => {
    render(
      <CardActions>
        <button type="button">act</button>
      </CardActions>,
    );
    const row = screen.getByText('act').parentElement!;
    // 44px == min-h-11/min-w-11 (a floor, not a clamp), applied to both <button>
    // and <a> actions so a link-style action isn't left below the tap minimum.
    expect(row.className).toContain('[&_button]:min-h-11');
    expect(row.className).toContain('[&_button]:min-w-11');
    expect(row.className).toContain('[&_a]:min-h-11');
    expect(row.className).toContain('border-t');
  });

  it('merges an extra layout className', () => {
    render(<CardActions className="flex justify-end"><button type="button">a</button></CardActions>);
    expect(screen.getByText('a').parentElement!.className).toContain('justify-end');
  });
});
