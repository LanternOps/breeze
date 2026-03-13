import { Context, Next } from 'hono';
import { eq } from 'drizzle-orm';
import { db } from '../db';
import { partners } from '../db/schema';

export async function partnerGuard(c: Context, next: Next) {
  const authHeader = c.req.header('Authorization');
  if (!authHeader?.startsWith('Bearer ')) {
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
    await next();
    return;
  }

  if (!partnerId) {
    await next();
    return;
  }

  const [partner] = await db
    .select({
      status: partners.status,
      settings: partners.settings,
    })
    .from(partners)
    .where(eq(partners.id, partnerId))
    .limit(1);

  if (!partner) {
    await next();
    return;
  }

  if (partner.status !== 'active') {
    const settings = (partner.settings ?? {}) as Record<string, unknown>;
    return c.json({
      error: 'Account inactive',
      code: 'PARTNER_INACTIVE',
      status: partner.status,
      message: (settings.statusMessage as string) ?? null,
      actionUrl: (settings.statusActionUrl as string) ?? null,
      actionLabel: (settings.statusActionLabel as string) ?? null,
    }, 403);
  }

  await next();
}
