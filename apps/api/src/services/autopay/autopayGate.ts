import { eq } from 'drizzle-orm';
import type { MiddlewareHandler } from 'hono';
import { db as ambientDb, getCurrentDbAccessContext, runOutsideDbContext, withSystemDbAccessContext } from '../../db';
import { readWithPartnerAxisVisibility } from '../../db/partnerAxisRead';
import { partners } from '../../db/schema';
import type { Tx } from './types';

export async function isAutopayEnabledForPartner(db: Tx, partnerId: string): Promise<boolean> {
  const load = async (executor: Tx) => {
    const [row] = await executor.select({ enabled: partners.autopayEnabled }).from(partners)
      .where(eq(partners.id, partnerId)).limit(1);
    return row?.enabled === true;
  };

  // partnerId must come from authenticated context or an RLS-visible org row.
  return getCurrentDbAccessContext()?.scope === 'organization'
    ? readWithPartnerAxisVisibility(() => load(ambientDb)) : load(db);
}

export function requireAutopayEnabled(): MiddlewareHandler {
  return async (c, next) => {
    const partnerId = c.get('auth')?.partnerId;
    // Self-managed routes have no ambient transaction. Close this short read
    // before entering the handler, which owns its own authorized context.
    const enabled = partnerId && await (getCurrentDbAccessContext()
      ? isAutopayEnabledForPartner(ambientDb, partnerId)
      : runOutsideDbContext(() => withSystemDbAccessContext(
        () => isAutopayEnabledForPartner(ambientDb, partnerId),
      )));
    if (!enabled) {
      return c.json({ error: 'Automatic payments are not enabled', code: 'autopay_not_enabled' }, 404);
    }
    await next();
  };
}
