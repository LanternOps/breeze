import { and, eq, sql } from 'drizzle-orm';
import { db } from '../../db';
import { organizations, partners, trustPages, trustPageSnapshots } from '../../db/schema';
import { livePublicationPredicate } from './predicate';
import { TRUST_SLUG_RE, type TrustPagePublicPayload } from '@breeze/shared';

export { livePublicationPredicate } from './predicate';

/**
 * Partner slugs that can never address a trust page: `preview` is the path segment of the public
 * preview-token route (/trust/public/preview/:token), which is registered ahead of the slug routes.
 */
export const TRUST_RESERVED_PARTNER_SLUGS: ReadonlySet<string> = new Set(['preview']);

export function parseTrustSlugs(partnerSlug: string, orgSlug?: string): { partnerSlug: string; orgSlug: string | null } | null {
  if (typeof partnerSlug !== 'string' || !TRUST_SLUG_RE.test(partnerSlug)) return null;
  if (TRUST_RESERVED_PARTNER_SLUGS.has(partnerSlug)) return null;
  if (orgSlug === undefined) return { partnerSlug, orgSlug: null };
  if (typeof orgSlug !== 'string' || !TRUST_SLUG_RE.test(orgSlug)) return null;
  return { partnerSlug, orgSlug };
}

export interface ResolvedTrustPage {
  pageId: string; orgId: string; partnerId: string; publishedAt: Date; searchIndexable: boolean;
  lastEvaluatedAt: Date | null; snapshotId: string | null; payload: TrustPagePublicPayload | null;
}

/** ONE indexed query. Caller holds the system db context. Unknown/unpublished/non-live/untrusted → null. */
export async function resolvePublishedTrustPage(partnerSlug: string, orgSlug: string | null): Promise<ResolvedTrustPage | null> {
  const target = orgSlug === null
    ? eq(trustPages.isPartnerHome, true)
    : sql`lower(${organizations.slug}) = ${orgSlug}`;
  const [row] = await db.select({
      pageId: trustPages.id, orgId: trustPages.orgId, partnerId: trustPages.partnerId, publishedAt: trustPages.publishedAt,
      // Frozen at publish (Ruling 20): the draft column only takes effect on the next publish. No config → noindex.
      searchIndexable: sql<boolean>`coalesce((${trustPages.publishedConfig} ->> 'searchIndexable')::boolean, false)`,
      lastEvaluatedAt: trustPages.lastEvaluatedAt,
      snapshotId: trustPageSnapshots.id, payload: trustPageSnapshots.payload,
    })
    .from(trustPages)
    .innerJoin(partners, eq(partners.id, trustPages.partnerId))
    // partner_id correlation lets lower(slug) use organizations_partner_slug_uniq (partner_id, lower(slug)).
    .innerJoin(organizations, and(eq(organizations.id, trustPages.orgId), eq(organizations.partnerId, partners.id)))
    .leftJoin(trustPageSnapshots, and(eq(trustPageSnapshots.trustPageId, trustPages.id), eq(trustPageSnapshots.isCurrent, true)))
    .where(and(eq(partners.slug, partnerSlug), target, livePublicationPredicate()))
    .limit(1);
  if (!row || !row.publishedAt) return null;
  return { ...row, publishedAt: row.publishedAt, payload: (row.payload as TrustPagePublicPayload | null) ?? null };
}
