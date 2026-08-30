import { render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { fetchWithAuthMock } = vi.hoisted(() => ({ fetchWithAuthMock: vi.fn() }));
vi.mock('@/stores/auth', () => ({ fetchWithAuth: fetchWithAuthMock }));

import { TicketAttachmentList } from './TicketAttachments';
import type { TicketAttachmentMeta } from './ticketConfig';

const image = (id: string): TicketAttachmentMeta => ({
  id,
  commentId: 'c-1',
  contentType: 'image/png',
  byteSize: 2048,
  originalFilename: `${id}.png`,
  createdAt: '2026-08-30T10:00:00.000Z',
});

const pdf = (id: string): TicketAttachmentMeta => ({
  id,
  commentId: 'c-1',
  contentType: 'application/pdf',
  byteSize: 4096,
  originalFilename: `${id}.pdf`,
  createdAt: '2026-08-30T10:00:00.000Z',
});

let createdUrls: string[] = [];
let revokeSpy: ReturnType<typeof vi.fn>;

beforeEach(() => {
  createdUrls = [];
  fetchWithAuthMock.mockReset();
  fetchWithAuthMock.mockResolvedValue({ ok: true, blob: async () => new Blob(['x']) });
  let n = 0;
  globalThis.URL.createObjectURL = vi.fn(() => {
    const url = `blob:mock-${++n}`;
    createdUrls.push(url);
    return url;
  }) as never;
  revokeSpy = vi.fn();
  globalThis.URL.revokeObjectURL = revokeSpy as never;
});

describe('TicketAttachmentList', () => {
  it('renders nothing at all for a comment with no attachments (no empty container)', () => {
    const { container } = render(<TicketAttachmentList ticketId="t-1" attachments={[]} />);
    expect(container.firstChild).toBeNull();
    expect(fetchWithAuthMock).not.toHaveBeenCalled();
  });

  it('renders an image attachment as an authenticated blob thumbnail', async () => {
    render(<TicketAttachmentList ticketId="t-1" attachments={[image('a-1')]} />);

    await waitFor(() => expect(screen.getByTestId('ticket-attachment-thumb-a-1')).toBeInTheDocument());
    const img = screen.getByTestId('ticket-attachment-thumb-a-1') as HTMLImageElement;
    expect(img.src).toBe(createdUrls[0]);
    // <img src> cannot carry a Bearer token, so the bytes come through the
    // authenticated fetch helper, never a raw URL.
    expect(fetchWithAuthMock).toHaveBeenCalledWith('/tickets/t-1/attachments/a-1/content');
  });

  it('renders a PDF as a file chip and never fetches its bytes for a thumbnail', async () => {
    render(<TicketAttachmentList ticketId="t-1" attachments={[pdf('a-2')]} />);

    const chip = await screen.findByTestId('ticket-attachment-file-a-2');
    expect(chip).toHaveTextContent('a-2.pdf');
    expect(screen.queryByTestId('ticket-attachment-thumb-a-2')).toBeNull();
    expect(fetchWithAuthMock).not.toHaveBeenCalled();
  });

  it('revokes every object URL it created on unmount', async () => {
    const { unmount } = render(
      <TicketAttachmentList ticketId="t-1" attachments={[image('a-3'), image('a-4')]} />
    );
    await waitFor(() => expect(createdUrls).toHaveLength(2));

    unmount();

    for (const url of createdUrls) {
      expect(revokeSpy).toHaveBeenCalledWith(url);
    }
  });

  it('renders a visible broken-attachment placeholder when the fetch fails', async () => {
    fetchWithAuthMock.mockResolvedValue({ ok: false, status: 404, blob: async () => new Blob([]) });
    render(<TicketAttachmentList ticketId="t-1" attachments={[image('a-5')]} />);

    const broken = await screen.findByTestId('ticket-attachment-error-a-5');
    expect(broken).toHaveTextContent('a-5.png');
    expect(screen.queryByTestId('ticket-attachment-thumb-a-5')).toBeNull();
  });

  it('shows the delete control only when the viewer may delete', async () => {
    const onDelete = vi.fn();
    const { rerender } = render(
      <TicketAttachmentList ticketId="t-1" attachments={[pdf('a-6')]} />
    );
    expect(screen.queryByTestId('ticket-attachment-delete-a-6')).toBeNull();

    rerender(
      <TicketAttachmentList ticketId="t-1" attachments={[pdf('a-6')]} canDelete onDelete={onDelete} />
    );
    expect(await screen.findByTestId('ticket-attachment-delete-a-6')).toBeInTheDocument();
  });
});
