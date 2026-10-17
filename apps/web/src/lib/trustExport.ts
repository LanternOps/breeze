// Questionnaire export (W03c): fetch the PUBLISHED trust payload (the same one the public page renders) and
// serialize it in the browser. No auth and no new API route, so an export can never say more than the public page.

import {
  normalizeTrustPagePayload,
  trustPagePublicPayloadSchema,
  trustPagePublicPayloadV1Schema,
  trustQuestionnaireCsv,
  trustQuestionnaireJson,
  type TrustPagePublicPayload,
} from '@breeze/shared';

const API_BASE = (import.meta.env.PUBLIC_API_URL || '').trim().replace(/\/+$/, '');

const REVOKE_DELAY_MS = 60_000;

export type TrustExportFormat = 'csv' | 'json';

export interface TrustExportContext {
  partnerSlug: string;
  orgSlug: string;
  isPartnerHome: boolean;
  /** The page's public URL (`trustPublicUrl(publicPath)`), written into every export. */
  pageUrl: string;
}

export interface PublishedTrustPayload {
  payload: TrustPagePublicPayload;
  lastEvaluatedAt: string | null;
  stale: boolean;
}

/** Partner home pages are addressed by the partner slug alone. */
export function trustPayloadPath(ctx: Pick<TrustExportContext, 'partnerSlug' | 'orgSlug' | 'isPartnerHome'>): string {
  const base = `/api/v1/trust/public/${encodeURIComponent(ctx.partnerSlug)}`;
  return ctx.isPartnerHome ? base : `${base}/${encodeURIComponent(ctx.orgSlug)}`;
}

/** `null` when the page is not served (404: unpublished, withdrawn or renamed). Anything else non-2xx throws. */
export async function fetchPublishedTrustPayload(ctx: TrustExportContext): Promise<PublishedTrustPayload | null> {
  const res = await fetch(`${API_BASE}${trustPayloadPath(ctx)}`, { headers: { Accept: 'application/json' }, cache: 'no-store' });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`Trust payload request failed (${res.status})`);
  const body = (await res.json()) as { data?: { payload?: unknown; lastEvaluatedAt?: string | null; stale?: boolean } };
  // The API already normalizes to v2; the v1 branch is a defensive fallback for an older deployment.
  const raw = body.data?.payload as { schemaVersion?: number } | undefined;
  const payload = raw?.schemaVersion === 1
    ? normalizeTrustPagePayload(trustPagePublicPayloadV1Schema.parse(raw))
    : trustPagePublicPayloadSchema.parse(raw);
  return { payload, lastEvaluatedAt: body.data?.lastEvaluatedAt ?? null, stale: body.data?.stale === true };
}

/** Download the questionnaire. Resolves false when the page is not served, so the caller can say so. */
export async function downloadTrustQuestionnaire(
  format: TrustExportFormat,
  ctx: TrustExportContext,
  now: Date = new Date(),
): Promise<boolean> {
  const published = await fetchPublishedTrustPayload(ctx);
  if (!published) return false;
  const input = { ...published, pageUrl: ctx.pageUrl };
  const text = format === 'csv' ? trustQuestionnaireCsv(input) : JSON.stringify(trustQuestionnaireJson(input), null, 2);
  const type = format === 'csv' ? 'text/csv;charset=utf-8' : 'application/json';
  const slug = ctx.isPartnerHome ? ctx.partnerSlug : ctx.orgSlug;
  const name = `trust-questionnaire-${slug}-${now.toISOString().slice(0, 10)}.${format}`;

  const url = URL.createObjectURL(new Blob([text], { type }));
  try {
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    a.rel = 'noopener';
    document.body.appendChild(a);
    a.click();
    a.remove();
  } finally {
    // Some browsers start the download asynchronously; revoking in the same tick can yield an empty file.
    setTimeout(() => URL.revokeObjectURL(url), REVOKE_DELAY_MS);
  }
  return true;
}
