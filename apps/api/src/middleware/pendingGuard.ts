import { Context, Next } from 'hono';
import { eq } from 'drizzle-orm';
import { db } from '../db';
import { partners } from '../db/schema';

/**
 * Blocks partners with status = 'pending' from accessing protected API routes.
 *
 * Decodes the JWT payload directly (without full verification — that happens
 * later in per-route authMiddleware) to extract the partnerId, then checks
 * the partner's status in the database.
 */
export async function pendingPartnerGuard(c: Context, next: Next) {
  const authHeader = c.req.header('Authorization');
  if (!authHeader?.startsWith('Bearer ')) {
    // No token — let downstream auth middleware reject if needed
    await next();
    return;
  }

  const token = authHeader.slice(7);
  const parts = token.split('.');
  if (parts.length !== 3) {
    await next();
    return;
  }

  let partnerId: string | null = null;
  try {
    const payload = JSON.parse(Buffer.from(parts[1]!, 'base64url').toString());
    partnerId = payload.partnerId ?? null;
  } catch {
    // Malformed JWT — let authMiddleware handle rejection
    await next();
    return;
  }

  if (!partnerId) {
    await next();
    return;
  }

  const [partner] = await db
    .select({ status: partners.status })
    .from(partners)
    .where(eq(partners.id, partnerId))
    .limit(1);

  if (partner?.status === 'pending') {
    return c.json({
      error: 'Account activation required',
      code: 'PARTNER_PENDING',
      message: 'Please complete checkout to activate your account.',
    }, 403);
  }

  await next();
}
