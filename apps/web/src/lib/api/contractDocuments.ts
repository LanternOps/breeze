// Typed fetch wrappers for the Executed Contract Documents API (Task 18
// routes, mounted under the contracts router at /contracts/contract-documents).
//
// Same idiom as contracts.ts / contractTemplates.ts: there is no generic
// apiClient — every call goes through fetchWithAuth (apps/web/src/stores/auth.ts),
// which injects the active orgId, refreshes tokens, and returns a raw Response.
// Callers keep full control over 401 handling and wrap mutations in runAction.
// Every route responds with a `{ data: ... }` envelope.

import { fetchWithAuth } from '../../stores/auth';

const BASE = '/contracts/contract-documents';
const JSON_HEADERS = { 'Content-Type': 'application/json' };

/** A `GET /contract-documents` list row — the executed document plus the
 *  joined display fields (template name/version, signer, quote number). */
export interface ContractDocument {
  id: string;
  orgId: string;
  contractId: string | null;
  quoteId: string | null;
  templateId: string;
  templateVersionId: string;
  templateName: string;
  templateVersionNumber: number;
  signerName: string | null;
  signedAt: string | null;
  quoteNumber: string | null;
  byteSize: number;
  sha256: string;
  createdAt: string;
}

/** Spec §6 link-state filter. NOTE the asymmetry: the SERVER defaults an omitted
 *  `linked` to 'unlinked' (back-compat with the pre-Agreements Documents tab), so
 *  a caller that wants the whole inventory must say so. SignedAgreementsPage
 *  sends 'all' unless its "Unlinked only" chip is on. */
export type SignedAgreementLinkFilter = 'all' | 'linked' | 'unlinked';

export interface ListContractDocumentsQuery {
  contractId?: string;
  orgId?: string;
  linked?: SignedAgreementLinkFilter;
  /** @deprecated legacy spelling of `linked: 'unlinked'`; kept until no caller sends it. */
  unattached?: boolean;
}

function buildQuery(q: ListContractDocumentsQuery): string {
  const params = new URLSearchParams();
  if (q.contractId) params.set('contractId', q.contractId);
  if (q.orgId) params.set('orgId', q.orgId);
  if (q.linked) params.set('linked', q.linked);
  if (q.unattached) params.set('unattached', 'true');
  const qs = params.toString();
  return qs ? `?${qs}` : '';
}

export function listContractDocuments(query: ListContractDocumentsQuery = {}): Promise<Response> {
  return fetchWithAuth(`${BASE}${buildQuery(query)}`);
}

/** Path for usePdfDownload — the route streams `application/pdf` bytes. */
export function contractDocumentPdfPath(id: string): string {
  return `${BASE}/${id}/pdf`;
}

/** Link-later: attach a previously-unattached document to a contract (the
 *  target contract must belong to the same org — the API rejects a mismatch
 *  with 404). */
export function linkContractDocument(id: string, contractId: string): Promise<Response> {
  return fetchWithAuth(`${BASE}/${id}`, {
    method: 'PATCH',
    headers: JSON_HEADERS,
    body: JSON.stringify({ contractId }),
  });
}
