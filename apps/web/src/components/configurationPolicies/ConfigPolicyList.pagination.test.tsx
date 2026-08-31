import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';

import ConfigPolicyList, { type ConfigPolicy } from './ConfigPolicyList';

function policies(
  count: number,
  status: ConfigPolicy['status'] = 'active',
  prefix = 'Policy'
): ConfigPolicy[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `${prefix}-${index + 1}`,
    name: `${prefix} ${String(index + 1).padStart(2, '0')}`,
    status,
    orgId: '44444444-4444-4444-4444-444444444444',
    orgName: 'OliveTech',
  }));
}

function rowNames(): string[] {
  return screen
    .getAllByTestId('config-policy-row')
    .map((row) => row.querySelector('td')?.textContent ?? '');
}

// #4008 — `currentPage` is local state and nothing reconciled it with the row
// count. Deleting the only row on the last page (the page refetches and hands
// down a shorter array) left the user on a page that no longer exists: no
// rows, the "try adjusting your search" copy despite an untouched search box,
// and — because `totalPages` had dropped to 1 — no pager to get back.
describe('ConfigPolicyList — rows shrink underneath the current page (#4008)', () => {
  it('falls back to the last page that still exists instead of an empty one', async () => {
    const user = userEvent.setup();
    const { rerender } = render(
      <ConfigPolicyList policies={policies(11)} pageSize={10} />
    );

    await user.click(screen.getByTestId('config-policy-next-page'));
    expect(rowNames()).toHaveLength(1);
    expect(rowNames()[0]).toContain('Policy 11');

    // What the page does after a successful delete + refetch.
    rerender(<ConfigPolicyList policies={policies(10)} pageSize={10} />);

    expect(rowNames()).toHaveLength(10);
    expect(rowNames()[0]).toContain('Policy 01');
    expect(screen.queryByText(/adjusting your search/i)).not.toBeInTheDocument();
  });

  it('keeps the user as deep in the list as the new row count allows', async () => {
    const user = userEvent.setup();
    const { rerender } = render(
      <ConfigPolicyList policies={policies(25)} pageSize={10} />
    );

    const next = screen.getByTestId('config-policy-next-page');
    await user.click(next);
    await user.click(next);
    expect(rowNames()[0]).toContain('Policy 21');

    // 25 -> 15 rows: page 3 is gone, but page 2 still holds rows 11-15.
    rerender(<ConfigPolicyList policies={policies(15)} pageSize={10} />);

    expect(rowNames()).toHaveLength(5);
    expect(rowNames()[0]).toContain('Policy 11');
    // Last page: next is spent, previous is the way back.
    expect(screen.getByTestId('config-policy-next-page')).toBeDisabled();
    expect(screen.getByTestId('config-policy-prev-page')).toBeEnabled();
  });

  it('does not teleport the user forward when the list grows again', async () => {
    const user = userEvent.setup();
    const { rerender } = render(
      <ConfigPolicyList policies={policies(11)} pageSize={10} />
    );

    await user.click(screen.getByTestId('config-policy-next-page'));
    rerender(<ConfigPolicyList policies={policies(10)} pageSize={10} />);
    expect(rowNames()[0]).toContain('Policy 01');

    // A create + refetch pushes the count back over one page. The user is
    // looking at page 1 now, so that is where they stay.
    rerender(<ConfigPolicyList policies={policies(11)} pageSize={10} />);

    expect(rowNames()).toHaveLength(10);
    expect(rowNames()[0]).toContain('Policy 01');
  });
  it('survives the list emptying completely and refilling', async () => {
    const user = userEvent.setup();
    const { rerender } = render(
      <ConfigPolicyList policies={policies(11)} pageSize={10} />
    );

    await user.click(screen.getByTestId('config-policy-next-page'));

    // The zero-row trough. The empty-state copy alone does not discriminate
    // here — an unfixed component renders the same thing, because a page-2
    // slice of [] is empty for the same reason a page-1 slice is. What the
    // floor of 1 on totalPages buys is the state left behind: without it
    // `safePage` is min(2, 0) = 0, which the effect then writes back...
    rerender(<ConfigPolicyList policies={[]} pageSize={10} />);

    expect(screen.getByText(/no configuration policies yet/i)).toBeInTheDocument();
    expect(screen.queryByText(/adjusting your search/i)).not.toBeInTheDocument();
    expect(screen.queryByTestId('config-policy-next-page')).not.toBeInTheDocument();

    // ...and a page of 0 slices from a negative index, so the list would come
    // back EMPTY once rows returned. This assertion is what makes the trough
    // worth testing.
    rerender(<ConfigPolicyList policies={policies(11)} pageSize={10} />);

    expect(rowNames()).toHaveLength(10);
    expect(rowNames()[0]).toContain('Policy 01');
    expect(screen.queryByText(/adjusting your search/i)).not.toBeInTheDocument();
  });

  it('clamps against the FILTERED count, not the raw list length', async () => {
    const user = userEvent.setup();
    const inactive = policies(5, 'inactive', 'Retired');
    const { rerender } = render(
      <ConfigPolicyList policies={[...policies(11), ...inactive]} pageSize={10} />
    );

    // 11 active rows over two pages; the 5 inactive rows are filtered out and
    // must not prop up `totalPages` once an active row is deleted.
    await user.selectOptions(screen.getByRole('combobox'), 'active');
    await user.click(screen.getByTestId('config-policy-next-page'));
    expect(rowNames()[0]).toContain('Policy 11');

    rerender(
      <ConfigPolicyList policies={[...policies(10), ...inactive]} pageSize={10} />
    );

    expect(rowNames()).toHaveLength(10);
    expect(rowNames()[0]).toContain('Policy 01');
    expect(screen.queryByText(/adjusting your search/i)).not.toBeInTheDocument();
  });
});
