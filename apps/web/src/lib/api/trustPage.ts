// Typed fetch wrappers for the Trust Center page (#8768), mounted under the org
// router at /orgs/:orgId/trust-page. Same idiom as orgDocuments.ts: the fetcher
// is a PARAMETER (the org record passes its pinned `orgFetch`), reads unwrap the
// `{ data }` envelope, and MUTATION wrappers return the raw `Response` so the
// component owns the `runAction` call.

import type {
  TelemetryControlId,
  TrustControlAssessment,
  TrustControlDefinition,
  TrustPageUpdateInput,
} from '@breeze/shared';
import { unwrapData, type Fetcher } from './serviceDeliverables';

export interface TrustPageDraft {
  id: string;
  orgId: string;
  isPartnerHome: boolean;
  publishedAt: string | null;
  publicationRevision: number;
  searchIndexable: boolean;
  showPercentages: boolean;
  showDeviceCount: boolean;
  showManagedBy: boolean;
  securityContactEmail: string | null;
  websiteUrl: string | null;
  introHtml: string | null;
  hiddenControlIds: TelemetryControlId[];
  publicationAuthorizedBy: string | null;
  publicationAuthorizedAt: string | null;
  lastEvaluatedAt: string | null;
}

export interface TrustPageState {
  page: TrustPageDraft;
  /** Base-relative public path, e.g. `/portal/trust/nw/acme`. */
  publicPath: string;
  /** Base-relative badge path, e.g. `/api/v1/trust/public/nw/acme/badge.svg`. */
  badgePath: string;
  slugs: { partnerSlug: string; orgSlug: string; valid: boolean; problems: string[] };
  canPublish: { allowed: boolean; reason: string | null };
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
  documents: Array<{ documentId: string; visibility: 'public'; disclosureConfirmed: boolean }>,
): Promise<Response> {
  return f(`${base(orgId)}/documents`, jsonInit('PUT', { documents }));
}

export function publishTrustPage(
  f: Fetcher,
  orgId: string,
  body: { expectedRevision: number; authorization?: { authorizedBy: string } },
): Promise<Response> {
  return f(`${base(orgId)}/publish`, jsonInit('POST', body));
}

export function unpublishTrustPage(f: Fetcher, orgId: string): Promise<Response> {
  return f(`${base(orgId)}/unpublish`, { method: 'POST' });
}

export function setPartnerHome(f: Fetcher, orgId: string, isPartnerHome: boolean): Promise<Response> {
  return f(`${base(orgId)}/partner-home`, jsonInit('POST', { isPartnerHome }));
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
