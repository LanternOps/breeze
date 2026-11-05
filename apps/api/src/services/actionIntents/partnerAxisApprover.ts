/**
 * Approver scope for partner-wide intents (registry and reasoning:
 * `partnerWideEffect.ts`). Three questions, one answer each, so the fan-out and the
 * two re-checks cannot drift:
 *
 *  - does this intent need a partner-axis approver? Deny by default: only a row proved
 *    to sit in the intent's own org keeps the org's approver set;
 *  - who holds that axis? Full-partner members (`org_access = 'all'`) of the partner
 *    that owns the intent's org, whose role grants `approvals:decide`. Same bar as
 *    `canManagePartnerWidePolicies`, the gate on raising it: a `selected` member cannot
 *    delete a baseline, so cannot be the second person on one;
 *  - does this user hold it now? A live read at decide and at release, because a queued
 *    row is a durable capability and membership can change while it waits.
 *
 * The partner is always the one owning the intent's org, never one named by the row or
 * the session, so a foreign id cannot route an approval to another tenant.
 */
import { eq } from 'drizzle-orm';
import { db, runOutsideDbContext, withSystemDbAccessContext } from '../../db';
import { aiAgentSchedules, organizations } from '../../db/schema';
import type { AuthContext } from '../../middleware/auth';
import { canManagePartnerWidePolicies } from '../partnerWideAccess';
import { captureException } from '../sentry';
import { resolvePartnerUsersWithPermission } from '../usersWithPermission';
import { mayHavePartnerWideEffect } from './partnerWideEffect';

const APPROVALS_DECIDE = { resource: 'approvals', action: 'decide' };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// The escape is load-bearing: a nested system context inside a request context keeps
// the request's scope (db/index.ts), and these rows may be outside it.
const asSystem = <T>(fn: () => Promise<T>): Promise<T> => runOutsideDbContext(() => withSystemDbAccessContext(fn));

async function scheduleStaysInOrg(args: Record<string, unknown>, orgId: string): Promise<boolean> {
  const { scheduleId } = args;
  if (typeof scheduleId !== 'string' || !UUID_RE.test(scheduleId)) return false;
  const [row] = await asSystem(() =>
    db
      .select({ orgId: aiAgentSchedules.orgId, partnerId: aiAgentSchedules.partnerId })
      .from(aiAgentSchedules)
      .where(eq(aiAgentSchedules.id, scheduleId))
      .limit(1),
  );
  return row?.orgId === orgId && !row.partnerId;
}

/**
 * True when the intent's approver must hold the partner axis. A row that is gone, an
 * override in another org, a malformed id and a failed read all answer true: the
 * effect could not be shown to stay in the intent's org.
 */
export async function intentRequiresPartnerAxisApprover(intent: {
  actionName: string;
  arguments: Record<string, unknown> | null | undefined;
  orgId: string;
}): Promise<boolean> {
  if (!mayHavePartnerWideEffect(intent.actionName, intent.arguments)) return false;
  try {
    return !(await scheduleStaysInOrg(intent.arguments ?? {}, intent.orgId));
  } catch (err) {
    console.error('[partnerAxisApprover] could not read an intent target; requiring a partner-axis approver', err);
    captureException(err instanceof Error ? err : new Error(String(err)));
    return true;
  }
}

async function partnerOfOrg(orgId: string): Promise<string | null> {
  const [org] = await asSystem(() =>
    db
      .select({ partnerId: organizations.partnerId })
      .from(organizations)
      .where(eq(organizations.id, orgId))
      .limit(1),
  );
  return org?.partnerId ?? null;
}

/** The whole eligible population for an org's partner. Empty when the org has none. */
export async function resolvePartnerAxisApprovers(orgId: string): Promise<string[]> {
  const partnerId = await partnerOfOrg(orgId);
  if (!partnerId) return [];
  // No orgId: this resolver then counts `org_access = 'all'` only.
  return resolvePartnerUsersWithPermission(partnerId, APPROVALS_DECIDE);
}

/**
 * Whether this user holds the partner axis for the org, read live. At decide, pass the
 * `session` too: a full-partner member signed in on an org-only session is refused, as
 * is a partner session on another partner. A release has no session, so the live
 * membership decides.
 */
export async function isPartnerAxisApprover(
  userId: string,
  orgId: string,
  session?: Pick<AuthContext, 'scope' | 'partnerId' | 'partnerOrgAccess'>,
): Promise<boolean> {
  const partnerId = await partnerOfOrg(orgId);
  if (!partnerId) return false;
  if (session) {
    if (!canManagePartnerWidePolicies(session)) return false;
    if (session.scope !== 'system' && session.partnerId !== partnerId) return false;
  }
  const approvers = await resolvePartnerUsersWithPermission(partnerId, APPROVALS_DECIDE);
  return approvers.includes(userId);
}
