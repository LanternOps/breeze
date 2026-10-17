// Owner: W02b. Typed fetch wrappers for declared controls (Trust Center W2, #8770), under the org router at
// /orgs/:orgId/trust-page/declarations. Same idiom as trustPage.ts: the fetcher is a parameter, reads unwrap the
// `{ data }` envelope, and mutation wrappers return the raw `Response` so the component owns `runAction`.
import type { DeclaredControlDefinition, DeclaredControlId, TrustDeclarationCreateInput } from '@breeze/shared';
import { unwrapData, type Fetcher } from './serviceDeliverables';

export interface TrustDeclaration {
  id: string;
  controlId: DeclaredControlId;
  statement: string;
  evidenceDocumentId: string | null;
  evidenceDocumentSha256: string | null;
  declaredByPartnerName: string;
  declaredByUserId: string | null;
  declaredAt: string;
  expiresAt: string;
  supersededAt: string | null;
  withdrawnAt: string | null;
  reminderSentAt: string | null;
}

export interface TrustDeclarationsState {
  catalog: DeclaredControlDefinition[];
  /** Neither superseded nor withdrawn (expired ones included), one per control at most. */
  active: TrustDeclaration[];
  /** The latest 50 superseded or withdrawn rows, newest first. */
  history: TrustDeclaration[];
  /** The ids frozen on the live page (empty when unpublished). */
  publishedDeclarationIds: string[];
  publicationRevision: number;
  /** The partner name a new declaration carries ("Declared by <partner>"). */
  partnerName: string;
}

function base(orgId: string): string {
  return `/orgs/${encodeURIComponent(orgId)}/trust-page/declarations`;
}

function postJson(body: unknown): RequestInit {
  return { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
}

export async function getTrustDeclarations(f: Fetcher, orgId: string): Promise<TrustDeclarationsState> {
  return unwrapData<TrustDeclarationsState>(await f(base(orgId)));
}

export function declareTrustControl(f: Fetcher, orgId: string, body: TrustDeclarationCreateInput): Promise<Response> {
  return f(base(orgId), postJson(body));
}

export function withdrawTrustDeclaration(f: Fetcher, orgId: string, declarationId: string, expectedRevision: number): Promise<Response> {
  return f(`${base(orgId)}/${encodeURIComponent(declarationId)}/withdraw`, postJson({ expectedRevision }));
}
