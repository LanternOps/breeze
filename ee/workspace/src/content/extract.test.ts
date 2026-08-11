import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import { extractContent } from './extract';

const EML = Buffer.from([
  'From: Paul Deluca <pdeluca@fairoaksca.gov>',
  'To: Maria Cortez <mcortez@aldercreekeng.com>',
  'Cc: Ray Otero <rotero@fairoaksca.gov>',
  'Subject: RE: PO 4021 - pipe submittal resubmittal',
  'Date: 16 Jul 2024 08:26:40 -0700',
  '',
  'Maria,',
  '',
  'Only DR-18 was approved for PO 4021.',
  '',
  'Paul',
].join('\r\n'));

describe('extractContent', () => {
  it('extracts markdown as utf8 with a sha256 of the bytes', async () => {
    const bytes = Buffer.from('# Grant of Easement\n\nHenderson Road Water Main Replacement Project.');
    const r = await extractContent('scan_0034.md', bytes, 2 * 1024 * 1024);
    expect(r.status).toBe('extracted');
    if (r.status !== 'extracted') return;
    expect(r.text).toContain('Grant of Easement');
    expect(r.contentHash).toBe(createHash('sha256').update(bytes).digest('hex'));
    expect(r.emailMeta).toBeNull();
  });

  it('treats .TXT (any case) as text', async () => {
    const r = await extractContent('SCAN0007.TXT', Buffer.from('RECORD OF SURVEY'), 1024);
    expect(r.status).toBe('extracted');
  });

  it('parses .eml: searchable text includes subject, participants, and body; emailMeta is structured', async () => {
    const r = await extractContent('new - re PO 4021.eml', EML, 2 * 1024 * 1024);
    expect(r.status).toBe('extracted');
    if (r.status !== 'extracted') return;
    expect(r.text).toContain('RE: PO 4021 - pipe submittal resubmittal');
    expect(r.text).toContain('Only DR-18 was approved');
    expect(r.text).toContain('pdeluca@fairoaksca.gov');
    expect(r.emailMeta).toMatchObject({
      from: expect.stringContaining('pdeluca@fairoaksca.gov'),
      subject: 'RE: PO 4021 - pipe submittal resubmittal',
    });
    expect(r.emailMeta?.to?.[0]).toContain('mcortez@aldercreekeng.com');
  });

  it('skips unknown extensions as binary', async () => {
    const r = await extractContent('photo.jpg', Buffer.from([0xff, 0xd8, 0xff]), 1024);
    expect(r.status).toBe('skipped_binary');
  });

  it('skips oversized files', async () => {
    const r = await extractContent('big.md', Buffer.alloc(2048, 97), 1024);
    expect(r.status).toBe('skipped_too_large');
  });
});
