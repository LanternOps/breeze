import { describe, it, expect, vi, beforeEach } from 'vitest';
import { TICKET_ATTACHMENT_LIMITS } from '@breeze/shared';

const { listMock, getBytesMock, tokenMock, putBytesMock, deleteBytesMock } = vi.hoisted(() => ({
  listMock: vi.fn(),
  getBytesMock: vi.fn(),
  tokenMock: vi.fn(),
  putBytesMock: vi.fn(),
  deleteBytesMock: vi.fn(),
}));

// Graph is ALWAYS mocked — these tests never reach Microsoft.
vi.mock('./graphMailClient', () => ({
  listMessageAttachments: listMock,
  getFileAttachmentBytes: getBytesMock,
}));
vi.mock('./mailboxToken', () => ({ getMailboxToken: tokenMock }));
vi.mock('../ticketAttachmentStorage', async () => {
  const { BlobStorageError } = await vi.importActual<typeof import('../blobStorage')>('../blobStorage');
  return { putBytes: putBytesMock, deleteBytes: deleteBytesMock, AttachmentStorageError: BlobStorageError };
});
vi.mock('../sentry', () => ({ captureException: vi.fn() }));

import { prepareM365Attachments, discardUnpersistedAttachments } from './fetchInboundAttachments';
import { BlobStorageError } from '../blobStorage';
import type { NormalizedInboundEmail } from '../inboundEmail/types';

const FILE = '#microsoft.graph.fileAttachment';
const ITEM = '#microsoft.graph.itemAttachment';
const PDF = Buffer.from('%PDF-1.7\nhello');
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d]);

function m365Email(overrides: Partial<NormalizedInboundEmail> = {}): NormalizedInboundEmail {
  return {
    provider: 'm365',
    providerMessageId: 'graph-msg-1',
    to: 'support@a.com',
    from: 'cust@x.com',
    subject: 's',
    text: 't',
    hasAttachments: true,
    attachments: [],
    raw: {},
    ...overrides,
  };
}

const ctx = { tenantId: '11111111-1111-4111-8111-111111111111', finalAttempt: false };

beforeEach(() => {
  vi.clearAllMocks();
  tokenMock.mockResolvedValue('tok');
  putBytesMock.mockImplementation(async () => ({ backend: 's3', storageKey: 'ticket-attachments/x', data: null }));
  deleteBytesMock.mockResolvedValue(undefined);
});

describe('prepareM365Attachments', () => {
  it('one file attachment + one inline image -> exactly one stored attachment', async () => {
    listMock.mockResolvedValue([
      { id: 'a1', name: 'report.pdf', contentType: 'application/pdf', size: PDF.length, isInline: false, '@odata.type': FILE },
      { id: 'a2', name: 'image001.png', contentType: 'image/png', size: PNG.length, isInline: true, '@odata.type': FILE },
    ]);
    getBytesMock.mockResolvedValue(PDF);
    const email = m365Email();

    await prepareM365Attachments(email, ctx);

    expect(listMock).toHaveBeenCalledWith('tok', 'support@a.com', 'graph-msg-1');
    // The inline image is never downloaded — it is part of the rendered body.
    expect(getBytesMock).toHaveBeenCalledTimes(1);
    expect(getBytesMock).toHaveBeenCalledWith('tok', 'support@a.com', 'graph-msg-1', 'a1');
    expect(putBytesMock).toHaveBeenCalledTimes(1);
    expect(email.attachments).toHaveLength(1);
    const [att] = email.attachments;
    expect(att!.filename).toBe('report.pdf');
    expect(att!.skipReason).toBeUndefined();
    expect(att!.stored).toMatchObject({
      contentType: 'application/pdf', // sniffed
      byteSize: PDF.length,
      storageBackend: 's3',
      storageKey: 'ticket-attachments/x',
    });
    expect(att!.stored!.sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it('skips an oversized attachment WITHOUT downloading it, recording the reason', async () => {
    listMock.mockResolvedValue([
      { id: 'big', name: 'huge.pdf', contentType: 'application/pdf', size: 30 * 1024 * 1024, isInline: false, '@odata.type': FILE },
    ]);
    const email = m365Email();

    await prepareM365Attachments(email, ctx);

    expect(getBytesMock).not.toHaveBeenCalled();
    expect(putBytesMock).not.toHaveBeenCalled();
    expect(email.attachments).toEqual([
      expect.objectContaining({ filename: 'huge.pdf', skipReason: 'too_large' }),
    ]);
  });

  it('skips a download whose decoded bytes exceed the cap even if Graph under-reported size', async () => {
    listMock.mockResolvedValue([
      { id: 'a1', name: 'liar.pdf', contentType: 'application/pdf', size: 10, isInline: false, '@odata.type': FILE },
    ]);
    getBytesMock.mockResolvedValue(Buffer.concat([PDF, Buffer.alloc(TICKET_ATTACHMENT_LIMITS.maxBytes)]));
    const email = m365Email();

    await prepareM365Attachments(email, ctx);

    expect(putBytesMock).not.toHaveBeenCalled();
    expect(email.attachments[0]).toMatchObject({ filename: 'liar.pdf', skipReason: 'too_large' });
  });

  it('records a forwarded Outlook item and an unsniffable .eml as unsupported, never storing them', async () => {
    listMock.mockResolvedValue([
      { id: 'i1', name: 'Fwd: printer', contentType: null, size: 900, isInline: false, '@odata.type': ITEM },
      { id: 'e1', name: 'orig.eml', contentType: 'message/rfc822', size: 20, isInline: false, '@odata.type': FILE },
    ]);
    getBytesMock.mockResolvedValue(Buffer.from('From: a@b.c\r\nSubject: x\r\n'));
    const email = m365Email();

    await prepareM365Attachments(email, ctx);

    expect(getBytesMock).toHaveBeenCalledTimes(1); // only the fileAttachment is downloaded
    expect(putBytesMock).not.toHaveBeenCalled();
    expect(email.attachments.map((a) => [a.filename, a.skipReason])).toEqual([
      ['Fwd: printer', 'unsupported_type'],
      ['orig.eml', 'unsupported_type'],
    ]);
  });

  it(`imports at most ${TICKET_ATTACHMENT_LIMITS.maxPerComment} files and records the rest as too_many`, async () => {
    const n = TICKET_ATTACHMENT_LIMITS.maxPerComment + 2;
    listMock.mockResolvedValue(Array.from({ length: n }, (_, i) => ({
      id: `a${i}`, name: `f${i}.pdf`, contentType: 'application/pdf', size: PDF.length, isInline: false, '@odata.type': FILE,
    })));
    getBytesMock.mockResolvedValue(PDF);
    const email = m365Email();

    await prepareM365Attachments(email, ctx);

    expect(putBytesMock).toHaveBeenCalledTimes(TICKET_ATTACHMENT_LIMITS.maxPerComment);
    expect(email.attachments.filter((a) => a.skipReason === 'too_many').map((a) => a.filename))
      .toEqual([`f${n - 2}.pdf`, `f${n - 1}.pdf`]);
  });

  it('records storage_failed (and keeps going) when the blob store rejects a put', async () => {
    listMock.mockResolvedValue([
      { id: 'a1', name: 'r.pdf', contentType: 'application/pdf', size: PDF.length, isInline: false, '@odata.type': FILE },
    ]);
    getBytesMock.mockResolvedValue(PDF);
    putBytesMock.mockRejectedValueOnce(new BlobStorageError('down'));
    const email = m365Email();

    await prepareM365Attachments(email, ctx);

    expect(email.attachments[0]).toMatchObject({ filename: 'r.pdf', skipReason: 'storage_failed' });
    expect(email.attachments[0]!.stored).toBeUndefined();
  });

  it('a Graph failure on a NON-final attempt throws (so BullMQ retries) and deletes blobs already put', async () => {
    listMock.mockResolvedValue([
      { id: 'a1', name: 'one.pdf', contentType: 'application/pdf', size: PDF.length, isInline: false, '@odata.type': FILE },
      { id: 'a2', name: 'two.pdf', contentType: 'application/pdf', size: PDF.length, isInline: false, '@odata.type': FILE },
    ]);
    getBytesMock.mockResolvedValueOnce(PDF).mockRejectedValueOnce(Object.assign(new Error('Graph 503'), { status: 503 }));
    const email = m365Email();

    await expect(prepareM365Attachments(email, ctx)).rejects.toThrow('Graph 503');
    expect(deleteBytesMock).toHaveBeenCalledTimes(1);
    expect(deleteBytesMock.mock.calls[0]![0]).toMatchObject({ storageBackend: 's3', storageKey: 'ticket-attachments/x' });
  });

  it('a Graph failure on the FINAL attempt degrades to a fetch_failed note instead of losing the email', async () => {
    listMock.mockRejectedValue(Object.assign(new Error('Graph 500'), { status: 500 }));
    const email = m365Email();

    await prepareM365Attachments(email, { ...ctx, finalAttempt: true });

    expect(email.attachments).toEqual([expect.objectContaining({ skipReason: 'fetch_failed' })]);
  });

  it('is a no-op (no token, no Graph call) when hasAttachments is false', async () => {
    const email = m365Email({ hasAttachments: false });

    await prepareM365Attachments(email, ctx);

    expect(tokenMock).not.toHaveBeenCalled();
    expect(listMock).not.toHaveBeenCalled();
    expect(email.attachments).toEqual([]);
  });

  it('is a no-op for a non-M365 provider', async () => {
    const email = m365Email({ provider: 'mailgun' });
    await prepareM365Attachments(email, ctx);
    expect(listMock).not.toHaveBeenCalled();
  });
});

describe('discardUnpersistedAttachments', () => {
  it('deletes stored blobs whose row was never inserted, and leaves persisted ones alone', async () => {
    const stored = (key: string) => ({
      attachmentId: key, contentType: 'application/pdf', byteSize: 1, sha256: 'a'.repeat(64),
      storageBackend: 's3' as const, storageKey: key, data: null,
    });
    const email = m365Email({
      attachments: [
        { filename: 'kept.pdf', contentType: 'application/pdf', size: 1, stored: stored('k1'), persisted: true },
        { filename: 'orphan.pdf', contentType: 'application/pdf', size: 1, stored: stored('k2') },
        { filename: 'skip.eml', contentType: 'message/rfc822', size: 1, skipReason: 'unsupported_type' },
      ],
    });

    await discardUnpersistedAttachments(email);

    expect(deleteBytesMock).toHaveBeenCalledTimes(1);
    expect(deleteBytesMock.mock.calls[0]![0]).toMatchObject({ storageKey: 'k2' });
  });

  it('never throws when the compensating delete fails', async () => {
    deleteBytesMock.mockRejectedValueOnce(new Error('s3 down'));
    const email = m365Email({
      attachments: [{
        filename: 'o.pdf', contentType: 'application/pdf', size: 1,
        stored: { attachmentId: 'x', contentType: 'application/pdf', byteSize: 1, sha256: 'a'.repeat(64), storageBackend: 's3', storageKey: 'k', data: null },
      }],
    });
    await expect(discardUnpersistedAttachments(email)).resolves.toBeUndefined();
  });
});
