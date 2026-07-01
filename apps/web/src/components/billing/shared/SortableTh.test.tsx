import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { SortableTh } from './SortableTh';

function renderTh(props: Partial<Parameters<typeof SortableTh>[0]> = {}) {
  const onSort = vi.fn();
  render(
    <table>
      <thead>
        <tr>
          <SortableTh
            label="Total"
            sortKey="total"
            activeSort={undefined}
            direction="desc"
            onSort={onSort}
            testId="sort-total"
            {...props}
          />
        </tr>
      </thead>
    </table>,
  );
  return { onSort };
}

describe('SortableTh', () => {
  it('renders aria-sort="ascending" when active and ascending', () => {
    renderTh({ activeSort: 'total', direction: 'asc' });
    expect(screen.getByRole('columnheader')).toHaveAttribute('aria-sort', 'ascending');
  });

  it('renders aria-sort="descending" when active and descending', () => {
    renderTh({ activeSort: 'total', direction: 'desc' });
    expect(screen.getByRole('columnheader')).toHaveAttribute('aria-sort', 'descending');
  });

  it('renders aria-sort="none" when inactive', () => {
    renderTh({ activeSort: 'created' });
    expect(screen.getByRole('columnheader')).toHaveAttribute('aria-sort', 'none');
  });

  it('calls onSort with the sortKey when the header button is clicked', () => {
    const { onSort } = renderTh({ activeSort: 'created' });
    fireEvent.click(screen.getByTestId('sort-total'));
    expect(onSort).toHaveBeenCalledTimes(1);
    expect(onSort).toHaveBeenCalledWith('total');
  });

  it('right-aligns the header and button when align="right"', () => {
    renderTh({ align: 'right' });
    expect(screen.getByRole('columnheader').className).toContain('text-right');
    expect(screen.getByTestId('sort-total').className).toContain('flex-row-reverse');
  });

  it('left-aligns (no text-right / flex-row-reverse) by default', () => {
    renderTh();
    expect(screen.getByRole('columnheader').className).not.toContain('text-right');
    expect(screen.getByTestId('sort-total').className).not.toContain('flex-row-reverse');
  });
});
