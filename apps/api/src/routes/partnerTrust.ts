import { Hono } from 'hono';
import { and, eq, isNull, lt, or } from 'drizzle-orm';
import { db } from '../db';
import { partners } from '../db/schema';
import { authMiddleware, requireScope } from '../middleware/auth';
import { createAuditLog } from '../services/auditService';
import { sendEvidenceCard } from '../services/partnerTrustEvidenceCard';

export const partnerTrustRoutes = new Hono();

const REVIEW_COOLDOWN_MS = 24 * 60 * 60 * 1000;

partnerTrustRoutes.use('*', authMiddleware);
partnerTrustRoutes.use('*', requireScope('partner'));

partnerTrustRoutes.post('/request-review', async (c) => {
  const auth = c.get('auth');
  const partnerId = auth.partnerId;
  if (!partnerId) return c.json({ error: 'partner context required' }, 403);

  const requestedAt = new Date();
  const cutoff = new Date(requestedAt.getTime() - REVIEW_COOLDOWN_MS);
  const [updated] = await db
    .update(partners)
    .set({ trustReviewRequestedAt: requestedAt, updatedAt: requestedAt })
    .where(and(
      eq(partners.id, partnerId),
      or(
        isNull(partners.trustReviewRequestedAt),
        lt(partners.trustReviewRequestedAt, cutoff),
      ),
    ))
    .returning({ id: partners.id, name: partners.name });

  if (!updated) {
    return c.json({ error: 'trust review was requested within the last 24 hours' }, 429);
  }

  await createAuditLog({
    orgId: null,
    actorType: 'user',
    actorId: auth.user.id,
    actorEmail: auth.user.email,
    action: 'partner.trust.review_requested',
    resourceType: 'partner',
    resourceId: partnerId,
    result: 'success',
    details: { requestedAt: requestedAt.toISOString() },
  });

  try {
    await sendEvidenceCard(partnerId, 'review_requested');
  } catch (error) {
    // Best-effort: the review request itself already succeeded (audit row
    // written above) — a notification failure must never fail the request.
    console.warn('[PartnerTrust] Failed to send evidence card for review request', {
      partnerId,
      error: error instanceof Error ? error.message : String(error),
    });
  }

  return c.json({ requested: true });
});

partnerTrustRoutes.get('/', async (c) => {
  const auth = c.get('auth');
  const partnerId = auth.partnerId;
  if (!partnerId) return c.json({ error: 'partner context required' }, 403);

  const [partner] = await db
    .select({
      trustState: partners.trustState,
      trustReviewRequestedAt: partners.trustReviewRequestedAt,
      createdAt: partners.createdAt,
      emailVerifiedAt: partners.emailVerifiedAt,
    })
    .from(partners)
    .where(eq(partners.id, partnerId))
    .limit(1);

  if (!partner) return c.json({ error: 'partner not found' }, 404);

  return c.json({
    trustState: partner.trustState,
    checklist: {
      ageOk: Date.now() - partner.createdAt.getTime() >= REVIEW_COOLDOWN_MS,
      emailVerified: partner.emailVerifiedAt !== null,
      // Task 5.2 supplies settled-card evidence; keep unknown distinct from false.
      cardSettled: null,
    },
    reviewRequestedAt: partner.trustReviewRequestedAt,
    meetingUrl: process.env.PARTNER_MEETING_URL ?? null,
  });
});
