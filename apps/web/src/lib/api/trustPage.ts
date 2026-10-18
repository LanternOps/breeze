// Typed fetch wrappers for the Trust Center page (#8768), mounted under the org
// router at /orgs/:orgId/trust-page. Same idiom as orgDocuments.ts: the fetcher
// is a PARAMETER (the org record passes its pinned `orgFetch`), reads unwrap the
// `{ data }` envelope, and MUTATION wrappers return the raw `Response` so the
// component owns the `runAction` call.

import type {
  EffectiveTrustSettings,
  TelemetryControlId,
  TrustControlAssessment,
  TrustControlDefinition,
  TrustDocumentVisibility,
  TrustFramework,
  TrustPageUpdateInput,
} from '@breeze/shared';
import type { OrgFetch } from '@/components/organizations/record/orgRecordFetch';
import { unwrapData, type Fetcher } from './serviceDeliverables';

export interface TrustPageDraft {
  id: string;
  orgId: string;
  isPartnerHome: boolean;
  publishedAt: string | null;
  publicationRevision: number;
  // W2: the org's OWN values; null = inherit (partner template → built-in default). Display reads
  // `TrustPageState.effective`, never these directly.
  searchIndexable: boolean | null;
  showPercentages: boolean | null;
  showDeviceCount: boolean | null;
  showManagedBy: boolean | null;
  showHistory: boolean | null;
  securityContactEmail: string | null;
  websiteUrl: string | null;
  /** null = inherit; '' = explicitly no intro. */
  introHtml: string | null;
  hiddenControlIds: TelemetryControlId[] | null;
  frameworkView: TrustFramework[] | null;
  ndaText: string | null;
  accessRequestCreatesTicket: boolean;
  /** W03a: exact https origins allowed to frame the embed card. Live (no republish needed). */
  embedAllowedOrigins: string[];
  publicationAuthorizedBy: string | null;
  publicationAuthorizedAt: string | null;
  lastEvaluatedAt: string | null;
}

export interface TrustLinkedDocument {
  documentId: string;
  visibility: TrustDocumentVisibility;
  disclosureConfirmedAt: string | null;
  sortOrder: number;
  title: string;
  category: string;
  contentType: string;
  byteSize: number;
  supersededByDocumentId: string | null;
  deleted: boolean;
}

export interface TrustPageState {
  page: TrustPageDraft;
  /** Base-relative public path, e.g. `/portal/trust/nw/acme`. */
  publicPath: string;
  /** Base-relative badge path, e.g. `/api/v1/trust/public/nw/acme/badge.svg`. */
  badgePath: string;
  /** W03a: base-relative embed card path, e.g. `/portal/trust/embed/nw/acme`. */
  embedPath: string;
  slugs: { partnerSlug: string; orgSlug: string; valid: boolean; problems: string[] };
  canPublish: { allowed: boolean; reason: string | null };
  /** Linked documents in display order (editor view; includes superseded/deleted rows). */
  documents: TrustLinkedDocument[];
  /** What publish would freeze: page → partner template → built-in default, with each value's source. */
  effective: EffectiveTrustSettings;
  /** The partner template revision the editor loaded (null = no template); sent back on publish. */
  template: { revision: number } | null;
  frameworkOptions: TrustFrameworkOption[];
}

export interface TrustFrameworkOption {
  framework: TrustFramework;
  available: boolean;
  suggested: boolean;
}

/** Props every W2 Trust Center section receives from TrustCenterTab (W02a seam). */
export interface TrustSectionProps {
  orgId: string;
  orgFetch: OrgFetch;
  state: TrustPageState;
  canWrite: boolean;
  onReload: () => Promise<void>;
}

export interface TrustControlsState {
  assessments: TrustControlAssessment[];
  catalog: TrustControlDefinition[];
  evaluatedAt: string;
  deviceCount: number;
}

function base(orgId: string): string {
  return `/orgs/${encodeURIComponent(orgId)}/trust-page`;
}

function jsonInit(method: 'PUT' | 'POST', body: unknown): RequestInit {
  return { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
}

export async function getTrustPage(f: Fetcher, orgId: string): Promise<TrustPageState> {
  return unwrapData<TrustPageState>(await f(base(orgId)));
}

export async function getTrustControls(f: Fetcher, orgId: string): Promise<TrustControlsState> {
  return unwrapData<TrustControlsState>(await f(`${base(orgId)}/controls`));
}

export function updateTrustPage(f: Fetcher, orgId: string, body: TrustPageUpdateInput): Promise<Response> {
  return f(base(orgId), jsonInit('PUT', body));
}

export function updateTrustDocuments(
  f: Fetcher,
  orgId: string,
  documents: Array<{ documentId: string; visibility: TrustDocumentVisibility; disclosureConfirmed: boolean }>,
  expectedRevision?: number,
): Promise<Response> {
  return f(`${base(orgId)}/documents`, jsonInit('PUT', expectedRevision === undefined ? { documents } : { documents, expectedRevision }));
}

export function publishTrustPage(
  f: Fetcher,
  orgId: string,
  body: { expectedRevision: number; authorization?: { authorizedBy: string }; expectedTemplateRevision?: number | null },
): Promise<Response> {
  return f(`${base(orgId)}/publish`, jsonInit('POST', body));
}

export function unpublishTrustPage(f: Fetcher, orgId: string): Promise<Response> {
  return f(`${base(orgId)}/unpublish`, { method: 'POST' });
}

export function setPartnerHome(f: Fetcher, orgId: string, isPartnerHome: boolean): Promise<Response> {
  return f(`${base(orgId)}/partner-home`, jsonInit('POST', { isPartnerHome }));
}

/** W03a: PUT → `{ data: { embedAllowedOrigins } }` (normalized). MFA-gated; 403 MFA_REQUIRED without it. */
export function updateTrustEmbedOrigins(f: Fetcher, orgId: string, origins: string[]): Promise<Response> {
  return f(`${base(orgId)}/embed`, jsonInit('PUT', { origins }));
}

/** POST → `{ data: { token, expiresInSeconds, previewPath } }`; `previewPath` is
 *  relative to the PORTAL base (`/trust/preview/<token>`). */
export function createPreviewToken(f: Fetcher, orgId: string): Promise<Response> {
  return f(`${base(orgId)}/preview-token`, { method: 'POST' });
}

/** Absolute public URL for a base-relative path from the API. */
export function trustPublicUrl(publicPath: string): string {
  return `${window.location.origin}${publicPath}`;
}
