import { z } from 'zod';
import { QUOTE_ACCEPT_ON_BEHALF_METHODS } from './quotes';

// Standalone agreement requests (#8865). W1c: "Record signed agreement" — an
// MSP tech records an agreement the client signed elsewhere (DocuSign, wet
// ink, email). Same method tuple and evidence rule as quote accept-on-behalf:
// `reference` is required, because a signature recorded with nothing behind it
// is a claim, not a record.

/** How far in the future `signedAt` may be (clock skew between the tech's
 *  browser and the API). The rule is enforced by the service, which owns `now`;
 *  the schema only coerces. */
export const AGREEMENT_SIGNED_AT_SKEW_MS = 5 * 60 * 1000;

// validators/quotes.ts keeps its isoDate private; redeclared here — and
// stricter: the shape alone lets `2026-02-30` through to the Postgres `date`
// column, which rejects it as a 500 instead of a 400.
const isoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'expected YYYY-MM-DD')
  .refine((s) => {
    const d = new Date(`${s}T00:00:00Z`);
    return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
  }, 'not a real calendar date');

/** Earliest signing date accepted. `z.coerce.date()` turns stray input such as
 *  "1" into a real but absurd instant; a signed agreement predating 1900 is
 *  input garbage, not history. */
const SIGNED_AT_MIN = new Date('1900-01-01T00:00:00Z');

/** Body for POST /contracts/agreement-requests/record-signed (multipart; feed
 *  the form through recordSignedAgreementFromForm first). */
export const recordSignedAgreementSchema = z.object({
  orgId: z.string().guid(),
  templateVersionId: z.string().guid(),
  contractId: z.string().guid().optional().nullable(),
  label: z.string().trim().max(255).optional().nullable(),
  variableValues: z.record(z.string(), z.string().max(2000)).default({}),
  signerName: z.string().trim().min(1).max(255),
  signerEmail: z.string().trim().email().max(255).optional().nullable(),
  /** The real signing date — may be in the past; not later than now + skew. */
  signedAt: z.coerce.date().min(SIGNED_AT_MIN, 'signedAt is before 1900'),
  effectiveDate: isoDate.optional().nullable(),
  method: z.enum(QUOTE_ACCEPT_ON_BEHALF_METHODS),
  reference: z.string().trim().min(1).max(500),
});

export type RecordSignedAgreementInput = z.infer<typeof recordSignedAgreementSchema>;

// Optional scalars a browser form sends as '' when left empty. An empty string
// would fail `.guid()` / `.email()` / the date regex, so it becomes "absent".
const OPTIONAL_FORM_SCALARS = ['contractId', 'label', 'signerEmail', 'effectiveDate'] as const;

/** Multipart carries every scalar as a string; this is the pre-parse shape the
 *  route feeds into recordSignedAgreementSchema. `variableValues` is
 *  JSON-parsed when it is a string (invalid JSON is passed through unchanged so
 *  the schema reports a 400, never a throw), defaulting to {}. The `file` part
 *  is dropped — the route handles it separately. */
export function recordSignedAgreementFromForm(fields: Record<string, unknown>): unknown {
  const out: Record<string, unknown> = { ...fields };
  delete out.file;
  for (const key of OPTIONAL_FORM_SCALARS) {
    if (typeof out[key] === 'string' && (out[key] as string).trim() === '') delete out[key];
  }
  const raw = fields.variableValues;
  if (typeof raw === 'string') {
    if (raw.trim() === '') {
      out.variableValues = {};
    } else {
      try {
        out.variableValues = JSON.parse(raw);
      } catch {
        out.variableValues = raw;
      }
    }
  } else if (raw === undefined || raw === null) {
    out.variableValues = {};
  }
  return out;
}
