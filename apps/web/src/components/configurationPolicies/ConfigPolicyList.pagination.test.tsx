import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';

import ConfigPolicyList, { type ConfigPolicy } from './ConfigPolicyList';

function policies(count: number): ConfigPolicy[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `policy-${index + 1}`,
    name: `Policy ${String(index + 1).padStart(2, '0')}`,
    status: 'active' as const,
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
});
