// Typed fetch wrappers for the organization document library (#5573 W03),
// mounted under the org router at /orgs/:orgId/documents.
//
// Same idiom as serviceDeliverables.ts: the fetcher is a PARAMETER (the org
// record passes its pinned `orgFetch`), every JSON route answers a `{ data }`
// envelope, and MUTATION wrappers return the raw `Response` so the component
// owns the `runAction` call (the contractDocuments.ts idiom).

import { unwrapData, type Fetcher } from './serviceDeliverables';

export type OrgDocumentCategory =
  | 'baseline' | 'runbook' | 'policy' | 'evidence' | 'report' | 'export' | 'other';

export const ORG_DOCUMENT_CATEGORIES: readonly OrgDocumentCategory[] = [
  'baseline', 'runbook', 'policy', 'evidence', 'report', 'export', 'other',
];

/** An `org_documents` row as the API returns it — metadata only, never bytes. */
export interface OrgDocument {
  id: string;
  orgId: string;
  title: string;
  description: string | null;
  category: OrgDocumentCategory;
  contentType: string;
  byteSize: number;
  sha256: string;
  originalFilename: string;
  uploadedByUserId: string | null;
  portalVisible: boolean;
  supersedesDocumentId: string | null;
  supersededByDocumentId: string | null;
  createdAt: string;
}

export interface ListOrgDocumentsQuery {
  category?: OrgDocumentCategory;
  includeSuperseded?: boolean;
}

function base(orgId: string): string {
  return `/orgs/${encodeURIComponent(orgId)}/documents`;
}

function docPath(orgId: string, id: string): string {
  return `${base(orgId)}/${encodeURIComponent(id)}`;
}

/** The authenticated bytes path. Never linked directly: it needs the auth
 *  header, so the component fetches it and hands the browser a blob URL. */
export function orgDocumentContentPath(orgId: string, id: string): string {
  return `${docPath(orgId, id)}/content`;
}

export async function listOrgDocuments(
  f: Fetcher,
  orgId: string,
  q: ListOrgDocumentsQuery = {},
): Promise<OrgDocument[]> {
  const params = new URLSearchParams();
  if (q.category) params.set('category', q.category);
  // Explicit 'false' rather than omission: the API parses the two literals and
  // never reads a present-but-empty value as true.
  if (q.includeSuperseded !== undefined) params.set('includeSuperseded', q.includeSuperseded ? 'true' : 'false');
  const qs = params.toString();
  return unwrapData<OrgDocument[]>(await f(`${base(orgId)}${qs ? `?${qs}` : ''}`));
}

/** FormData bodies must NOT set Content-Type — the browser supplies the
 *  multipart boundary (see TicketWorkbench.tsx). */
export function uploadOrgDocument(f: Fetcher, orgId: string, form: FormData): Promise<Response> {
  return f(base(orgId), { method: 'POST', body: form });
}

export function replaceOrgDocument(f: Fetcher, orgId: string, id: string, form: FormData): Promise<Response> {
  return f(`${docPath(orgId, id)}/replace`, { method: 'POST', body: form });
}

export function updateOrgDocument(
  f: Fetcher,
  orgId: string,
  id: string,
  body: { title?: string; description?: string | null; category?: OrgDocumentCategory; portalVisible?: boolean },
): Promise<Response> {
  return f(docPath(orgId, id), {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

export function deleteOrgDocument(f: Fetcher, orgId: string, id: string): Promise<Response> {
  return f(docPath(orgId, id), { method: 'DELETE' });
}
