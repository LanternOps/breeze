// Typed fetch wrapper for the "Record signed agreement" endpoint
// (POST /contracts/agreement-requests/record-signed, #8865 W1c). Same idiom as
// contractDocuments.ts: a raw Response comes back and callers wrap it in
// `runAction`.

import type { QuoteAcceptOnBehalfMethod } from '@breeze/shared';
import { fetchWithAuth } from '../../stores/auth';

/** Max upload the API accepts, mirrored so the dialog can reject early. */
export const AGREEMENT_UPLOAD_MAX_BYTES = 10 * 1024 * 1024;
export const AGREEMENT_UPLOAD_ALLOWED_TYPES = ['application/pdf', 'image/png', 'image/jpeg'];

export interface RecordSignedAgreementForm {
  orgId: string;
  templateVersionId: string;
  contractId?: string | null;
  label?: string | null;
  variableValues: Record<string, string>;
  signerName: string;
  signerEmail?: string | null;
  signedAt: string;
  effectiveDate?: string | null;
  method: QuoteAcceptOnBehalfMethod;
  reference: string;
  file?: File | null;
}

/** Multipart FormData — `fetchWithAuth` deliberately sets no JSON Content-Type
 *  for FormData so the browser appends the boundary itself (see
 *  `uploadQuoteAcceptanceEvidence`). Optional fields are omitted, never sent
 *  empty. Responds 201 `{ data: { request, signedAgreementId, contentSha256 } }`.
 *  Callers MUST wrap this in `runAction`. */
export function recordSignedAgreement(form: RecordSignedAgreementForm): Promise<Response> {
  const fd = new FormData();
  fd.append('orgId', form.orgId);
  fd.append('templateVersionId', form.templateVersionId);
  fd.append('variableValues', JSON.stringify(form.variableValues));
  fd.append('signerName', form.signerName);
  fd.append('signedAt', form.signedAt);
  fd.append('method', form.method);
  fd.append('reference', form.reference);
  const optional: Array<[string, string | null | undefined]> = [
    ['contractId', form.contractId],
    ['label', form.label],
    ['signerEmail', form.signerEmail],
    ['effectiveDate', form.effectiveDate],
  ];
  for (const [key, value] of optional) {
    if (value && value.trim()) fd.append(key, value.trim());
  }
  if (form.file) fd.append('file', form.file);
  return fetchWithAuth('/contracts/agreement-requests/record-signed', { method: 'POST', body: fd });
}
