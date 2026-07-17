import { describe, it, expect } from 'vitest';
import { PDFDocument } from 'pdf-lib';
import { mergeUploadedContractPdfs } from './pdfMerge';

async function makePdf(pageCount: number): Promise<Buffer> {
  const doc = await PDFDocument.create();
  for (let i = 0; i < pageCount; i++) doc.addPage();
  return Buffer.from(await doc.save());
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
});
