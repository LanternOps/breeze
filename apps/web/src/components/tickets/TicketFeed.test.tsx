import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import TicketFeed from './TicketFeed';
import type { TicketComment } from './ticketConfig';

let seq = 0;
const makeComment = (overrides: Partial<TicketComment> = {}): TicketComment => ({
  id: `c-${++seq}`,
  userId: 'user-1',
  portalUserId: null,
  authorName: 'Sam',
  authorType: 'user',
  commentType: 'comment',
  content: 'Hello',
  isPublic: true,
  oldValue: null,
  newValue: null,
  createdAt: '2026-06-01T10:00:00.000Z',
  ...overrides
});

describe('TicketFeed', () => {
  it('renders the Internal label on non-public comments only', () => {
    render(
      <TicketFeed
        comments={[
          makeComment({ id: 'pub-1', content: 'Public reply', isPublic: true }),
          makeComment({ id: 'int-1', content: 'Internal note', isPublic: false })
        ]}
      />
    );

    const internal = screen.getByTestId('ticket-comment-int-1');
    expect(internal).toHaveTextContent('Internal');

    const pub = screen.getByTestId('ticket-comment-pub-1');
    expect(pub).toBeInTheDocument();
    expect(pub).not.toHaveTextContent('Internal');
  });

  it('collapses a run of 3 consecutive system events and expands on click', () => {
    render(
      <TicketFeed
        comments={[
          makeComment({ id: 's-1', commentType: 'status_change', oldValue: 'new', newValue: 'open' }),
          makeComment({ id: 's-2', commentType: 'assignment', newValue: 'user-2' }),
          makeComment({ id: 's-3', commentType: 'status_change', oldValue: 'open', newValue: 'pending' })
        ]}
      />
    );

    const collapsed = screen.getByTestId('ticket-feed-system-collapsed');
    expect(collapsed).toHaveTextContent('3 changes');
    expect(screen.queryByText('Sam changed status: New to Open')).toBeNull();

    fireEvent.click(collapsed);

    expect(screen.queryByTestId('ticket-feed-system-collapsed')).toBeNull();
    expect(screen.getByText('Sam changed status: New to Open')).toBeInTheDocument();
    expect(screen.getByText('Sam assigned this ticket')).toBeInTheDocument();
    expect(screen.getByText('Sam changed status: Open to Pending')).toBeInTheDocument();
  });

  it('renders a single system event expanded with no collapse button', () => {
    render(
      <TicketFeed
        comments={[
          makeComment({ id: 's-solo', commentType: 'status_change', oldValue: 'open', newValue: 'pending' })
        ]}
      />
    );

    expect(screen.queryByTestId('ticket-feed-system-collapsed')).toBeNull();
    expect(screen.getByText('Sam changed status: Open to Pending')).toBeInTheDocument();
  });

  it('maps status_change values to display labels', () => {
    render(
      <TicketFeed
        comments={[
          makeComment({ id: 's-map', commentType: 'status_change', authorName: null, oldValue: 'open', newValue: 'pending' })
        ]}
      />
    );

    expect(screen.getByText('System changed status: Open to Pending')).toBeInTheDocument();
  });

  it('renders the empty state for an empty comment list', () => {
    render(<TicketFeed comments={[]} />);
    expect(screen.getByTestId('ticket-feed-empty')).toBeInTheDocument();
    expect(screen.queryByTestId('ticket-feed')).toBeNull();
  });
});
