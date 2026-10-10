import { and, eq, inArray, isNull, sql, type SQL } from 'drizzle-orm';
import { alias, type AnyPgColumn } from 'drizzle-orm/pg-core';
import type { MiddlewareHandler } from 'hono';
import { db as ambientDb, getCurrentDbAccessContext, runOutsideDbContext, withSystemDbAccessContext } from '../../db';
import { readWithPartnerAxisVisibility } from '../../db/partnerAxisRead';
import { partners } from '../../db/schema';
import { isPublicLinkPartnerStatusLive, PUBLIC_LINK_LIVE_PARTNER_STATUSES } from '../publicLinkOrgGate';
import type { Tx } from './types';

/**
 * The partner bar every automatic-payment entry point applies: the partner is
 * strictly `active` and not soft-deleted. It is the same bar the public invoice
 * and quote links use (`PUBLIC_LINK_LIVE_PARTNER_STATUSES`), so a partner that
 * can no longer take a payment through a link cannot set up, charge or retry
 * automatic payments either. Org liveness is checked separately by each caller.
 *
 * Callers that hold a row use `isAutopayPartnerLive`; queries that join
 * `partners` use `autopayPartnerLiveCondition`. Both read the same constant.
 */
export function isAutopayPartnerLive(partner: { status: string | null; deletedAt: Date | null } | null | undefined): boolean {
  return !!partner && !partner.deletedAt && isPublicLinkPartnerStatusLive(partner.status);
}

/** SQL form of `isAutopayPartnerLive`: true when the partner `partnerId` refers to is live.
 * Correlated on its own alias, so it works inside any outer query. */
export function autopayPartnerLiveCondition(partnerId: AnyPgColumn): SQL {
  const partner = alias(partners, 'autopay_live_partner');
  return sql`EXISTS (
    SELECT 1 FROM ${partners} AS ${sql.identifier('autopay_live_partner')}
    WHERE ${and(eq(partner.id, partnerId), inArray(partner.status, [...PUBLIC_LINK_LIVE_PARTNER_STATUSES]), isNull(partner.deletedAt))}
  )`;
}

/** Rollout flag plus partner liveness: whether automatic payments may run for this partner. */
export function isAutopayPartnerChargeable(partner: {
  autopayEnabled: boolean | null; status: string | null; deletedAt: Date | null;
} | null | undefined): boolean {
  return partner?.autopayEnabled === true && isAutopayPartnerLive(partner);
}

async function loadAutopayPartner(db: Tx, partnerId: string) {
  const load = async (executor: Tx) => {
    const [row] = await executor.select({ autopayEnabled: partners.autopayEnabled, status: partners.status, deletedAt: partners.deletedAt })
      .from(partners).where(eq(partners.id, partnerId)).limit(1);
    return row;
  };
  // partnerId must come from authenticated context or an RLS-visible org row.
  return getCurrentDbAccessContext()?.scope === 'organization'
    ? readWithPartnerAxisVisibility(() => load(ambientDb)) : load(db);
}

/**
 * Whether automatic payments may run for this partner: the rollout flag is on
 * AND the partner is live (`isAutopayPartnerLive`). Every setup, collection,
 * retry, reconcile and notice-planning path calls this one resolver.
 */
export async function isAutopayEnabledForPartner(db: Tx, partnerId: string): Promise<boolean> {
  return isAutopayPartnerChargeable(await loadAutopayPartner(db, partnerId));
}

/** Partner liveness alone, for paths that do not depend on the rollout flag. */
export async function hasLiveAutopayPartner(db: Tx, partnerId: string): Promise<boolean> {
  return isAutopayPartnerLive(await loadAutopayPartner(db, partnerId));
}

export function requireAutopayEnabled(): MiddlewareHandler {
  return async (c, next) => {
    const partnerId = c.get('autopayPartnerId') ?? c.get('auth')?.partnerId;
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
