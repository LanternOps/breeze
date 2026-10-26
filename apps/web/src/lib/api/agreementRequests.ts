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

// ---------------------------------------------------------------------------
// Send-for-signature requests (#9075 W2c). Same idiom: raw Response back,
// mutating callers wrap in `runAction`. Every route answers `{ data }`.
// ---------------------------------------------------------------------------

const BASE = '/contracts/agreement-requests';
const JSON_HEADERS = { 'Content-Type': 'application/json' };

export type AgreementRequestStatus = 'draft' | 'sent' | 'viewed' | 'signed' | 'declined' | 'voided' | 'expired';
/** List buckets: pending = draft|sent|viewed, signed = signed, closed = declined|voided|expired. */
export type AgreementRequestBucket = 'pending' | 'signed' | 'closed';

export interface AgreementRequestRow {
  id: string;
  orgId: string;
  status: AgreementRequestStatus;
  templateId: string;
  templateVersionId: string;
  contractId: string | null;
  label: string | null;
  coverMessage: string | null;
  variableValues: Record<string, string>;
  expiresAt: string | null;
  sentAt: string | null;
  firstViewedAt: string | null;
  signedAt: string | null;
  declinedAt: string | null;
  voidedAt: string | null;
  expiredAt: string | null;
  declineReason: string | null;
  voidReason: string | null;
  reminderCount: number;
  createdAt: string;
  templateName: string;
  templateVersionNumber: number;
  signedAgreementId: string | null;
  recipients: string[];
}

export interface ListAgreementRequestsQuery {
  orgId?: string;
  contractId?: string;
  status?: AgreementRequestBucket;
}

export function listAgreementRequests(query: ListAgreementRequestsQuery = {}): Promise<Response> {
  const params = new URLSearchParams();
  if (query.orgId) params.set('orgId', query.orgId);
  if (query.contractId) params.set('contractId', query.contractId);
  if (query.status) params.set('status', query.status);
  const qs = params.toString();
  return fetchWithAuth(qs ? `${BASE}?${qs}` : BASE);
}

export interface CreateAgreementRequestInput {
  orgId: string;
  templateId: string;
  contractId?: string;
  recipients: string[];
  coverMessage?: string;
  /** ISO instant, must be in the future. */
  expiresAt?: string;
  variableValues?: Record<string, string>;
  label?: string;
}

/** 201 `{ data: request detail }`. Wrap in `runAction`. */
export function createAgreementRequest(input: CreateAgreementRequestInput): Promise<Response> {
  return fetchWithAuth(BASE, { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify(input) });
}

export type UpdateAgreementRequestInput = Partial<Omit<CreateAgreementRequestInput, 'orgId'>>;

/** Draft only; `recipients` replaces the whole list. Wrap in `runAction`. */
export function updateAgreementRequest(id: string, patch: UpdateAgreementRequestInput): Promise<Response> {
  return fetchWithAuth(`${BASE}/${id}`, { method: 'PATCH', headers: JSON_HEADERS, body: JSON.stringify(patch) });
}

/** Draft only. Wrap in `runAction`. */
export function deleteAgreementRequest(id: string): Promise<Response> {
  return fetchWithAuth(`${BASE}/${id}`, { method: 'DELETE' });
}

export interface AgreementRequestPreview {
  sourceType: 'authored' | 'uploaded';
  /** Sanitized server-side. Null for an uploaded document. */
  html: string | null;
  /** Variable names still lacking a value. */
  unresolved: string[];
  templateName: string;
  versionNumber: number;
}

export function previewAgreementRequest(id: string): Promise<Response> {
  return fetchWithAuth(`${BASE}/${id}/preview`);
}

/** Why a sent agreement's email did not go out. Each value needs an
 *  `agreements.send.notEmailed.<reason>` key (guarded by a test). */
export const AGREEMENT_EMAIL_REASONS = ['no_email_service', 'no_recipients', 'send_failed'] as const;
export type AgreementEmailReason = (typeof AGREEMENT_EMAIL_REASONS)[number];

export interface SendAgreementRequestResult {
  request: AgreementRequestRow;
  emailed: boolean;
  emailReason?: AgreementEmailReason;
  link: string;
  recipients: string[];
}

/** Wrap in `runAction` (no success message; the caller toasts by outcome). */
export function sendAgreementRequest(id: string): Promise<Response> {
  return fetchWithAuth(`${BASE}/${id}/send`, { method: 'POST' });
}

export interface RemindAgreementRequestResult {
  request: AgreementRequestRow;
  emailed: boolean;
  emailReason?: AgreementEmailReason;
  recipients: string[];
}

/** Re-sends the SAME signing link to the recipients (never a new link).
 *  `{ data: { request, emailed, emailReason?, recipients } }`; 409 unless
 *  sent/viewed, 410 once past expires_at. The link itself is not echoed — Copy
 *  link is the audited dispenser. Wrap in `runAction`. */
export function remindAgreementRequest(id: string): Promise<Response> {
  return fetchWithAuth(`${BASE}/${id}/remind`, { method: 'POST' });
}

/** `{ data: { link, reissued } }`; 409 unless sent/viewed. */
export function getAgreementRequestLink(id: string): Promise<Response> {
  return fetchWithAuth(`${BASE}/${id}/link`);
}

/** Wrap in `runAction`. */
export function voidAgreementRequest(id: string, reason?: string): Promise<Response> {
  const trimmed = reason?.trim();
  return fetchWithAuth(`${BASE}/${id}/void`, {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify(trimmed ? { reason: trimmed } : {}),
  });
}
