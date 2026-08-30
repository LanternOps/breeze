import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

const { showToastMock } = vi.hoisted(() => ({ showToastMock: vi.fn() }));
vi.mock('../shared/Toast', () => ({ showToast: showToastMock }));

import TicketComposer from './TicketComposer';

describe('TicketComposer', () => {
  const onSend = vi.fn().mockResolvedValue(undefined);
  beforeEach(() => onSend.mockClear());

  it('defaults to public reply mode', () => {
    render(<TicketComposer requesterName="Pat" onSend={onSend} />);
    expect(screen.getByTestId('ticket-composer-send')).toHaveTextContent('Send reply');
    expect(screen.queryByTestId('ticket-composer-internal-banner')).toBeNull();
    expect(screen.getByTestId('ticket-composer-input')).toHaveAttribute('placeholder', 'Reply to Pat…');
  });

  it('internal mode shows the banner, changes the send label and placeholder', () => {
    render(<TicketComposer requesterName="Pat" onSend={onSend} />);
    fireEvent.click(screen.getByTestId('ticket-composer-tab-internal'));
    expect(screen.getByTestId('ticket-composer-internal-banner')).toHaveTextContent('Internal');
    expect(screen.getByTestId('ticket-composer-send')).toHaveTextContent('Add internal note');
    expect(screen.getByTestId('ticket-composer-input')).toHaveAttribute('placeholder', 'Add an internal note…');
  });

  it('sends with isPublic matching the active mode', async () => {
    render(<TicketComposer requesterName="Pat" onSend={onSend} />);
    fireEvent.click(screen.getByTestId('ticket-composer-tab-internal'));
    fireEvent.change(screen.getByTestId('ticket-composer-input'), { target: { value: 'note body' } });
    fireEvent.click(screen.getByTestId('ticket-composer-send'));
    expect(onSend).toHaveBeenCalledWith('note body', false, []); // W08: ids arg
  });

  it('disables send on empty content', () => {
    render(<TicketComposer requesterName="Pat" onSend={onSend} />);
    expect(screen.getByTestId('ticket-composer-send')).toBeDisabled();
  });

  it('Cmd+Enter sends', () => {
    render(<TicketComposer requesterName="Pat" onSend={onSend} />);
    const input = screen.getByTestId('ticket-composer-input');
    fireEvent.change(input, { target: { value: 'hi' } });
    fireEvent.keyDown(input, { key: 'Enter', metaKey: true });
    expect(onSend).toHaveBeenCalledWith('hi', true, []); // W08: ids arg
  });

  it('hides the canned-response picker when there are no templates', () => {
    render(<TicketComposer requesterName="Pat" onSend={onSend} />);
    expect(screen.queryByTestId('canned-picker-button')).toBeNull();
  });

  it('inserts a canned response (with variables substituted) into the draft', () => {
    render(
      <TicketComposer
        requesterName="Pat"
        onSend={onSend}
        templates={[{ id: '1', name: 'Greeting', body: 'Hi {{requester_name}}', category: null, sortOrder: 0, isActive: true }]}
        templateVars={{ requester_name: 'Pat' }}
      />,
    );
    fireEvent.click(screen.getByTestId('canned-picker-button'));
    fireEvent.click(screen.getByTestId('canned-picker-option-1'));
    expect(screen.getByTestId('ticket-composer-input')).toHaveValue('Hi Pat');
  });

  it('splices a canned response at the caret (not just append)', () => {
    render(
      <TicketComposer
        requesterName="Pat"
        onSend={onSend}
        templates={[{ id: '1', name: 'Sig', body: '[sig]', category: null, sortOrder: 0, isActive: true }]}
        templateVars={{}}
      />,
    );
    const input = screen.getByTestId('ticket-composer-input') as HTMLTextAreaElement;
    fireEvent.change(input, { target: { value: 'Hello  world' } });
    // Place the caret between the two spaces (index 6).
    input.setSelectionRange(6, 6);
    fireEvent.click(screen.getByTestId('canned-picker-button'));
    fireEvent.click(screen.getByTestId('canned-picker-option-1'));
    expect(input.value).toBe('Hello [sig] world');
  });

  it('replaces the current selection when inserting a canned response', () => {
    render(
      <TicketComposer
        requesterName="Pat"
        onSend={onSend}
        templates={[{ id: '1', name: 'Sig', body: 'X', category: null, sortOrder: 0, isActive: true }]}
        templateVars={{}}
      />,
    );
    const input = screen.getByTestId('ticket-composer-input') as HTMLTextAreaElement;
    fireEvent.change(input, { target: { value: 'aBBBc' } });
    input.setSelectionRange(1, 4); // select "BBB"
    fireEvent.click(screen.getByTestId('canned-picker-button'));
    fireEvent.click(screen.getByTestId('canned-picker-option-1'));
    expect(input.value).toBe('aXc');
  });

  it('keeps the draft and re-enables send when onSend rejects', async () => {
    onSend.mockRejectedValueOnce(new Error('network down'));
    render(<TicketComposer requesterName="Pat" onSend={onSend} />);

    const input = screen.getByTestId('ticket-composer-input');
    fireEvent.change(input, { target: { value: 'important draft' } });
    fireEvent.click(screen.getByTestId('ticket-composer-send'));

    await waitFor(() => {
      expect(screen.getByTestId('ticket-composer-send')).toHaveTextContent('Send reply');
    });
    expect(input).toHaveValue('important draft');
    expect(screen.getByTestId('ticket-composer-send')).not.toBeDisabled();
    expect(input).not.toBeDisabled();
  });

  // ── W08 #3902: attachments ────────────────────────────────────────────────

  describe('attachments', () => {
    const png = (name: string) => new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], name, { type: 'image/png' });

    beforeEach(() => showToastMock.mockClear());

    const upload = (files: File[]) => {
      const input = screen.getByTestId('ticket-composer-file-input') as HTMLInputElement;
      fireEvent.change(input, { target: { files } });
    };

    it('restricts the picker to the four accepted types', () => {
      render(<TicketComposer requesterName="Pat" onSend={onSend} onUploadAttachment={vi.fn()} />);
      expect(screen.getByTestId('ticket-composer-file-input')).toHaveAttribute(
        'accept',
        'image/jpeg,image/png,image/webp,application/pdf'
      );
    });

    it('rejects a 6th file client-side with a toast and keeps the first five', async () => {
      const onUpload = vi.fn(async (f: File) => ({ id: `id-${f.name}` }));
      render(<TicketComposer requesterName="Pat" onSend={onSend} onUploadAttachment={onUpload} />);

      upload([1, 2, 3, 4, 5, 6].map((n) => png(`p${n}.png`)));

      await waitFor(() => expect(onUpload).toHaveBeenCalledTimes(5));
      expect(showToastMock).toHaveBeenCalledWith(expect.objectContaining({ type: 'error' }));
      expect(screen.queryByTestId('ticket-composer-chip-p6.png')).toBeNull();
    });

    it('uploads each file and sends the claimed ids with the comment', async () => {
      const onUpload = vi.fn(async (f: File) => ({ id: `id-${f.name}` }));
      render(<TicketComposer requesterName="Pat" onSend={onSend} onUploadAttachment={onUpload} />);

      upload([png('a.png'), png('b.png')]);
      await waitFor(() => expect(screen.getByTestId('ticket-composer-send')).not.toBeDisabled());

      fireEvent.change(screen.getByTestId('ticket-composer-input'), { target: { value: 'with files' } });
      fireEvent.click(screen.getByTestId('ticket-composer-send'));

      await waitFor(() =>
        expect(onSend).toHaveBeenCalledWith('with files', true, ['id-a.png', 'id-b.png'])
      );
    });

    it('disables Send while any chip is still uploading', async () => {
      let release!: (v: { id: string }) => void;
      const onUpload = vi.fn(() => new Promise<{ id: string }>((res) => { release = res; }));
      render(<TicketComposer requesterName="Pat" onSend={onSend} onUploadAttachment={onUpload} />);

      fireEvent.change(screen.getByTestId('ticket-composer-input'), { target: { value: 'text' } });
      upload([png('slow.png')]);

      await waitFor(() => expect(screen.getByTestId('ticket-composer-send')).toBeDisabled());
      release({ id: 'id-slow' });
      await waitFor(() => expect(screen.getByTestId('ticket-composer-send')).not.toBeDisabled());
    });

    it('allows sending an attachment-only comment with empty text', async () => {
      const onUpload = vi.fn(async () => ({ id: 'id-only' }));
      render(<TicketComposer requesterName="Pat" onSend={onSend} onUploadAttachment={onUpload} />);

      upload([png('only.png')]);
      await waitFor(() => expect(screen.getByTestId('ticket-composer-send')).not.toBeDisabled());
      fireEvent.click(screen.getByTestId('ticket-composer-send'));

      await waitFor(() => expect(onSend).toHaveBeenCalledWith('', true, ['id-only']));
    });

    it('leaves a retry chip on a failed upload without disturbing the others', async () => {
      const onUpload = vi.fn(async (f: File) => {
        if (f.name === 'bad.png') throw new Error('507');
        return { id: `id-${f.name}` };
      });
      render(<TicketComposer requesterName="Pat" onSend={onSend} onUploadAttachment={onUpload} />);

      upload([png('good.png'), png('bad.png')]);

      // The failed file keeps a retryable chip; the successful one is untouched.
      await screen.findByTestId('ticket-composer-chip-retry-bad.png');
      expect(screen.getByTestId('ticket-composer-chip-good.png')).toBeInTheDocument();

      fireEvent.change(screen.getByTestId('ticket-composer-input'), { target: { value: 'partial' } });
      fireEvent.click(screen.getByTestId('ticket-composer-send'));
      // Only the successful id is claimed; the failed one is never invented.
      await waitFor(() => expect(onSend).toHaveBeenCalledWith('partial', true, ['id-good.png']));
      // After the comment lands every chip is dropped — a leftover failed chip
      // would otherwise ride along on the NEXT comment.
      await waitFor(() => expect(screen.queryByTestId('ticket-composer-chips')).toBeNull());
    });
  });
});
