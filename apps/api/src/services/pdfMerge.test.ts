import { describe, it, expect } from 'vitest';
import { PDFDocument } from 'pdf-lib';
import { mergeUploadedContractPdfs, PdfMergeError, MAX_MERGED_PAGES } from './pdfMerge';

async function makePdf(pageCount: number): Promise<Buffer> {
  const doc = await PDFDocument.create();
  for (let i = 0; i < pageCount; i++) doc.addPage();
  return Buffer.from(await doc.save());
}

/** A minimal ENCRYPTED PDF (valid magic, trailer references a /Standard /Encrypt
 *  dict). pdf-lib refuses to load it — see contractTemplateService.test.ts for
 *  the full provenance note. Uploads are validated at write time, so reaching
 *  mergeUploadedContractPdfs with such bytes is the defense-in-depth case. */
function encryptedPdfBytes(): Buffer {
  const objs: Record<number, string> = {
    1: '<< /Type /Catalog /Pages 2 0 R >>',
    2: '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    3: '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] >>',
    4: '<< /Filter /Standard /V 1 /R 2 /O <0123456789ABCDEF0123456789ABCDEF> /U <0123456789ABCDEF0123456789ABCDEF> /P -44 >>',
  };
  let body = '%PDF-1.4\n';
  const offsets: Record<number, number> = {};
  for (let i = 1; i <= 4; i++) {
    offsets[i] = Buffer.byteLength(body, 'latin1');
    body += `${i} 0 obj\n${objs[i]}\nendobj\n`;
  }
  const xrefStart = Buffer.byteLength(body, 'latin1');
  let xref = 'xref\n0 5\n0000000000 65535 f \n';
  for (let i = 1; i <= 4; i++) xref += String(offsets[i]).padStart(10, '0') + ' 00000 n \n';
  body += xref;
  body += 'trailer\n<< /Size 5 /Root 1 0 R /Encrypt 4 0 R /ID [<0123456789ABCDEF0123456789ABCDEF> <0123456789ABCDEF0123456789ABCDEF>] >>\n';
  body += `startxref\n${xrefStart}\n%%EOF\n`;
  return Buffer.from(body, 'latin1');
}

async function pageCountOf(pdf: Buffer): Promise<number> {
  return (await PDFDocument.load(pdf)).getPageCount();
}

describe('mergeUploadedContractPdfs', () => {
  it('returns the main PDF unchanged when there are no uploads', async () => {
    const main = await makePdf(2);
    const merged = await mergeUploadedContractPdfs(main, []);
    expect(await pageCountOf(merged)).toBe(2);
  });

  it('appends a single upload PDF after the main document', async () => {
    const main = await makePdf(2);
    const upload = await makePdf(3);
    const merged = await mergeUploadedContractPdfs(main, [{ afterMarker: 'NDA — attached below', data: upload }]);
    expect(await pageCountOf(merged)).toBe(2 + 3);
  });

  it('appends multiple uploads in array order, page count = main + sum(upload pages)', async () => {
    const main = await makePdf(1);
    const uploadA = await makePdf(2);
    const uploadB = await makePdf(4);
    const merged = await mergeUploadedContractPdfs(main, [
      { afterMarker: 'MSA — attached below', data: uploadA },
      { afterMarker: 'SOW — attached below', data: uploadB },
    ]);
    expect(await pageCountOf(merged)).toBe(1 + 2 + 4);
  });

  it('produces a valid PDF buffer (starts with the %PDF magic bytes)', async () => {
    const main = await makePdf(1);
    const upload = await makePdf(1);
    const merged = await mergeUploadedContractPdfs(main, [{ afterMarker: 'x', data: upload }]);
    expect(merged.subarray(0, 4).toString()).toBe('%PDF');
  });

  it('throws a typed PdfMergeError (not a raw pdf-lib throw) when an upload is unloadable/encrypted', async () => {
    const main = await makePdf(1);
    const encrypted = encryptedPdfBytes();
    await expect(
      mergeUploadedContractPdfs(main, [{ afterMarker: 'MSA — attached below', data: encrypted }]),
    ).rejects.toBeInstanceOf(PdfMergeError);
    // The typed error carries a 4xx status a route can surface instead of a 500.
    await expect(
      mergeUploadedContractPdfs(main, [{ afterMarker: 'MSA — attached below', data: encrypted }]),
    ).rejects.toMatchObject({ status: 422, code: 'CONTRACT_PDF_UNREADABLE' });
  });

  it('throws a typed PdfMergeError when the aggregate page count exceeds the cap', async () => {
    const main = await makePdf(1);
    const hugeUpload = await makePdf(MAX_MERGED_PAGES); // main(1) + upload(cap) > cap
    await expect(
      mergeUploadedContractPdfs(main, [{ afterMarker: 'MSA — attached below', data: hugeUpload }]),
    ).rejects.toMatchObject({ status: 422, code: 'CONTRACT_PDF_PAGE_LIMIT_EXCEEDED' });
  });

  it('allows a merge that lands exactly at the page cap', async () => {
    const main = await makePdf(1);
    const upload = await makePdf(MAX_MERGED_PAGES - 1); // main(1) + upload = exactly the cap
    const merged = await mergeUploadedContractPdfs(main, [{ afterMarker: 'MSA — attached below', data: upload }]);
    expect(await pageCountOf(merged)).toBe(MAX_MERGED_PAGES);
  });
});
