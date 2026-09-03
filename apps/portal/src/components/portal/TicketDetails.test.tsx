// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

const addTicketComment = vi.fn();
// The real module pulls in astro-only imports through @/lib/navigation, so it
// cannot be importActual'd here. portalAttachmentContentPath's own output is
// pinned in src/lib/api.test.ts; this stub only lets the component render.
vi.mock('@/lib/api', () => ({
  portalApi: { addTicketComment: (...args: unknown[]) => addTicketComment(...args) },
  portalAttachmentContentPath: (ticketId: string, attachmentId: string) =>
    `/api/v1/portal/tickets/${ticketId}/attachments/${attachmentId}/content`,
}));

import { TicketDetails } from './TicketDetails';
import type { TicketDetails as TicketDetailsType, TicketStatus } from '@/lib/api';

const ticket = (over: Partial<TicketDetailsType> = {}): TicketDetailsType => ({
  id: 't1',
  ticketNumber: 'T-1',
  subject: 'Printer offline',
  status: 'new',
  priority: 'normal',
  description: 'Drops every afternoon.',
  createdAt: '2026-08-01T00:00:00Z',
  updatedAt: '2026-08-02T00:00:00Z',
  sla: {
    firstResponseMinutes: null,
    resolutionMinutes: null,
    responseTargetMinutes: null,
    resolutionTargetMinutes: null,
    status: 'not_configured',
  },
  comments: [
    { id: 'c2', authorName: 'Tech', authorType: 'user', content: 'second', createdAt: '2026-08-02T00:00:00Z' },
    { id: 'c1', authorName: 'Maya', authorType: 'portal', content: 'first', createdAt: '2026-08-01T00:00:00Z' },
  ],
  ...over,
});

beforeEach(() => addTicketComment.mockReset());

describe('TicketDetails — statuses', () => {
  const ALL: TicketStatus[] = ['new', 'open', 'pending', 'on_hold', 'resolved', 'closed'];
  it.each(ALL)('renders status %s without throwing and with activity copy', (status) => {
    render(<TicketDetails ticket={ticket({ status })} />);
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Printer offline');
    expect(screen.getByTestId('ticket-activity-status').textContent).not.toBe('');
  });

  it('hides the composer on a closed ticket and offers a new one instead', () => {
    render(<TicketDetails ticket={ticket({ status: 'closed' })} />);
    expect(screen.queryByTestId('ticket-reply-form')).toBeNull();
    expect(screen.getByTestId('ticket-closed-note')).toBeTruthy();
  });
});

describe('TicketDetails — reply composer', () => {
  it('renders replies oldest-first even though the API returns newest-first', () => {
    render(<TicketDetails ticket={ticket()} />);
    const items = screen.getAllByTestId('ticket-comment').map((li) => li.textContent ?? '');
    expect(items[0]).toContain('first');
    expect(items[1]).toContain('second');
  });

  it('does not submit whitespace-only content', () => {
    render(<TicketDetails ticket={ticket()} />);
    fireEvent.change(screen.getByTestId('ticket-reply-input'), { target: { value: '   ' } });
    expect((screen.getByTestId('ticket-reply-submit') as HTMLButtonElement).disabled).toBe(true);
    expect(addTicketComment).not.toHaveBeenCalled();
  });

  it('posts the trimmed reply, appends it to the thread and clears the box', async () => {
    addTicketComment.mockResolvedValue({
      data: { id: 'c3', authorName: 'Nadia', authorType: 'portal', content: 'hi', createdAt: '2026-08-03T00:00:00Z' },
    });
    render(<TicketDetails ticket={ticket()} />);
    const input = screen.getByTestId('ticket-reply-input') as HTMLTextAreaElement;
    fireEvent.change(input, { target: { value: '  hi  ' } });
    fireEvent.click(screen.getByTestId('ticket-reply-submit'));
    await waitFor(() => expect(addTicketComment).toHaveBeenCalledWith('t1', 'hi'));
    await waitFor(() => expect(screen.getAllByTestId('ticket-comment')).toHaveLength(3));
    expect(input.value).toBe('');
  });

  it('shows the API error and keeps the draft when the post fails', async () => {
    addTicketComment.mockResolvedValue({ error: 'Tickets are disabled for this organization' });
    render(<TicketDetails ticket={ticket()} />);
    const input = screen.getByTestId('ticket-reply-input') as HTMLTextAreaElement;
    fireEvent.change(input, { target: { value: 'hi' } });
    fireEvent.click(screen.getByTestId('ticket-reply-submit'));
    expect((await screen.findByRole('alert')).textContent).toContain('Tickets are disabled');
    expect(input.value).toBe('hi');
    expect(screen.getAllByTestId('ticket-comment')).toHaveLength(2);
  });
});

describe('TicketDetails — who wrote it', () => {
  it("labels the IT team's replies and leaves the customer's own unlabelled", () => {
    render(<TicketDetails ticket={ticket()} />);
    const items = screen.getAllByTestId('ticket-comment');
    const byAuthor = Object.fromEntries(items.map((li) => [li.textContent?.includes('Maya') ? 'portal' : 'team', li.textContent ?? '']));
    expect(byAuthor.team).toContain('Your IT team');
    expect(byAuthor.portal).not.toContain('Your IT team');
  });
});

describe('ReplyComposer — draft survives a dead session', () => {
  it('restores a stashed draft for this ticket and clears it once posted', async () => {
    sessionStorage.setItem('portal:reply-draft:t1', 'half-written reply');
    addTicketComment.mockResolvedValue({
      data: { id: 'c9', authorName: 'Maya', authorType: 'portal', content: 'half-written reply', createdAt: '2026-08-04T00:00:00Z' },
    });
    render(<TicketDetails ticket={ticket({ id: 't1' })} />);
    const input = screen.getByTestId('ticket-reply-input') as HTMLTextAreaElement;
    await waitFor(() => expect(input.value).toBe('half-written reply'));

    fireEvent.click(screen.getByTestId('ticket-reply-submit'));
    await waitFor(() => expect(addTicketComment).toHaveBeenCalledWith('t1', 'half-written reply'));
    await waitFor(() => expect(sessionStorage.getItem('portal:reply-draft:t1')).toBeNull());
  });

  it('stashes what is typed so the 401 redirect cannot lose it', () => {
    render(<TicketDetails ticket={ticket({ id: 't2' })} />);
    fireEvent.change(screen.getByTestId('ticket-reply-input'), { target: { value: 'typing…' } });
    expect(sessionStorage.getItem('portal:reply-draft:t2')).toBe('typing…');
  });
});

// ---------------------------------------------------------------------------
// W08 #3902 — render-only attachments on public comments.
// ---------------------------------------------------------------------------
describe('TicketDetails — comment attachments (W08 #3902)', () => {
  const withAttachments = () =>
    ticket({
      comments: [
        {
          id: 'c1', authorName: 'Tech', authorType: 'user', content: 'here you go',
          createdAt: '2026-08-02T00:00:00Z',
          attachments: [
            { id: 'a1', commentId: 'c1', contentType: 'image/png', byteSize: 1234, originalFilename: 'printer.png', createdAt: '2026-08-02T00:00:00Z' },
            { id: 'a2', commentId: 'c1', contentType: 'application/pdf', byteSize: 4096, originalFilename: 'report.pdf', createdAt: '2026-08-02T00:00:00Z' },
          ],
        },
      ],
    });

  it('renders an image thumbnail pointing at the same-origin portal content path', () => {
    render(<TicketDetails ticket={withAttachments()} />);
    const img = screen.getByTestId('ticket-attachment-image-a1') as HTMLImageElement;
    // Never the SSR-internal API host — that leaks into customer HTML.
    expect(img.getAttribute('src')).toBe('/api/v1/portal/tickets/t1/attachments/a1/content');
    expect(img.getAttribute('alt')).toBe('printer.png');
  });

  it('renders a non-image attachment as a download link, not an <img>', () => {
    render(<TicketDetails ticket={withAttachments()} />);
    const link = screen.getByTestId('ticket-attachment-file-a2');
    expect(link.getAttribute('href')).toBe('/api/v1/portal/tickets/t1/attachments/a2/content');
    expect(link.textContent).toContain('report.pdf');
    expect(screen.queryByTestId('ticket-attachment-image-a2')).toBeNull();
  });

  it('renders nothing extra for a comment with no attachments', () => {
    render(<TicketDetails ticket={ticket()} />);
    expect(screen.queryByTestId('ticket-attachment-list')).toBeNull();
  });
});
