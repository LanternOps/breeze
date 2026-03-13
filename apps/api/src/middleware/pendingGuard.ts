import { Context, Next } from 'hono';
import { eq } from 'drizzle-orm';
import { db } from '../db';
import { partners } from '../db/schema';

export async function pendingPartnerGuard(c: Context, next: Next) {
  const auth = c.get('auth') as { user?: { id: string }; partnerId?: string | null } | undefined;

  if (!auth?.partnerId) {
    await next();
    return;
  }

  const [partner] = await db
    .select({ status: partners.status })
    .from(partners)
    .where(eq(partners.id, auth.partnerId))
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
