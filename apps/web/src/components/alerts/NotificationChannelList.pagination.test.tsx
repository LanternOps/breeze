import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '../../lib/i18n';
import { describe, it, expect } from 'vitest';
import NotificationChannelList, { type NotificationChannel } from './NotificationChannelList';

function channels(
  count: number,
  type: NotificationChannel['type'] = 'email',
  prefix = 'Channel'
): NotificationChannel[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `${prefix}-${index + 1}`,
    name: `${prefix} ${String(index + 1).padStart(2, '0')}`,
    type,
    enabled: true,
    config: {},
    createdAt: '2026-08-11T00:00:00Z',
    updatedAt: '2026-08-11T00:00:00Z',
  }));
}

// #4008 — the pager buttons hold only a lucide icon, and lucide-react stamps
// aria-hidden="true" on an icon with no children and no aria-, role or title
// prop (same mechanism as #3697). The buttons stay in the accessibility tree —
// they are native <button> elements — but the hidden icon is their only naming
// source, so they had no accessible name at all: unreachable by an
// accessible-name query, and announced as a bare "button".
describe('NotificationChannelList pager — accessible names', () => {
  it('names the previous/next controls so they are reachable by role', () => {
    render(<NotificationChannelList channels={channels(11)} pageSize={10} />);

    expect(screen.getByRole('button', { name: /previous page/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /next page/i })).toBeInTheDocument();
  });
});

// #4008 — `currentPage` is local state and nothing reconciled it with the row
// count. Deleting the only row on the last page (parent refetches and hands
// down a shorter array) left the user on a page that no longer exists: no
// rows, the "try adjusting your search" copy despite an untouched search box,
// and — because `totalPages` had dropped to 1 — no pager to get back.
describe('NotificationChannelList — rows shrink underneath the current page (#4008)', () => {
  it('falls back to the last page that still exists instead of an empty one', async () => {
    const user = userEvent.setup();
    const { rerender } = render(
      <NotificationChannelList channels={channels(11)} pageSize={10} />
    );

    await user.click(screen.getByRole('button', { name: /next page/i }));
    expect(screen.getByText('Channel 11')).toBeInTheDocument();

    // What the parent does after a successful delete + refetch.
    rerender(<NotificationChannelList channels={channels(10)} pageSize={10} />);

    expect(screen.getByText('Channel 01')).toBeInTheDocument();
    expect(screen.getByText('Channel 10')).toBeInTheDocument();
    expect(screen.queryByText(/adjusting your search/i)).not.toBeInTheDocument();
  });

  it('keeps the user as deep in the list as the new row count allows', async () => {
    const user = userEvent.setup();
    const { rerender } = render(
      <NotificationChannelList channels={channels(25)} pageSize={10} />
    );

    const next = screen.getByRole('button', { name: /next page/i });
    await user.click(next);
    await user.click(next);
    expect(screen.getByText('Channel 21')).toBeInTheDocument();

    // 25 -> 15 rows: page 3 is gone, but page 2 still holds rows 11-15.
    rerender(<NotificationChannelList channels={channels(15)} pageSize={10} />);

    expect(screen.getByText('Channel 11')).toBeInTheDocument();
    expect(screen.getByText('Channel 15')).toBeInTheDocument();
    expect(screen.queryByText('Channel 01')).not.toBeInTheDocument();
    // Last page: next is spent, previous is the way back.
    expect(screen.getByRole('button', { name: /next page/i })).toBeDisabled();
    expect(screen.getByRole('button', { name: /previous page/i })).toBeEnabled();
  });

  it('does not teleport the user forward when the list grows again', async () => {
    const user = userEvent.setup();
    const { rerender } = render(
      <NotificationChannelList channels={channels(11)} pageSize={10} />
    );

    await user.click(screen.getByRole('button', { name: /next page/i }));
    rerender(<NotificationChannelList channels={channels(10)} pageSize={10} />);
    expect(screen.getByText('Channel 01')).toBeInTheDocument();

    // A create + refetch pushes the count back over one page. The user is
    // looking at page 1 now, so that is where they stay.
    rerender(<NotificationChannelList channels={channels(11)} pageSize={10} />);

    expect(screen.getByText('Channel 01')).toBeInTheDocument();
    expect(screen.queryByText('Channel 11')).not.toBeInTheDocument();
  });
  it('survives the list emptying completely and refilling', async () => {
    const user = userEvent.setup();
    const { rerender } = render(
      <NotificationChannelList channels={channels(11)} pageSize={10} onCreate={() => {}} />
    );

    await user.click(screen.getByRole('button', { name: /next page/i }));

    // The zero-row trough. The empty-state copy alone does not discriminate
    // here — an unfixed component renders the same thing, because a page-2
    // slice of [] is empty for the same reason a page-1 slice is. What the
    // floor of 1 on totalPages buys is the state left behind: without it
    // `safePage` is min(2, 0) = 0, which the effect then writes back...
    rerender(<NotificationChannelList channels={[]} pageSize={10} onCreate={() => {}} />);

    expect(screen.getByText(/no notification channels yet/i)).toBeInTheDocument();
    expect(screen.queryByText(/adjusting your search/i)).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /next page/i })).not.toBeInTheDocument();

    // ...and a page of 0 slices from a negative index, so the list would come
    // back EMPTY once rows returned. This assertion is what makes the trough
    // worth testing.
    rerender(<NotificationChannelList channels={channels(11)} pageSize={10} onCreate={() => {}} />);

    expect(screen.getByText('Channel 01')).toBeInTheDocument();
    expect(screen.getByText('Channel 10')).toBeInTheDocument();
    expect(screen.queryByText(/adjusting your search/i)).not.toBeInTheDocument();
  });

  it('clamps against the FILTERED count, not the raw list length', async () => {
    const user = userEvent.setup();
    const slack = channels(5, 'slack', 'Slack');
    const { rerender } = render(
      <NotificationChannelList channels={[...channels(11), ...slack]} pageSize={10} />
    );

    // 11 email rows over two pages; the 5 slack rows are filtered out and must
    // not prop up `totalPages` once an email row is deleted.
    await user.selectOptions(screen.getByRole('combobox'), 'email');
    await user.click(screen.getByRole('button', { name: /next page/i }));
    expect(screen.getByText('Channel 11')).toBeInTheDocument();

    rerender(<NotificationChannelList channels={[...channels(10), ...slack]} pageSize={10} />);

    expect(screen.getByText('Channel 01')).toBeInTheDocument();
    expect(screen.getByText('Channel 10')).toBeInTheDocument();
    expect(screen.queryByText(/adjusting your search/i)).not.toBeInTheDocument();
  });
});
