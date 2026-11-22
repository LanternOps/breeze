import { describe, expect, it } from 'vitest';
import { PDFDocument } from 'pdf-lib';
import { MAX_PDF_LOAD_DECODED_BYTES, PdfLoadLimitError, loadPdfDocument } from './pdfLoadLimits';
import { pdfWithExpandingStreams } from './__fixtures__/expandingPdf';

const MB = 1024 * 1024;

/** A PDF pdf-lib refuses as encrypted (trailer /Encrypt; see pdfMerge.test.ts). */
function encryptedPdfBytes(): Buffer {
  const objs = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] >>',
    '<< /Filter /Standard /V 1 /R 2 /O <0123456789ABCDEF0123456789ABCDEF> /U <0123456789ABCDEF0123456789ABCDEF> /P -44 >>',
  ];
  let body = '%PDF-1.4\n';
  const offsets: number[] = [];
  objs.forEach((o, i) => {
    offsets.push(Buffer.byteLength(body, 'latin1'));
    body += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xref = Buffer.byteLength(body, 'latin1');
  body += `xref\n0 5\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`;
  body += 'trailer\n<< /Size 5 /Root 1 0 R /Encrypt 4 0 R /ID [<0123456789ABCDEF0123456789ABCDEF> <0123456789ABCDEF0123456789ABCDEF>] >>\n';
  body += `startxref\n${xref}\n%%EOF\n`;
  return Buffer.from(body, 'latin1');
}

describe('loadPdfDocument', () => {
  it('loads an ordinary PDF that uses object streams, as PDFDocument.load does', async () => {
    const source = await PDFDocument.create();
    source.addPage([612, 792]);
    source.addPage([300, 400]);
    const bytes = await source.save({ useObjectStreams: true });
    expect(Buffer.from(bytes).includes(Buffer.from('/ObjStm'))).toBe(true);

    const doc = await loadPdfDocument(bytes);
    expect(doc.getPageCount()).toBe(2);
    expect(doc.getPage(1).getSize()).toEqual({ width: 300, height: 400 });
    // The loaded document works like any other: its pages copy and it saves.
    const out = await PDFDocument.create();
    for (const page of await out.copyPages(doc, doc.getPageIndices())) out.addPage(page);
    expect((await PDFDocument.load(await out.save())).getPageCount()).toBe(2);
  });

  it('refuses a PDF whose object stream inflates past the limit', async () => {
    const pdf = pdfWithExpandingStreams([{ inflatesTo: 2 * MB }]);
    await expect(loadPdfDocument(pdf, { maxDecodedBytes: MB })).rejects.toBeInstanceOf(PdfLoadLimitError);
    expect((await loadPdfDocument(pdf, { maxDecodedBytes: 3 * MB })).getPageCount()).toBe(1);
  });

  it('counts every decompressed stream in the document together', async () => {
    const pdf = pdfWithExpandingStreams([{ inflatesTo: 0.6 * MB }, { inflatesTo: 0.6 * MB }]);
    await expect(loadPdfDocument(pdf, { maxDecodedBytes: MB })).rejects.toBeInstanceOf(PdfLoadLimitError);
    expect((await loadPdfDocument(pdfWithExpandingStreams([{ inflatesTo: 0.6 * MB }]), { maxDecodedBytes: MB })).getPageCount()).toBe(1);
  });

  it('counts cross-reference streams, and a /Type written with name escapes', async () => {
    for (const type of ['XRef', 'Obj#53tm', 'X#52ef']) {
      const pdf = pdfWithExpandingStreams([{ inflatesTo: 2 * MB, type }]);
      await expect(loadPdfDocument(pdf, { maxDecodedBytes: MB }), type).rejects.toBeInstanceOf(PdfLoadLimitError);
    }
  });

  it('applies the default limit', async () => {
    const pdf = pdfWithExpandingStreams([{ inflatesTo: MAX_PDF_LOAD_DECODED_BYTES + MB }]);
    await expect(loadPdfDocument(pdf)).rejects.toBeInstanceOf(PdfLoadLimitError);
  });

  it('keeps PDFDocument.load behaviour for encryption and metadata', async () => {
    // By message, as contractTemplateService matches it: pdf-lib's CJS and ESM
    // builds can both be loaded, and then `instanceof` fails across them.
    await expect(loadPdfDocument(encryptedPdfBytes())).rejects.toThrow(/encrypted/i);
    await expect(PDFDocument.load(encryptedPdfBytes())).rejects.toThrow(/encrypted/i);
    const bytes = pdfWithExpandingStreams([]);
    expect((await loadPdfDocument(bytes, { updateMetadata: false })).getProducer()).toBeUndefined();
    expect((await loadPdfDocument(bytes)).getProducer()).toBe((await PDFDocument.load(bytes)).getProducer());
  });
});
