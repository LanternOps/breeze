import type { Context } from 'hono';
import { z } from 'zod';
import { contentDispositionFor } from './attachmentFilename';
import { loadCertifiedAgreementInput, renderCertifiedAgreementPdf } from './agreementCertificate';
import { PdfMergeError } from './pdfMerge';
import { captureException } from './sentry';

/**
 * The ONE signed-agreement download (#9075 W2c spec §3.8; shared with the
 * portal in W3a): the staff route `GET /contracts/contract-documents/:id/pdf`
 * and the portal route `GET /portal/signed-agreements/:documentId/file` both
 * build their response here, so the copy variants, filenames, fallback policy
 * and cache headers cannot drift between the two audiences.
 *
 * ACCESS IS THE CALLER'S. Each route proves the viewer may read the document
 * (staff: getContractDocumentPdf under the caller's RLS; portal: an org-scoped
 * read of the row) BEFORE calling buildSignedAgreementDownload, which reads
 * the certificate inputs under system scope (loadCertifiedAgreementInput) so
 * the bytes do not vary by viewer. It is never an authorization step.
 */

/** Which copy to download. The certified copy (original + signature
 *  certificate page, derived on demand) is the default; `original` is the
 *  stored bytes, for hash verification. */
export const signedAgreementCopyQuery = z.object({ copy: z.enum(['certified', 'original']).default('certified') });

export type SignedAgreementCopy = 'certified' | 'original';

/** File extension for a signed agreement's STORED MIME (spec §3.4): an
 *  externally signed scan is a PNG/JPEG, not a PDF, and must download as one.
 *  freezeSignedAgreement only ever stores these three, so the `.pdf` fallback
 *  is for legacy rows (all PDFs); Content-Type always carries the real MIME. */
const SIGNED_AGREEMENT_EXT: Record<string, string> = {
  'application/pdf': 'pdf',
  'image/png': 'png',
  'image/jpeg': 'jpg',
};

/** The certified copy is always a PDF; the original keeps its stored MIME and
 *  says it is the original, so a fallback download is never mistaken for the
 *  certified one. Mirrored by the web's and the portal's signedAgreementFilename. */
export function signedAgreementFilename(id: string, mime: string, copy: SignedAgreementCopy): string {
  return copy === 'certified'
    ? `signed-agreement-${id}.pdf`
    : `signed-agreement-${id}-original.${SIGNED_AGREEMENT_EXT[mime] ?? 'pdf'}`;
}

export interface SignedAgreementDownload {
  response: Response;
  /** The variant actually served (a certified request can fall back). */
  served: SignedAgreementCopy;
  byteLength: number;
}

/**
 * Build the download for a document the caller has ALREADY authorized.
 * Returns null when the document vanished between the caller's check and the
 * certificate read (the caller answers that exactly like "never there").
 *
 *   copy=certified — the frozen original plus a derived certificate page;
 *     always a PDF. Only an unreadable/oversized original (PdfMergeError)
 *     degrades to the original — named and reported as the original, served
 *     `no-store` so it never sticks in a cache in place of the certified copy.
 *     Anything else (a missing font, a bug) throws: a loud 500.
 *   copy=original  — the stored bytes byte-for-byte under the stored MIME.
 *
 * Always a download (`attachment`), never rendered inline in the app origin.
 */
export async function buildSignedAgreementDownload(
  c: Context,
  input: {
    documentId: string;
    storedBytes: Buffer | Uint8Array;
    storedMime: string;
    copy: SignedAgreementCopy;
    /** Sentry `area` tag for a fallback (staff vs portal). */
    area: string;
  },
): Promise<SignedAgreementDownload | null> {
  const { documentId: id, copy } = input;
  let body: Uint8Array<ArrayBuffer>;
  let mime = input.storedMime;
  let served: SignedAgreementCopy = 'original';
  if (copy === 'certified') {
    const certified = await loadCertifiedAgreementInput(id);
    if (!certified) return null;
    try {
      body = new Uint8Array(await renderCertifiedAgreementPdf(certified));
      mime = 'application/pdf';
      served = 'certified';
    } catch (err) {
      if (!(err instanceof PdfMergeError)) throw err;
      console.warn('[signedAgreementDownload] certified copy unavailable — serving the original', { id, area: input.area, code: err.code, message: err.message });
      // Bounded fingerprint (the code, never the id) so one bad document's
      // retries group as one issue; the id rides in the tags.
      captureException(err, c, { area: 'agreement-certificate', surface: input.area, documentId: id }, {
        fingerprint: ['agreement-certificate-fallback', err.code],
      });
      body = new Uint8Array(input.storedBytes);
    }
  } else {
    body = new Uint8Array(input.storedBytes);
  }

  const response = new Response(body, {
    status: 200,
    headers: {
      'Content-Type': mime,
      'Content-Length': String(body.byteLength),
      'Content-Disposition': contentDispositionFor(mime, signedAgreementFilename(id, mime, served))
        .replace(/^inline;/, 'attachment;'),
      'X-Agreement-Copy': served,
      'X-Content-Type-Options': 'nosniff',
      // A fallback original must not stick in the browser cache in place of
      // the certified copy once the cause is fixed.
      'Cache-Control': copy === 'certified' && served === 'original' ? 'no-store' : 'private, max-age=300',
    },
  });
  return { response, served, byteLength: body.byteLength };
}
