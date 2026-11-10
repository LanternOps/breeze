import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, render, screen, fireEvent, waitFor } from '@testing-library/react';

const { showToastMock } = vi.hoisted(() => ({ showToastMock: vi.fn() }));
vi.mock('../shared/Toast', () => ({ showToast: showToastMock }));

import TicketComposer from './TicketComposer';
import { apiLogout, useAuthStore } from '@/stores/auth';
import { ActionError } from '../../lib/runAction';

describe('TicketComposer', () => {
  const onSend = vi.fn().mockResolvedValue(undefined);
  beforeEach(() => onSend.mockClear());

  // Reply / Internal note pick the visibility of the one message being
  // written; there is no second panel, so they are a radio group, not tabs
  // (tabs with no tabpanel announced a widget that was not there).
  it('exposes Reply / Internal note as a labelled radio group with one tab stop', () => {
    render(<TicketComposer requesterName="Pat" onSend={onSend} />);
    const group = screen.getByRole('radiogroup', { name: 'Comment visibility' });
    const reply = screen.getByTestId('ticket-composer-tab-reply');
    const internal = screen.getByTestId('ticket-composer-tab-internal');
    expect(reply).toHaveAttribute('role', 'radio');
    expect(internal).toHaveAttribute('role', 'radio');
    expect(group).toContainElement(reply);
    expect(group).toContainElement(internal);
    expect(reply).toHaveAttribute('aria-checked', 'true');
    expect(internal).toHaveAttribute('aria-checked', 'false');
    expect(reply).toHaveAttribute('tabindex', '0');
    expect(internal).toHaveAttribute('tabindex', '-1');
    expect(screen.queryByRole('tablist')).toBeNull();
    expect(screen.queryByRole('tab')).toBeNull();
    // Attach is an action, not a third mode.
    expect(group).not.toContainElement(screen.queryByTestId('ticket-composer-attach'));
  });

  it('arrow keys move focus and the checked mode, wrapping at both ends', () => {
    render(<TicketComposer requesterName="Pat" onSend={onSend} />);
    const reply = screen.getByTestId('ticket-composer-tab-reply');
    const internal = screen.getByTestId('ticket-composer-tab-internal');
    reply.focus();
    fireEvent.keyDown(reply, { key: 'ArrowRight' });
    expect(internal).toHaveAttribute('aria-checked', 'true');
    expect(internal).toHaveFocus();
    expect(screen.getByTestId('ticket-composer-internal-banner')).toBeInTheDocument();
    fireEvent.keyDown(internal, { key: 'ArrowDown' });
    expect(reply).toHaveAttribute('aria-checked', 'true');
    expect(reply).toHaveFocus();
    fireEvent.keyDown(reply, { key: 'ArrowLeft' });
    expect(internal).toHaveFocus();
    fireEvent.keyDown(internal, { key: 'ArrowUp' });
    expect(reply).toHaveFocus();
    expect(screen.queryByTestId('ticket-composer-internal-banner')).toBeNull();
  });

  describe('recipient line', () => {
    it('in public mode, says who the reply emails, above Send', () => {
      render(<TicketComposer requesterName="Pat Smith" requesterEmail="pat@example.com" onSend={onSend} />);
      const line = screen.getByTestId('ticket-composer-recipient');
      expect(line).toHaveTextContent('Emails Pat Smith <pat@example.com>');
      // Reads before the Send button in DOM (and so in reading) order.
      expect(line.compareDocumentPosition(screen.getByTestId('ticket-composer-send')) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    });

    it('names the address alone when the requester has no name', () => {
      render(<TicketComposer requesterName={null} requesterEmail="pat@example.com" onSend={onSend} />);
      expect(screen.getByTestId('ticket-composer-recipient')).toHaveTextContent('Emails pat@example.com');
    });

    it('says plainly that nobody is emailed when there is no requester email on file', () => {
      render(<TicketComposer requesterName="Pat" requesterEmail={null} onSend={onSend} />);
      const line = screen.getByTestId('ticket-composer-recipient');
      expect(line).toHaveTextContent('No requester email on file');
      expect(line).toHaveAttribute('data-recipient', 'none');
      expect(line).not.toHaveTextContent('Emails');
    });

    it('in internal mode, says who sees it where the recipient line was, not in the toolbar', () => {
      render(<TicketComposer requesterName="Pat" requesterEmail="pat@example.com" onSend={onSend} onLogTime={vi.fn()} />);
      fireEvent.click(screen.getByTestId('ticket-composer-tab-internal'));
      const banner = screen.getByTestId('ticket-composer-internal-banner');
      // Out of the toolbar, so the toolbar keeps one row with Log time and Ask AI.
      expect(screen.getByTestId('ticket-composer-toolbar')).not.toContainElement(banner);
      expect(banner.compareDocumentPosition(screen.getByTestId('ticket-composer-send')) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    });

    it('caps only its contents to the host measure, not its rule or wash', () => {
      render(<TicketComposer requesterName="Pat" onSend={onSend} contentClassName="max-w-[78ch]" />);
      expect(screen.getByTestId('ticket-composer').className).not.toContain('max-w');
      expect(screen.getByTestId('ticket-composer-content').className).toContain('max-w-[78ch]');
    });

    it('in internal mode, drops the recipient line for the internal treatment', () => {
      render(<TicketComposer requesterName="Pat" requesterEmail="pat@example.com" onSend={onSend} />);
      fireEvent.click(screen.getByTestId('ticket-composer-tab-internal'));
      expect(screen.queryByTestId('ticket-composer-recipient')).toBeNull();
      expect(screen.getByTestId('ticket-composer-internal-banner')).toBeInTheDocument();
    });
  });

  it('offers Log time beside Attach when the host handles it', () => {
    const onLogTime = vi.fn();
    render(<TicketComposer requesterName="Pat" onSend={onSend} onUploadAttachment={vi.fn()} onLogTime={onLogTime} logTimeOpen={false} />);
    const button = screen.getByTestId('ticket-composer-log-time');
    expect(screen.getByTestId('ticket-composer-toolbar')).toContainElement(button);
    expect(button).toHaveTextContent('Log time');
    expect(button).toHaveAttribute('aria-expanded', 'false');
    // Attach comes first, Log time right after it.
    expect(screen.getByTestId('ticket-composer-attach').compareDocumentPosition(button) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    fireEvent.click(button);
    expect(onLogTime).toHaveBeenCalledTimes(1);
  });

  it('renders toolbar extras (Ask AI) beside canned responses', () => {
    render(<TicketComposer requesterName="Pat" onSend={onSend} toolbarExtra={<button type="button" data-testid="extra-tool">Ask AI</button>} />);
    expect(screen.getByTestId('ticket-composer-toolbar')).toContainElement(screen.getByTestId('extra-tool'));
  });

  it('keeps a half-written reply per draft key across a remount', () => {
    const { unmount } = render(<TicketComposer requesterName="Pat" onSend={onSend} draftKey="tk-draft-1" />);
    fireEvent.change(screen.getByTestId('ticket-composer-input'), { target: { value: 'Half a thought' } });
    unmount();
    render(<TicketComposer requesterName="Pat" onSend={onSend} draftKey="tk-draft-1" />);
    expect(screen.getByTestId('ticket-composer-input')).toHaveValue('Half a thought');
  });

  // An internal note restored as a public reply would email the requester
  // the moment Send is pressed: the draft keeps its mode with its text.
  it('restores an internal-note draft in internal mode, never as a reply', () => {
    const { unmount } = render(<TicketComposer requesterName="Pat" onSend={onSend} draftKey="tk-draft-internal" />);
    fireEvent.click(screen.getByTestId('ticket-composer-tab-internal'));
    fireEvent.change(screen.getByTestId('ticket-composer-input'), { target: { value: 'Customer is difficult, escalate' } });
    unmount();

    render(<TicketComposer requesterName="Pat" onSend={onSend} draftKey="tk-draft-internal" />);
    expect(screen.getByTestId('ticket-composer-input')).toHaveValue('Customer is difficult, escalate');
    expect(screen.getByTestId('ticket-composer-tab-internal')).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByTestId('ticket-composer-tab-reply')).toHaveAttribute('aria-checked', 'false');
    expect(screen.getByTestId('ticket-composer-internal-banner')).toBeInTheDocument();
    expect(screen.getByTestId('ticket-composer-send')).toHaveTextContent('Add internal note');
  });

  it('forgets a sent reply even when the composer unmounted while the POST was in flight', async () => {
    let land!: () => void;
    const slowSend = vi.fn(() => new Promise<void>((resolve) => { land = resolve; }));
    const { unmount } = render(<TicketComposer requesterName="Pat" onSend={slowSend} draftKey="tk-draft-sent" />);
    fireEvent.change(screen.getByTestId('ticket-composer-input'), { target: { value: 'On my way' } });
    fireEvent.click(screen.getByTestId('ticket-composer-send'));
    expect(slowSend).toHaveBeenCalledWith('On my way', true, []);
    // j/k (or the next-ticket offer) moves on before the POST answers.
    unmount();
    await act(async () => { land(); });

    render(<TicketComposer requesterName="Pat" onSend={onSend} draftKey="tk-draft-sent" />);
    expect(screen.getByTestId('ticket-composer-input')).toHaveValue('');
  });

  it('keeps the draft when the POST fails after the composer unmounted', async () => {
    let fail!: () => void;
    const failingSend = vi.fn(() => new Promise<void>((_, reject) => { fail = () => reject(new Error('500')); }));
    const { unmount } = render(<TicketComposer requesterName="Pat" onSend={failingSend} draftKey="tk-draft-failed" />);
    fireEvent.change(screen.getByTestId('ticket-composer-input'), { target: { value: 'Not sent yet' } });
    fireEvent.click(screen.getByTestId('ticket-composer-send'));
    unmount();
    await act(async () => { fail(); });

    render(<TicketComposer requesterName="Pat" onSend={onSend} draftKey="tk-draft-failed" />);
    expect(screen.getByTestId('ticket-composer-input')).toHaveValue('Not sent yet');
  });

  // Web sign-out is same-document: module state survives it, so the next
  // person to sign in on this browser must not find the last one's drafts.
  function leaveInternalDraft(key: string) {
    const { unmount } = render(<TicketComposer requesterName="Pat" onSend={onSend} draftKey={key} />);
    fireEvent.click(screen.getByTestId('ticket-composer-tab-internal'));
    fireEvent.change(screen.getByTestId('ticket-composer-input'), { target: { value: 'Private note' } });
    unmount();
  }

  function expectNoDraft(key: string) {
    render(<TicketComposer requesterName="Pat" onSend={onSend} draftKey={key} />);
    expect(screen.getByTestId('ticket-composer-input')).toHaveValue('');
    expect(screen.getByTestId('ticket-composer-tab-reply')).toHaveAttribute('aria-checked', 'true');
  }

  it('drops every unsent draft at sign-out', async () => {
    leaveInternalDraft('tk-draft-logout');
    await apiLogout();
    expectNoDraft('tk-draft-logout');
  });

  // Session expiry and the throttle mask's Sign Out end the session through the
  // store's logout() alone, which runs no logout hooks.
  it('drops every unsent draft when the session ends through the store logout alone', () => {
    leaveInternalDraft('tk-draft-store-logout');
    useAuthStore.getState().logout();
    expectNoDraft('tk-draft-store-logout');
  });

  // r / n route here through the workbench: the asked mode, then the caret.
  it('a host focus request sets the asked mode and focuses the box, once per request', () => {
    const { rerender } = render(<TicketComposer requesterName="Pat" onSend={onSend} />);
    const input = screen.getByTestId('ticket-composer-input');
    rerender(<TicketComposer requesterName="Pat" onSend={onSend} focusRequest={{ mode: 'internal', token: 1 }} />);
    expect(screen.getByTestId('ticket-composer-tab-internal')).toHaveAttribute('aria-checked', 'true');
    expect(input).toHaveFocus();

    // The same request again (a re-render) changes nothing the user did since.
    fireEvent.click(screen.getByTestId('ticket-composer-tab-reply'));
    rerender(<TicketComposer requesterName="Pat" onSend={onSend} focusRequest={{ mode: 'internal', token: 1 }} />);
    expect(screen.getByTestId('ticket-composer-tab-reply')).toHaveAttribute('aria-checked', 'true');

    rerender(<TicketComposer requesterName="Pat" onSend={onSend} focusRequest={{ mode: 'internal', token: 2 }} />);
    expect(screen.getByTestId('ticket-composer-tab-internal')).toHaveAttribute('aria-checked', 'true');
  });

  it('does not carry a draft to another ticket', () => {
    const { unmount } = render(<TicketComposer requesterName="Pat" onSend={onSend} draftKey="tk-draft-2" />);
    fireEvent.change(screen.getByTestId('ticket-composer-input'), { target: { value: 'For ticket two' } });
    unmount();
    render(<TicketComposer requesterName="Pat" onSend={onSend} draftKey="tk-draft-3" />);
    expect(screen.getByTestId('ticket-composer-input')).toHaveValue('');
  });

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
      // The successful chip is cleared with the rest of the draft, but the
      // failed chip is NOT silently discarded — the user must still see and
      // act on (retry/remove) the file that never made it onto the comment.
      await waitFor(() => expect(screen.queryByTestId('ticket-composer-chip-good.png')).toBeNull());
      expect(screen.getByTestId('ticket-composer-chip-retry-bad.png')).toBeInTheDocument();
    });

    it('surfaces a partial-success toast when the note posts but a rejected attachment is dropped', async () => {
      const onUpload = vi.fn(async () => {
        throw new Error('415');
      });
      render(<TicketComposer requesterName="Pat" onSend={onSend} onUploadAttachment={onUpload} />);

      upload([png('notes.txt')]);
      await screen.findByTestId('ticket-composer-chip-retry-notes.txt');

      fireEvent.change(screen.getByTestId('ticket-composer-input'), { target: { value: 'see attached' } });
      fireEvent.click(screen.getByTestId('ticket-composer-send'));

      await waitFor(() => expect(onSend).toHaveBeenCalledWith('see attached', true, []));
      // Explicit partial-success feedback beyond the earlier upload-error toast —
      // the composer must not clear as though everything succeeded.
      await waitFor(() =>
        expect(showToastMock).toHaveBeenCalledWith(
          expect.objectContaining({ type: 'warning', message: expect.stringContaining('could not be added') })
        )
      );
      expect(screen.getByTestId('ticket-composer-chip-retry-notes.txt')).toBeInTheDocument();
      expect(screen.getByTestId('ticket-composer-input')).toHaveValue('');
    });

    it('says "Reply posted" for a public reply and "Note posted" for an internal note', async () => {
      const onUpload = vi.fn(async () => { throw new Error('network'); });
      render(<TicketComposer requesterName="Pat" onSend={onSend} onUploadAttachment={onUpload} />);
      upload([png('a.png')]);
      await screen.findByTestId('ticket-composer-chip-retry-a.png');
      fireEvent.change(screen.getByTestId('ticket-composer-input'), { target: { value: 'hi' } });
      fireEvent.click(screen.getByTestId('ticket-composer-send'));
      await waitFor(() =>
        expect(showToastMock).toHaveBeenCalledWith(expect.objectContaining({ type: 'warning', message: expect.stringContaining('Reply posted') }))
      );

      showToastMock.mockClear();
      fireEvent.click(screen.getByTestId('ticket-composer-tab-internal'));
      fireEvent.change(screen.getByTestId('ticket-composer-input'), { target: { value: 'hm' } });
      fireEvent.click(screen.getByTestId('ticket-composer-send'));
      await waitFor(() =>
        expect(showToastMock).toHaveBeenCalledWith(expect.objectContaining({ type: 'warning', message: expect.stringContaining('Note posted') }))
      );
    });

    describe('permanent rejections', () => {
      it.each([
        ['unsupported type', new ActionError('Only JPEG', 415, 'UNSUPPORTED_ATTACHMENT_TYPE'), 'notes.txt'],
        ['too large', new ActionError('too big', 413, 'ATTACHMENT_TOO_LARGE'), 'huge.png'],
      ])('drops a file refused as %s: no chip, no Retry, a reason toast', async (_label, err, name) => {
        const onUpload = vi.fn(async () => { throw err; });
        render(<TicketComposer requesterName="Pat" onSend={onSend} onUploadAttachment={onUpload} />);
        upload([png(name)]);
        await waitFor(() => expect(screen.queryByTestId(`ticket-composer-chip-${name}`)).toBeNull());
        expect(screen.queryByTestId(`ticket-composer-chip-retry-${name}`)).toBeNull();
        expect(showToastMock).toHaveBeenCalledWith(
          expect.objectContaining({ type: 'error', message: expect.stringContaining(name) })
        );
      });

      it.each([
        ['5xx', new ActionError('storage down', 503, 'STORAGE_UNAVAILABLE')],
        ['network', new ActionError('offline', 0)],
        ['rate limit', new ActionError('slow down', 429, 'TOO_MANY_PENDING')],
      ])('keeps Retry for a transient %s failure', async (_label, err) => {
        const onUpload = vi.fn(async () => { throw err; });
        render(<TicketComposer requesterName="Pat" onSend={onSend} onUploadAttachment={onUpload} />);
        upload([png('a.png')]);
        await screen.findByTestId('ticket-composer-chip-retry-a.png');
      });
    });
  });
});
