import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { LineItemsTable } from './LineItemsTable';

interface Row {
  id: string;
  description: string;
  qty: number;
  price: string;
  total: string;
}

const rows: Row[] = [
  { id: 'l1', description: 'Widget', qty: 2, price: '$10.00', total: '$20.00' },
  { id: 'l2', description: 'Gadget', qty: 1, price: '$5.00', total: '$5.00' },
];

function renderTable(overrideRows: Row[] = rows) {
  return render(
    <LineItemsTable<Row>
      rows={overrideRows}
      columns={[
        { key: 'qty', header: 'Qty', align: 'right', cell: (r) => r.qty },
        { key: 'price', header: 'Price', align: 'right', cell: (r) => r.price },
        { key: 'total', header: 'Total', align: 'right', cell: (r) => r.total },
      ]}
      renderDescription={(r) => <span>{r.description}</span>}
      descriptionHeader="Description"
      keyFor={(r) => r.id}
      rowTestId={(r) => `line-${r.id}`}
      tableTestId="lines-table"
      scrollAriaLabel="Lines"
      emptyMessage="No lines"
      emptyTestId="lines-empty"
    />,
  );
}

describe('LineItemsTable', () => {
  it('renders one row per line with the correct amounts, reachable via a single test id each', () => {
    renderTable();
    const row1 = screen.getByTestId('line-l1');
    expect(row1).toHaveTextContent('Widget');
    expect(row1).toHaveTextContent('$10.00');
    expect(row1).toHaveTextContent('$20.00');
    const row2 = screen.getByTestId('line-l2');
    expect(row2).toHaveTextContent('$5.00');
  });

  it('renders exactly one description node per row (no duplicate desktop/mobile tree)', () => {
    renderTable();
    // If the component ever duplicates rows into a separate mobile tree, this
    // becomes 2 and getByText throws "multiple elements" — that's the guard.
    expect(screen.getByText('Widget')).toBeInTheDocument();
    expect(screen.getByText('Gadget')).toBeInTheDocument();
  });

  it('carries an inline field label per cell, hidden at sm and up, for the stacked-card layout below sm', () => {
    renderTable();
    const row1 = screen.getByTestId('line-l1');
    const priceLabel = Array.from(row1.querySelectorAll('span')).find((el) => el.textContent === 'Price');
    expect(priceLabel).toBeTruthy();
    expect(priceLabel!.className).toContain('sm:hidden');
  });

  it('only min-widths the table at sm and up, so nothing forces horizontal scroll below sm', () => {
    renderTable();
    const table = screen.getByTestId('lines-table');
    expect(table.className).toContain('sm:min-w-[32rem]');
    expect(table.className).not.toMatch(/(?<!sm:)min-w-\[32rem\]/);
  });

  it('shows the empty message once when there are no rows', () => {
    renderTable([]);
    expect(screen.getByTestId('lines-empty')).toHaveTextContent('No lines');
  });
});
