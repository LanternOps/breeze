import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  addPickedFiles,
  attachDisabledReason,
  canSend,
  chipFromPick,
  claimableIds,
  formatByteSize,
  groupCommentAttachments,
  markFailed,
  markUploaded,
  markUploading,
  remainingSlots,
  removeChip,
  sendButtonLabel,
  viewerMode,
  type AttachmentChip,
} from './attachmentComposer';
import { TICKET_ATTACHMENT_LIMITS, type PickedAttachment } from '../../services/ticketAttachmentContract';

const file = (name: string): PickedAttachment => ({
  uri: `file:///tmp/${name}`,
  name,
  mimeType: name.endsWith('.pdf') ? 'application/pdf' : 'image/jpeg',
  size: 1024,
  width: 100,
  height: 100,
});

function chip(over: Partial<AttachmentChip> = {}): AttachmentChip {
  return { ...chipFromPick(file('a.jpg'), 'local-1'), ...over };
}

describe('slot accounting', () => {
  it('offers the remaining slots up to the per-comment cap', () => {
    expect(remainingSlots([])).toBe(TICKET_ATTACHMENT_LIMITS.maxPerComment);
    expect(remainingSlots([chip(), chip()])).toBe(TICKET_ATTACHMENT_LIMITS.maxPerComment - 2);
  });

  it('never reports negative slots', () => {
    const full = Array.from({ length: 9 }, () => chip());
    expect(remainingSlots(full)).toBe(0);
  });

  it('drops picks beyond the cap rather than uploading files the server will reject', () => {
    const existing = Array.from({ length: 4 }, (_, i) => chip({ localId: `x-${i}` }));
    const added = addPickedFiles(existing, [file('b.jpg'), file('c.jpg'), file('d.jpg')]);
    expect(added.chips).toHaveLength(TICKET_ATTACHMENT_LIMITS.maxPerComment);
    expect(added.rejected).toBe(2);
  });

  it('keeps every pick when they fit', () => {
    const added = addPickedFiles([], [file('b.jpg'), file('c.jpg')]);
    expect(added.chips).toHaveLength(2);
    expect(added.rejected).toBe(0);
    expect(added.chips.every((c) => c.status === 'uploading')).toBe(true);
  });

  it('gives each chip a distinct local id so a retry does not remount its sibling', () => {
    const added = addPickedFiles([], [file('b.jpg'), file('c.jpg')]);
    expect(new Set(added.chips.map((c) => c.localId)).size).toBe(2);
  });
});

describe('chip transitions', () => {
  it('records the server id on success', () => {
    const chips = markUploaded([chip()], 'local-1', 'att-1');
    expect(chips[0]).toMatchObject({ status: 'uploaded', attachmentId: 'att-1', error: null });
  });

  it('keeps the local file on failure so Retry has something to send', () => {
    const chips = markFailed([chip()], 'local-1', 'Upload failed.', true);
    expect(chips[0]).toMatchObject({ status: 'failed', error: 'Upload failed.', retryable: true });
    expect(chips[0]!.file.uri).toBe('file:///tmp/a.jpg');
  });

  it('clears the previous error when a retry starts', () => {
    const failed = markFailed([chip()], 'local-1', 'Upload failed.', true);
    const retrying = markUploading(failed, 'local-1');
    expect(retrying[0]).toMatchObject({ status: 'uploading', error: null });
  });

  it('leaves other chips untouched', () => {
    const chips = [chip({ localId: 'a' }), chip({ localId: 'b' })];
    const next = markUploaded(chips, 'a', 'att-1');
    expect(next[1]).toBe(chips[1]);
  });

  it('removes only the named chip', () => {
    const chips = [chip({ localId: 'a' }), chip({ localId: 'b' })];
    expect(removeChip(chips, 'a').map((c) => c.localId)).toEqual(['b']);
  });
});

describe('claimableIds', () => {
  it('sends only the ids the server actually minted', () => {
    const chips = [
      chip({ localId: 'a', status: 'uploaded', attachmentId: 'att-1' }),
      chip({ localId: 'b', status: 'failed', attachmentId: null }),
      chip({ localId: 'c', status: 'uploading', attachmentId: null }),
      chip({ localId: 'd', status: 'uploaded', attachmentId: 'att-2' }),
    ];
    expect(claimableIds(chips)).toEqual(['att-1', 'att-2']);
  });
});

describe('canSend', () => {
  const base = { chips: [] as AttachmentChip[], text: '', busy: false };

  it('refuses an empty comment with no attachments', () => {
    expect(canSend(base)).toBe(false);
  });

  it('allows text alone', () => {
    expect(canSend({ ...base, text: 'hello' })).toBe(true);
  });

  it('allows an attachment with no text — the server accepts a photo-only comment', () => {
    expect(canSend({ ...base, chips: [chip({ status: 'uploaded', attachmentId: 'att-1' })] })).toBe(true);
  });

  it('blocks while any chip is still uploading, even with text', () => {
    expect(canSend({ ...base, text: 'hello', chips: [chip({ status: 'uploading' })] })).toBe(false);
  });

  it('blocks while a request is already in flight', () => {
    expect(canSend({ ...base, text: 'hello', busy: true })).toBe(false);
  });

  it('treats whitespace-only text as empty', () => {
    expect(canSend({ ...base, text: '   \n ' })).toBe(false);
  });

  it('still allows sending when a failed chip is present but text is not', () => {
    // The failed chip is simply not claimed; blocking Send would strand the
    // technician with no way to post the comment at all.
    expect(canSend({ ...base, chips: [chip({ status: 'failed' })], text: 'hello' })).toBe(true);
  });

  it('refuses when the only attachment failed and there is no text', () => {
    expect(canSend({ ...base, chips: [chip({ status: 'failed' })] })).toBe(false);
  });
});

describe('sendButtonLabel', () => {
  it('counts the files being sent rather than showing a byte-level progress bar', () => {
    const chips = [chip({ status: 'uploading' }), chip({ localId: 'b', status: 'uploaded' })];
    expect(sendButtonLabel({ chips, busy: false })).toBe('Sending 1 of 2…');
  });

  it('says nothing about files when there are none', () => {
    expect(sendButtonLabel({ chips: [], busy: false })).toBe('Post comment');
  });

  it('reports the comment itself while the POST is in flight', () => {
    expect(sendButtonLabel({ chips: [], busy: true })).toBe('Working…');
  });
});

describe('attachDisabledReason', () => {
  it('disables attaching offline and says why', () => {
    expect(attachDisabledReason({ connected: false, chips: [] }))
      .toBe('Attachments need a connection.');
  });

  it('disables attaching once the comment is full', () => {
    const full = Array.from({ length: TICKET_ATTACHMENT_LIMITS.maxPerComment }, (_, i) =>
      chip({ localId: `x-${i}` }));
    expect(attachDisabledReason({ connected: true, chips: full }))
      .toBe('Up to 5 files per comment.');
  });

  it('allows attaching when online and under the cap', () => {
    expect(attachDisabledReason({ connected: true, chips: [] })).toBeNull();
  });
});

describe('groupCommentAttachments', () => {
  const meta = (id: string, contentType: string) => ({
    id, commentId: 'c1', contentType, byteSize: 10, originalFilename: `${id}`, createdAt: 'now',
  });

  it('splits images (grid) from documents (rows)', () => {
    const grouped = groupCommentAttachments([
      meta('a', 'image/jpeg'), meta('b', 'application/pdf'),
      meta('c', 'image/png'), meta('d', 'image/webp'),
    ]);
    expect(grouped.images.map((a) => a.id)).toEqual(['a', 'c', 'd']);
    expect(grouped.documents.map((a) => a.id)).toEqual(['b']);
  });

  it('handles a comment with no attachments', () => {
    expect(groupCommentAttachments(undefined)).toEqual({ images: [], documents: [] });
  });
});

describe('viewerMode', () => {
  it('renders images inline', () => {
    expect(viewerMode('image/jpeg')).toBe('image');
    expect(viewerMode('image/webp')).toBe('image');
  });

  it('sends a PDF to the OS rather than pretending to render it', () => {
    expect(viewerMode('application/pdf')).toBe('external');
  });
});

describe('formatByteSize', () => {
  it.each([
    [512, '512 B'],
    [2048, '2 KB'],
    [5 * 1024 * 1024, '5.0 MB'],
  ])('%i renders as %s', (bytes, expected) => {
    expect(formatByteSize(bytes)).toBe(expected);
  });
});

describe('D13: attachments never enter the offline time-entry queue', () => {
  it.each([
    '../../services/ticketAttachments.ts',
    '../../services/ticketAttachmentContract.ts',
    './attachmentComposer.ts',
  ])('%s does not import timeEntryQueue', (relative) => {
    const source = readFileSync(resolve(__dirname, relative), 'utf8');
    // Matches an import/re-export SPECIFIER only. Asserting on any occurrence
    // of the name would fail on the comments that explain this very rule, and a
    // guard that forbids documenting itself gets deleted rather than obeyed.
    expect(source).not.toMatch(/from\s+['"][^'"]*timeEntryQueue['"]/);
    expect(source).not.toMatch(/require\(\s*['"][^'"]*timeEntryQueue['"]/);
  });
});
