import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

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

  it('renders time_entry comments as system lines with their content', () => {
    render(
      <TicketFeed
        comments={[
          makeComment({ id: 'te-1', commentType: 'time_entry', content: 'Todd logged 45m (billable)', authorName: 'Todd' })
        ]}
      />
    );
    expect(screen.getByText(/Todd logged 45m \(billable\)/)).toBeInTheDocument();
  });

  it('renders a fallback label for time_entry comments with empty content', () => {
    render(
      <TicketFeed
        comments={[
          makeComment({ id: 'te-empty', commentType: 'time_entry', content: '', authorName: 'Todd' })
        ]}
      />
    );
    expect(screen.getByText('Todd logged time')).toBeInTheDocument();
  });

  it('renders "Technician logged time" for time_entry comments with empty content and null authorName', () => {
    render(
      <TicketFeed
        comments={[
          makeComment({ id: 'te-noauth', commentType: 'time_entry', content: '', authorName: null })
        ]}
      />
    );
    expect(screen.getByText('Technician logged time')).toBeInTheDocument();
  });

  it('shows an edited badge when editedAt is set', () => {
    render(
      <TicketFeed
        comments={[makeComment({ id: 'ed-1', content: 'hi', editedAt: '2026-06-01T11:00:00.000Z' })]}
      />
    );
    expect(screen.getByTestId('ticket-comment-edited-ed-1')).toBeInTheDocument();
  });

  it('does not show an edited badge when editedAt is absent', () => {
    render(
      <TicketFeed
        comments={[makeComment({ id: 'ed-2', content: 'hi' })]}
      />
    );
    expect(screen.queryByTestId('ticket-comment-edited-ed-2')).toBeNull();
  });

  it('renders a tombstone for a deleted comment and hides the body', () => {
    render(
      <TicketFeed
        comments={[makeComment({ id: 'del-1', content: '', deleted: true })]}
      />
    );
    expect(screen.getByTestId('ticket-comment-deleted-del-1')).toBeInTheDocument();
    expect(screen.queryByTestId('ticket-comment-del-1')).toBeNull();
  });

  it('shows edit and delete controls when canManageComment returns true and handlers are provided', () => {
    const onEdit = vi.fn();
    const onDelete = vi.fn();
    render(
      <TicketFeed
        comments={[makeComment({ id: 'ctrl-1', content: 'hi' })]}
        onEditComment={onEdit}
        onDeleteComment={onDelete}
        canManageComment={() => true}
      />
    );
    expect(screen.getByTestId('ticket-comment-edit-ctrl-1')).toBeInTheDocument();
    expect(screen.getByTestId('ticket-comment-delete-ctrl-1')).toBeInTheDocument();
  });

  it('hides controls when canManageComment returns false', () => {
    render(
      <TicketFeed
        comments={[makeComment({ id: 'ctrl-2', content: 'hi' })]}
        onEditComment={vi.fn()}
        onDeleteComment={vi.fn()}
        canManageComment={() => false}
      />
    );
    expect(screen.queryByTestId('ticket-comment-edit-ctrl-2')).toBeNull();
    expect(screen.queryByTestId('ticket-comment-delete-ctrl-2')).toBeNull();
  });

  it('hides controls when handler props are not provided even if canManageComment returns true', () => {
    render(
      <TicketFeed
        comments={[makeComment({ id: 'ctrl-3', content: 'hi' })]}
        canManageComment={() => true}
      />
    );
    expect(screen.queryByTestId('ticket-comment-edit-ctrl-3')).toBeNull();
    expect(screen.queryByTestId('ticket-comment-delete-ctrl-3')).toBeNull();
  });
});
