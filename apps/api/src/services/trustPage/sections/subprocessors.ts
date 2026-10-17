// Owner: W02f (subprocessors).
import { asc, eq } from 'drizzle-orm';
import type { TrustPagePublicPayload, TrustPublishedConfig } from '@breeze/shared';
import { db } from '../../../db';
import { trustPageSubprocessors } from '../../../db/schema';
import type { SectionBuildContext, SectionDraftContext } from './types';

const HTTPS_RE = /^https:\/\/[^\s/$.?#].[^\s]*$/i;
/** A website is public output: anything that is not a plain https URL becomes null, never throws. */
const httpsOrNull = (v: string | null | undefined): string | null => (v && v.length <= 2048 && HTTPS_RE.test(v) ? v : null);

/** Publish/preview: copy the draft rows' content in sort order (Ruling 20: the published page never reads them live). */
export async function freezeSubprocessors(ctx: SectionDraftContext): Promise<TrustPublishedConfig['subprocessors']> {
  const rows = await db.select().from(trustPageSubprocessors)
    .where(eq(trustPageSubprocessors.trustPageId, ctx.page.id)).orderBy(asc(trustPageSubprocessors.sortOrder));
  return rows.map((r, i) => ({ name: r.name, purpose: r.purpose, location: r.location ?? null, websiteUrl: httpsOrNull(r.websiteUrl), sortOrder: i }));
}

export function buildSubprocessors(ctx: SectionBuildContext): TrustPagePublicPayload['subprocessors'] {
  return [...ctx.config.subprocessors]
    .sort((a, b) => a.sortOrder - b.sortOrder)
    .map((s) => ({ name: s.name, purpose: s.purpose, location: s.location, websiteUrl: httpsOrNull(s.websiteUrl) }));
}
