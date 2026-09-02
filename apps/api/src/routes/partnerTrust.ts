import { Hono } from 'hono';
import { and, eq, isNull, lt, or } from 'drizzle-orm';
import { db } from '../db';
import { partners } from '../db/schema';
import { authMiddleware, requireScope } from '../middleware/auth';
import { createAuditLog } from '../services/auditService';
import { sendOpsAlert } from '../services/opsAlerts';

export const partnerTrustRoutes = new Hono();

const REVIEW_COOLDOWN_MS = 24 * 60 * 60 * 1000;
const RISKY_SIGNUP_IP_CLASSES = new Set(['hosting', 'vpn', 'tor', 'unknown']);

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

  // Task 5.5 replaces this short notification with the full evidence card.
  await sendOpsAlert({
    title: 'Partner trust review requested',
    body: `${updated.name} requested a partner trust review.`,
  });

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
      signupIpClass: partners.signupIpClass,
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
      signupIpOk: !RISKY_SIGNUP_IP_CLASSES.has(partner.signupIpClass),
    },
    reviewRequestedAt: partner.trustReviewRequestedAt,
    meetingUrl: process.env.PARTNER_MEETING_URL ?? null,
  });
});
