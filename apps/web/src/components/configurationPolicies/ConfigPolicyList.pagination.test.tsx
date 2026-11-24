import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import ConfigPolicyList, { type ConfigPolicy, type ListViewFilters } from './ConfigPolicyList';

function policies(count: number, prefix = 'Policy'): ConfigPolicy[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `${prefix}-${index + 1}`,
    name: `${prefix} ${String(index + 1).padStart(2, '0')}`,
    status: 'active',
    orgId: '44444444-4444-4444-4444-444444444444',
    orgName: 'Fabrikam MSP',
  }));
}

const noFilters: ListViewFilters = { search: '', status: 'all', notApplied: false, org: 'all' };

function rowNames(): string[] {
  return screen
    .getAllByTestId('config-policy-row')
    .map((row) => row.querySelector('td')?.textContent ?? '');
}

// Paging runs on the server (W03d C4): the list renders the rows it is handed,
// sizes the pager from the server's total, and reports page changes. It never
// slices or filters a row array itself.
describe('ConfigPolicyList server paging', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('renders every row it is handed and sizes the pager from the server total', () => {
    render(<ConfigPolicyList policies={policies(25)} total={137} page={1} pageSize={25} />);

    expect(rowNames()).toHaveLength(25);
    expect(screen.getByTestId('config-policy-range-summary')).toHaveTextContent('1-25 of 137 policies');
    expect(screen.getByText(/Page\s*1\s*of\s*6/)).toBeInTheDocument();
    expect(screen.getByTestId('config-policy-prev-page')).toBeDisabled();
    expect(screen.getByTestId('config-policy-next-page')).toBeEnabled();
  });

  it('reports the requested page and does not change rows by itself', async () => {
    const user = userEvent.setup();
    const onPageChange = vi.fn();
    render(
      <ConfigPolicyList policies={policies(25)} total={60} page={2} pageSize={25} onPageChange={onPageChange} />,
    );

    await user.click(screen.getByTestId('config-policy-next-page'));
    expect(onPageChange).toHaveBeenLastCalledWith(3);
    await user.click(screen.getByTestId('config-policy-prev-page'));
    expect(onPageChange).toHaveBeenLastCalledWith(1);
    expect(rowNames()[0]).toContain('Policy 01');
  });

  it('disables Next on the last server page', () => {
    render(<ConfigPolicyList policies={policies(10)} total={60} page={3} pageSize={25} />);

    expect(screen.getByTestId('config-policy-next-page')).toBeDisabled();
    expect(screen.getByTestId('config-policy-prev-page')).toBeEnabled();
    expect(screen.getByTestId('config-policy-range-summary')).toHaveTextContent('51-60 of 60 policies');
  });

  it('shows no pager when the total fits one page', () => {
    render(<ConfigPolicyList policies={policies(3)} total={3} page={1} pageSize={25} />);
    expect(screen.queryByTestId('config-policy-next-page')).not.toBeInTheDocument();
  });

  it('reports a status change without filtering the rows itself', async () => {
    const user = userEvent.setup();
    const onFiltersChange = vi.fn();
    render(
      <ConfigPolicyList
        policies={policies(3)}
        total={3}
        filters={noFilters}
        onFiltersChange={onFiltersChange}
      />,
    );

    await user.selectOptions(screen.getByTestId('config-policy-status-filter'), 'inactive');
    expect(onFiltersChange).toHaveBeenCalledWith({ status: 'inactive' });
    expect(rowNames()).toHaveLength(3);
  });

  it('debounces the search box into one report', () => {
    vi.useFakeTimers();
    const onFiltersChange = vi.fn();
    render(<ConfigPolicyList policies={[]} total={0} filters={noFilters} onFiltersChange={onFiltersChange} />);

    const box = screen.getByRole('searchbox');
    fireEvent.change(box, { target: { value: 'z' } });
    fireEvent.change(box, { target: { value: 'ze' } });
    fireEvent.change(box, { target: { value: 'zeta' } });
    vi.advanceTimersByTime(299);
    expect(onFiltersChange).not.toHaveBeenCalled();
    vi.advanceTimersByTime(2);
    expect(onFiltersChange).toHaveBeenCalledTimes(1);
    expect(onFiltersChange).toHaveBeenCalledWith({ search: 'zeta' });
  });

  it('hides the organization select unless there is more than one org to choose from', () => {
    const { rerender } = render(
      <ConfigPolicyList policies={[]} total={0} orgOptions={[{ id: 'o1', name: 'One' }]} />,
    );
    expect(screen.queryByTestId('config-policy-org-filter')).not.toBeInTheDocument();

    rerender(
      <ConfigPolicyList
        policies={[]}
        total={0}
        orgOptions={[
          { id: 'o1', name: 'One' },
          { id: 'o2', name: 'Two' },
        ]}
      />,
    );
    expect(screen.getByTestId('config-policy-org-filter')).toBeInTheDocument();
  });
});
