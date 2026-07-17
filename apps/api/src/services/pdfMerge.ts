// Uploaded-contract PDF merge (Task 14 of the contract documents + enhanced
// proposals plan). An uploaded contract block (a pre-signed/pre-formatted
// PDF the tech attaches, as opposed to an authored rich-text one) can't be
// drawn by pdfkit — pdfkit builds a document from scratch and has no "embed
// this existing PDF's pages" primitive. pdf-lib does: it can load an
// already-rendered PDF buffer and copy its pages into another document.
//
// v1 LIMITATION (documented, not a bug): every upload is APPENDED after the
// main document's pages, in the order given — never interleaved at the exact
// point in the main document where its marker line was drawn (quotePdf.ts's
// `<templateName> — attached below` line). Locating that marker's page/byte
// position in an already-rendered pdfkit buffer would require re-parsing the
// PDF's text layer (pdfkit doesn't expose draw positions after the fact), which
// is real work for a case ("contract(s) at the end of the proposal") that is
// already the common usage — so it's deferred rather than built speculatively.
// `afterMarker` is carried on each upload entry for that future interleaving
// pass; v1 doesn't use it for placement, only pdf-lib page order does.

import { PDFDocument } from 'pdf-lib';

export interface UploadedContractPdf {
  /** The exact marker line quotePdf.ts drew for this block (contractUploadedMarker
   *  in quotePdf.ts) — unused for placement in v1 (see file header), kept so a
   *  future interleaving pass has the anchor text without a signature change. */
  afterMarker: string;
  data: Buffer;
}

/** Append every upload's pages after `mainPdf`'s own pages, in array order.
 *  A no-op (returns `mainPdf` unchanged) when `uploads` is empty — the common
 *  case (no uploaded contract blocks on the quote) never pays the pdf-lib
 *  load/save round-trip. */
export async function mergeUploadedContractPdfs(
  mainPdf: Buffer,
  uploads: UploadedContractPdf[],
): Promise<Buffer> {
  if (uploads.length === 0) return mainPdf;

  const mainDoc = await PDFDocument.load(mainPdf);
  for (const upload of uploads) {
    const uploadDoc = await PDFDocument.load(upload.data);
    const copiedPages = await mainDoc.copyPages(uploadDoc, uploadDoc.getPageIndices());
    for (const page of copiedPages) mainDoc.addPage(page);
  }
  return Buffer.from(await mainDoc.save());
}
