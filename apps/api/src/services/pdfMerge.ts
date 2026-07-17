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

/** A merge input that pdf-lib can't load (encrypted, truncated, or otherwise
 *  corrupt). Uploads are validated at write time (contractTemplateService's
 *  createUploadedVersion), so this is a defense-in-depth backstop — surfacing a
 *  typed 4xx-mappable error instead of an uncaught pdf-lib throw that becomes a
 *  raw 500 on the admin/portal quote PDF (and a silently-skipped send email). */
export class PdfMergeError extends Error {
  constructor(
    message: string,
    // Literal union so Hono's c.json(status) overloads accept it directly.
    public status: 400 | 422 | 500 = 422,
    public code = 'CONTRACT_PDF_UNREADABLE',
  ) {
    super(message);
    this.name = 'PdfMergeError';
  }
}

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
    let uploadDoc: PDFDocument;
    try {
      uploadDoc = await PDFDocument.load(upload.data);
    } catch (err) {
      // Uploads are pre-validated at write time, so reaching here means a stored
      // version's bytes are unreadable (encrypted/corrupt). Raise a typed error a
      // route can map to a 4xx rather than letting the raw pdf-lib throw 500.
      throw new PdfMergeError(
        `An attached contract PDF could not be read: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    const copiedPages = await mainDoc.copyPages(uploadDoc, uploadDoc.getPageIndices());
    for (const page of copiedPages) mainDoc.addPage(page);
  }
  return Buffer.from(await mainDoc.save());
}
