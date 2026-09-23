import { describe, it, expect, vi, beforeEach } from 'vitest';

const { inserted } = vi.hoisted(() => ({ inserted: [] as Record<string, unknown>[][] }));

vi.mock('../../db', () => ({
  db: {
    insert: vi.fn(() => ({
      values: (rows: Record<string, unknown>[]) => {
        inserted.push(rows);
        return Promise.resolve();
      },
    })),
  },
}));
vi.mock('../../db/schema/ticketAttachments', () => ({ ticketAttachments: { __t: 'ticket_attachments' } }));

import { persistInboundAttachments, inboundAttachmentNote, hasStoredAttachments } from './inboundAttachments';
import type { InboundEmailAttachment, NormalizedInboundEmail, StoredInboundAttachment } from './types';

const stored = (id: string, over: Partial<StoredInboundAttachment> = {}): StoredInboundAttachment => ({
  attachmentId: id,
  contentType: 'application/pdf',
  byteSize: 42,
  sha256: 'b'.repeat(64),
  storageBackend: 'db',
  storageKey: null,
  data: Buffer.from('%PDF-'),
  ...over,
});

function withAttachments(attachments: InboundEmailAttachment[]): NormalizedInboundEmail {
  return {
    provider: 'm365', providerMessageId: 'm', to: 'support@a.com', from: 'c@x.com',
    subject: 's', text: 't', attachments, raw: {},
  };
}

beforeEach(() => {
  inserted.length = 0;
});

describe('persistInboundAttachments', () => {
  it('inserts one ATTACHED row per stored attachment on the given comment, and marks it persisted', async () => {
    const email = withAttachments([
      { filename: 'r.pdf', contentType: 'application/pdf', size: 42, stored: stored('att-1') },
      { filename: 'x.eml', contentType: 'message/rfc822', size: 9, skipReason: 'unsupported_type' },
    ]);

    const n = await persistInboundAttachments(email, { ticketId: 't-1', orgId: 'o-1', commentId: 'c-1' });

    expect(n).toBe(1);
    expect(inserted).toHaveLength(1);
    expect(inserted[0]).toHaveLength(1);
    const row = inserted[0]![0]!;
    expect(row).toMatchObject({
      id: 'att-1',
      orgId: 'o-1',
      ticketId: 't-1',
      commentId: 'c-1',
      uploadedByUserId: null,
      storageBackend: 'db',
      storageKey: null,
      contentType: 'application/pdf',
      byteSize: 42,
      originalFilename: 'r.pdf',
      sha256: 'b'.repeat(64),
    });
    // ticket_attachments_attached_chk: comment_id NOT NULL <=> attached_at NOT NULL.
    expect(row.attachedAt).toBeInstanceOf(Date);
    expect(email.attachments[0]!.persisted).toBe(true);
    expect(email.attachments[1]!.persisted).toBeUndefined();
  });

  it('does not touch the DB when nothing was stored', async () => {
    const email = withAttachments([{ filename: 'x.eml', contentType: 'x', size: 1, skipReason: 'too_large' }]);
    expect(await persistInboundAttachments(email, { ticketId: 't', orgId: 'o', commentId: 'c' })).toBe(0);
    expect(inserted).toHaveLength(0);
  });
});

describe('inboundAttachmentNote', () => {
  it('returns null when nothing was skipped', () => {
    expect(inboundAttachmentNote(withAttachments([]))).toBeNull();
    expect(inboundAttachmentNote(withAttachments([
      { filename: 'r.pdf', contentType: 'application/pdf', size: 1, stored: stored('a') },
    ]))).toBeNull();
  });

  it('names every skipped file with its reason on ONE line', () => {
    const note = inboundAttachmentNote(withAttachments([
      { filename: 'huge.pdf', contentType: 'application/pdf', size: 1, skipReason: 'too_large' },
      { filename: 'orig.eml', contentType: 'message/rfc822', size: 1, skipReason: 'unsupported_type' },
      { filename: 'r.pdf', contentType: 'application/pdf', size: 1, stored: stored('a') },
    ]));
    expect(note).not.toBeNull();
    expect(note).not.toContain('\n');
    expect(note).toContain('huge.pdf (over the 10 MB limit)');
    expect(note).toContain('orig.eml (file type not supported)');
    expect(note).not.toContain('r.pdf');
  });

  it('names at most 10 files and summarises the rest', () => {
    const note = inboundAttachmentNote(withAttachments(Array.from({ length: 12 }, (_, i) => ({
      filename: `f${i}.eml`, contentType: 'message/rfc822', size: 1, skipReason: 'unsupported_type' as const,
    }))));
    expect(note).toContain('f9.eml');
    expect(note).not.toContain('f10.eml');
    expect(note).toMatch(/; and 2 more\]$/);
  });

  it('describes a whole-message retrieval failure without inventing filenames', () => {
    const note = inboundAttachmentNote(withAttachments([
      { filename: '', contentType: '', size: 0, skipReason: 'fetch_failed' },
    ]));
    expect(note).toMatch(/could not be retrieved/i);
  });
});

describe('hasStoredAttachments', () => {
  it('is true only when at least one attachment has stored bytes', () => {
    expect(hasStoredAttachments(withAttachments([]))).toBe(false);
    expect(hasStoredAttachments(withAttachments([{ filename: 'a', contentType: 'x', size: 1, skipReason: 'too_many' }]))).toBe(false);
    expect(hasStoredAttachments(withAttachments([{ filename: 'a', contentType: 'x', size: 1, stored: stored('s') }]))).toBe(true);
  });
});
