import { describe, expect, it } from 'vitest';
import { contentDispositionFor, sanitizeAttachmentFilename } from './attachmentFilename';

describe('sanitizeAttachmentFilename', () => {
  it('keeps only the basename and strips header-injection characters', () => {
    expect(sanitizeAttachmentFilename('../../etc/passwd')).toBe('passwd');
    // A backslash is a path separator here, so only the last segment survives;
    // the quote and the CR/LF are then removed outright (header-injection).
    expect(sanitizeAttachmentFilename('a"b\\c\r\nd.pdf')).toBe('cd.pdf');
    expect(sanitizeAttachmentFilename('a"b.pdf')).toBe('ab.pdf');
  });

  it('falls back to a constant rather than an empty name', () => {
    expect(sanitizeAttachmentFilename('')).toBe('attachment');
    expect(sanitizeAttachmentFilename('/')).toBe('attachment');
  });

  it('caps the length at 255', () => {
    expect(sanitizeAttachmentFilename(`${'a'.repeat(300)}.pdf`)).toHaveLength(255);
  });
});

describe('contentDispositionFor', () => {
  it('previews images inline and downloads everything else', () => {
    expect(contentDispositionFor('image/png', 'shot.png')).toMatch(/^inline; /);
    expect(contentDispositionFor('application/pdf', 'run.pdf')).toMatch(/^attachment; /);
  });

  it('carries a non-ASCII name in filename* and an ASCII-safe fallback in the quoted form', () => {
    // A latin-1-only header value would throw ERR_INVALID_CHAR and 500 the
    // content route, making an ordinary upload permanently unreadable.
    const header = contentDispositionFor('image/png', '\u5199\u771f.png');
    expect(header).toContain("filename*=UTF-8''%E5%86%99%E7%9C%9F.png");
    expect(header).toMatch(/filename="[\x20-\x7e]*"/);
    // eslint-disable-next-line no-control-regex
    expect(/[^\x00-\xff]/.test(header)).toBe(false);
  });

  it('never emits a raw quote or CRLF even when the stored name carries one', () => {
    const header = contentDispositionFor('application/pdf', 'evil".pdf');
    expect(header).not.toMatch(/[\r\n]/);
    expect(header.match(/"/g) ?? []).toHaveLength(2);
  });
});
