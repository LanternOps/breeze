/**
 * AI Trust Page Tools (Ruling 15, trust-center W2)
 *
 * - get_trust_page_status (Tier 1): read-only status of an organization's public trust page.
 *
 * Publishing and editing stay human-only: a publish records a customer authorization and needs MFA, so no
 * AI tool writes here. This tool reads in the caller's DB context, never creates the draft page
 * (unlike the editor's GET), and reports only page-level aggregates from the current snapshot — nothing
 * device-level and no requester details.
 */
import { and, count, eq, gt, isNull, lte, sql } from 'drizzle-orm';
import { normalizeTrustPagePayload, type TrustPagePublicPayloadAny } from '@breeze/shared';
import { db } from '../db';
import { organizations, partners, trustPageAccessRequests, trustPageDeclarations, trustPages, trustPageSnapshots } from '../db/schema';
import type { AuthContext } from '../middleware/auth';
import type { AiTool } from './aiTools';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Declarations within this many days of expiry are "expiring" (the §18.2 reminder window). */
const EXPIRING_WINDOW_DAYS = 30;
/** The public page shows its stale banner past this age (routes/trustPagePublic.ts STALE_AFTER_MS). */
const STALE_AFTER_MS = 24 * 3600_000;

const jsonError = (error: string) => JSON.stringify({ error });

export interface TrustPageStatus {
  exists: boolean;
  published: boolean;
  publishedAt: string | null;
  publicPath: string | null;
  lastEvaluatedAt: string | null;
  stale: boolean;
  controls: { shown: number; met: number; catalogTotal: number } | null;
  declarations: { current: number; expiringWithin30Days: number };
  accessRequests: { pendingApproval: number };
}

async function loadTrustPageStatus(orgId: string): Promise<TrustPageStatus> {
  const [page] = await db.select({
    id: trustPages.id, publishedAt: trustPages.publishedAt, lastEvaluatedAt: trustPages.lastEvaluatedAt,
    isPartnerHome: trustPages.isPartnerHome, orgSlug: organizations.slug, partnerSlug: partners.slug,
  })
    .from(trustPages)
    .innerJoin(organizations, eq(organizations.id, trustPages.orgId))
    .innerJoin(partners, eq(partners.id, trustPages.partnerId))
    .where(eq(trustPages.orgId, orgId))
    .limit(1);
  if (!page) {
    return {
      exists: false, published: false, publishedAt: null, publicPath: null, lastEvaluatedAt: null, stale: false,
      controls: null, declarations: { current: 0, expiringWithin30Days: 0 }, accessRequests: { pendingApproval: 0 },
    };
  }

  const [snapshot] = await db.select({ payload: trustPageSnapshots.payload }).from(trustPageSnapshots)
    .where(and(eq(trustPageSnapshots.trustPageId, page.id), eq(trustPageSnapshots.isCurrent, true)))
    .limit(1);
  const summary = snapshot ? normalizeTrustPagePayload(snapshot.payload as TrustPagePublicPayloadAny).summary : null;

  const now = new Date();
  const windowEnd = new Date(now.getTime() + EXPIRING_WINDOW_DAYS * 86_400_000);
  // "Current" = the live row of its lineage: not superseded, not withdrawn, not yet expired.
  const [decl] = await db.select({
    current: count(),
    expiringWithin30Days: sql<number>`count(*) filter (where ${trustPageDeclarations.expiresAt} <= ${windowEnd})`.mapWith(Number),
  }).from(trustPageDeclarations).where(and(
    eq(trustPageDeclarations.trustPageId, page.id), isNull(trustPageDeclarations.supersededAt),
    isNull(trustPageDeclarations.withdrawnAt), gt(trustPageDeclarations.expiresAt, now),
  ));
  const [pending] = await db.select({ pendingApproval: count() }).from(trustPageAccessRequests)
    .where(and(eq(trustPageAccessRequests.trustPageId, page.id), eq(trustPageAccessRequests.status, 'pending_approval')));

  const published = page.publishedAt !== null;
  const base = `/portal/trust/${page.partnerSlug}`;
  return {
    exists: true,
    published,
    publishedAt: page.publishedAt?.toISOString() ?? null,
    publicPath: published ? (page.isPartnerHome ? base : `${base}/${page.orgSlug}`) : null,
    lastEvaluatedAt: page.lastEvaluatedAt?.toISOString() ?? null,
    // Staleness is a property of a live page; a draft has no public freshness to lose.
    stale: published && (!page.lastEvaluatedAt || now.getTime() - page.lastEvaluatedAt.getTime() > STALE_AFTER_MS),
    controls: summary ? { shown: summary.controlsShown, met: summary.controlsMet, catalogTotal: summary.catalogTotal } : null,
    declarations: { current: Number(decl?.current ?? 0), expiringWithin30Days: Number(decl?.expiringWithin30Days ?? 0) },
    accessRequests: { pendingApproval: Number(pending?.pendingApproval ?? 0) },
  };
}

export function registerTrustPageTools(aiTools: Map<string, AiTool>): void {
  aiTools.set('get_trust_page_status', {
    tier: 1,
    domain: 'security',
    searchHint: 'public trust page status: published, public URL, controls met, declarations expiring, access requests',
    deviceArgs: [],
    definition: {
      name: 'get_trust_page_status',
      description: "Read-only status of an organization's public trust page: whether it exists and is published, its public path, freshness, controls met in the current snapshot, current and expiring declarations, and pending document access requests. Never creates or edits the page.",
      input_schema: {
        type: 'object' as const,
        properties: {
          orgId: { type: 'string', description: 'Organization UUID' },
        },
        required: ['orgId'],
      },
    },
    handler: async (input: Record<string, unknown>, auth: AuthContext) => {
      const orgId = input.orgId;
      if (typeof orgId !== 'string' || !UUID_RE.test(orgId)) return jsonError('orgId must be an organization UUID');
      if (auth.scope !== 'system' && !auth.canAccessOrg(orgId)) return jsonError('Organization not found or access denied');
      try {
        return JSON.stringify(await loadTrustPageStatus(orgId));
      } catch (err) {
        console.error('[get_trust_page_status]', err);
        return jsonError('Operation failed. Check server logs for details.');
      }
    },
  });
}
