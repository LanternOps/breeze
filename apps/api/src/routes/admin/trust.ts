import { Hono, type Context } from 'hono';
import { and, desc, eq, isNull, lt, ne, or, sql, type SQL } from 'drizzle-orm';
import { z } from 'zod';
import { db, runOutsideDbContext, withSystemDbAccessContext } from '../../db';
import { partners } from '../../db/schema';
import type { PartnerTrustState } from '../../db/schema/orgs';
import { zValidator } from '../../lib/validation';
import { requireMfa } from '../../middleware/auth';
import { loadTrustState, setTrustState } from '../../services/partnerTrust';
import { buildEvidenceCard, type EvidenceCard } from '../../services/partnerTrustEvidenceCard';

export const trustAdminRoutes = new Hono();

const trustChangeSchema = z.object({
  reason: z.string().trim().min(8, 'reason must be at least 8 characters'),
  override: z.boolean().optional(),
});

const queueQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  cursor: z.string().min(1).optional(),
  // Evidence cards include a bounded DNS MX lookup, so callers opt in rather
  // than making the normal queue fan out external work for every row.
  card: z.enum(['0', '1']).default('0'),
});

type TrustQueueCursor = {
  trustChangedAt: Date | null;
  id: string;
};

export type TrustQueueRow = {
  id: string;
  name: string;
  slug: string;
  plan: string;
  status: string;
  trustState: PartnerTrustState;
  trustReason: string | null;
  trustChangedAt: Date | null;
  trustReviewRequestedAt: Date | null;
  createdAt: Date;
  signupIp: string | null;
  signupIpClass: string;
  signupIpAsn: number | null;
  deviceCount: number;
};

function encodeQueueCursor(row: Pick<TrustQueueRow, 'trustChangedAt' | 'id'>): string {
  return Buffer.from(JSON.stringify({
    trustChangedAt: row.trustChangedAt?.toISOString() ?? null,
    id: row.id,
  }), 'utf8').toString('base64url');
}

function decodeQueueCursor(raw: string): TrustQueueCursor | null {
  try {
    const parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')) as {
      trustChangedAt?: unknown;
      id?: unknown;
    };
    if (typeof parsed.id !== 'string' || !z.string().uuid().safeParse(parsed.id).success) {
      return null;
    }
    if (parsed.trustChangedAt === null) return { trustChangedAt: null, id: parsed.id };
    if (typeof parsed.trustChangedAt !== 'string') return null;
    const trustChangedAt = new Date(parsed.trustChangedAt);
    if (Number.isNaN(trustChangedAt.getTime())) return null;
    return { trustChangedAt, id: parsed.id };
  } catch {
    return null;
  }
}

/**
 * Stable queue response seam. Task 5.5 extends this mapper with the evidence
 * card; keep route-specific presentation out of the query handler.
 */
export function mapTrustQueueRow(row: TrustQueueRow): TrustQueueRow {
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    plan: row.plan,
    status: row.status,
    trustState: row.trustState,
    trustReason: row.trustReason,
    trustChangedAt: row.trustChangedAt,
    trustReviewRequestedAt: row.trustReviewRequestedAt,
    createdAt: row.createdAt,
    signupIp: row.signupIp,
    signupIpClass: row.signupIpClass,
    signupIpAsn: row.signupIpAsn,
    deviceCount: row.deviceCount,
  };
}

export async function mapTrustQueueRowWithCard(
  row: TrustQueueRow,
): Promise<TrustQueueRow & { card: EvidenceCard }> {
  return { ...mapTrustQueueRow(row), card: await buildEvidenceCard(row.id) };
}

async function changeTrustState(
  c: Context,
  partnerId: string,
  body: z.infer<typeof trustChangeSchema>,
  next: Extract<PartnerTrustState, 'trusted' | 'restricted'>,
) {
  const auth = c.get('auth');
  const { reason, override } = body;
  const current = await loadTrustState(partnerId);

  if (!current) return c.json({ error: 'partner not found' }, 404);
  if (next === 'trusted' && current.trustState === 'restricted' && override !== true) {
    return c.json({ error: 'override is required to promote a restricted partner' }, 409);
  }

  const action = next === 'trusted' ? 'admin:promote' : 'admin:restrict';
  await setTrustState(partnerId, next, action, auth.user.id, { reason });
  return c.json({ success: true, trustState: next });
}

trustAdminRoutes.post(
  '/partners/:id/trust/promote',
  requireMfa(),
  zValidator('json', trustChangeSchema),
  (c) => changeTrustState(c, c.req.param('id'), c.req.valid('json'), 'trusted'),
);

trustAdminRoutes.post(
  '/partners/:id/trust/restrict',
  requireMfa(),
  zValidator('json', trustChangeSchema),
  (c) => changeTrustState(c, c.req.param('id'), c.req.valid('json'), 'restricted'),
);

trustAdminRoutes.get('/trust/queue', zValidator('query', queueQuerySchema), async (c) => {
  const { limit, cursor: rawCursor, card } = c.req.valid('query');
  const cursor = rawCursor ? decodeQueueCursor(rawCursor) : null;
  if (rawCursor && !cursor) return c.json({ error: 'invalid cursor' }, 400);

  let cursorCondition: SQL | undefined;
  if (cursor?.trustChangedAt === null) {
    cursorCondition = and(isNull(partners.trustChangedAt), lt(partners.id, cursor.id));
  } else if (cursor?.trustChangedAt) {
    cursorCondition = or(
      lt(partners.trustChangedAt, cursor.trustChangedAt),
      and(eq(partners.trustChangedAt, cursor.trustChangedAt), lt(partners.id, cursor.id)),
      isNull(partners.trustChangedAt),
    );
  }

  const rows = await runOutsideDbContext(() => withSystemDbAccessContext(() => db
    .select({
      id: partners.id,
      name: partners.name,
      slug: partners.slug,
      plan: partners.plan,
      status: partners.status,
      trustState: partners.trustState,
      trustReason: partners.trustReason,
      trustChangedAt: partners.trustChangedAt,
      trustReviewRequestedAt: partners.trustReviewRequestedAt,
      createdAt: partners.createdAt,
      signupIp: partners.signupIp,
      signupIpClass: partners.signupIpClass,
      signupIpAsn: partners.signupIpAsn,
      // NOTE: the inner correlated sub-select MUST reference its own tables
      // and columns as plain SQL text, never as interpolated Drizzle Column
      // objects (`${organizations.id}`) — Drizzle renders a bare column
      // reference UNqualified ("id"), so both sides of the join collapse to
      // the same unqualified name and Postgres raises "column reference
      // \"id\" is ambiguous". Only the outer correlation to `partners` is
      // interpolated (`${partners}.id`), which renders the Table object as
      // its quoted, qualified name. Same pattern/lesson as
      // routes/software.ts's versionCount subquery.
      deviceCount: sql<number>`(
        SELECT count(*)::int
        FROM devices
        INNER JOIN organizations ON organizations.id = devices.org_id
        WHERE organizations.partner_id = ${partners}.id
      )`,
    })
    .from(partners)
    .where(and(ne(partners.trustState, 'trusted'), cursorCondition))
    .orderBy(sql`${partners.trustChangedAt} DESC NULLS LAST`, desc(partners.id))
    .limit(limit + 1)));

  const hasMore = rows.length > limit;
  const visibleRows = rows.slice(0, limit);
  const page = card === '1'
    ? await Promise.all(visibleRows.map(mapTrustQueueRowWithCard))
    : visibleRows.map(mapTrustQueueRow);
  const last = page.at(-1);
  return c.json({
    partners: page,
    nextCursor: hasMore && last ? encodeQueueCursor(last) : null,
  });
});
