/**
 * Multi-org report series — authority (spec §3.4).
 *
 * A child runs as the series OWNER, captured per child for THAT child's org
 * (the fingerprint binds the org id). The owner must be a user of the series'
 * partner with live partner-wide report authority (org_access = 'all', role
 * grants reports:export, user and partner active) — checked at series write,
 * at every reconcile and at every worker gate. A child whose owner cannot
 * reach its org is blocked; it is never run with substitute or system
 * authority.
 */
import { eq } from 'drizzle-orm';
import { users } from '../../db/schema';
import {
  persistedSiteScopeValues,
  resolveLivePartnerReportAuthority,
  resolveLiveReportAuthority,
  type PersistedSiteScopeColumns,
} from '../siteScope';
import { isReportSeriesError, ReportSeriesError } from './errors';
import type { SeriesTx } from './types';

/** INDEX name for the execution-scope columns a child row stores. */
export type ExecutionScopeColumns = PersistedSiteScopeColumns;

/**
 * The live resolver could not verify authority (a transient DB/lookup failure,
 * reported as 'unverifiable_scope'). Deliberately NOT a ReportSeriesError: it
 * is not a denial. Callers must abort and retry rather than block children.
 */
export interface SeriesAuthorityUnverifiableContext {
  /** The live resolver's own reason (today always 'unverifiable_scope'). */
  reason: string;
  ownerUserId: string;
  partnerId?: string;
  orgId?: string;
}

export class SeriesAuthorityUnverifiableError extends Error {
  /** True once reconcile/gate logged it with its series id (logged once). */
  logged = false;

  constructor(readonly context?: SeriesAuthorityUnverifiableContext) {
    super(context
      ? `report series owner authority could not be verified (reason: ${context.reason}; owner ${context.ownerUserId}`
        + `${context.partnerId ? `; partner ${context.partnerId}` : ''}${context.orgId ? `; org ${context.orgId}` : ''})`
      : 'report series owner authority could not be verified');
    this.name = 'SeriesAuthorityUnverifiableError';
  }
}

function ineligible(reason: string): ReportSeriesError {
  return new ReportSeriesError('series_owner_ineligible', 400, { reason });
}

export async function assertSeriesOwnerEligible(
  userId: string,
  partnerId: string,
  tx: SeriesTx,
): Promise<void> {
  // The partner check comes first and from the users row: the live resolver
  // admits a PLATFORM ADMIN of any partner (allowPlatformAuthority), and a
  // series owner must belong to the series' own partner.
  const [user] = await tx
    .select({ partnerId: users.partnerId })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  if (!user || user.partnerId !== partnerId) throw ineligible('owner_not_partner_user');

  const live = await resolveLivePartnerReportAuthority(userId, partnerId, 'export');
  if (!live.ok) {
    if (live.reason === 'unverifiable_scope') {
      throw new SeriesAuthorityUnverifiableError({ reason: live.reason, ownerUserId: userId, partnerId });
    }
    throw ineligible(live.reason);
  }
}

export async function isSeriesOwnerEligible(
  userId: string,
  partnerId: string,
  tx: SeriesTx,
): Promise<boolean> {
  try {
    await assertSeriesOwnerEligible(userId, partnerId, tx);
    return true;
  } catch (err) {
    if (isReportSeriesError(err, 'series_owner_ineligible')) return false;
    throw err;
  }
}

export async function captureChildExecutionScope(
  ownerUserId: string,
  orgId: string,
  // Reserved (INDEX signature): the live resolver reads on its own system
  // connection by design, as every report-authority check does.
  _tx: SeriesTx,
): Promise<ExecutionScopeColumns | 'no_authority'> {
  const live = await resolveLiveReportAuthority(ownerUserId, orgId, 'export');
  if (!live.ok && live.reason === 'unverifiable_scope') {
    throw new SeriesAuthorityUnverifiableError({ reason: live.reason, ownerUserId, orgId });
  }
  if (!live.ok || live.authority.scope.kind !== 'unrestricted') return 'no_authority';
  return persistedSiteScopeValues(live.authority);
}
