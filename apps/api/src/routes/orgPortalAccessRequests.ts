import type { Context, Hono } from 'hono';
import { z } from 'zod';
import { eq, sql } from 'drizzle-orm';
import { decidePortalAccessRequestsSchema } from '@breeze/shared';
import { zValidator } from '../lib/validation';
import { db, withDbTransaction } from '../db';
import { organizations, partners } from '../db/schema';
import { requireMfa, requirePartner, requirePermission, requireScope, type AuthContext } from '../middleware/auth';
import { PERMISSIONS } from '../services/permissions';
import { writeRouteAudit } from '../services/auditEvents';
import { safeErrorMessage } from '../services/aiModels/safeDbError';
import { getEmailService } from '../services/email';
import {
  PortalAccessRequestError,
  approvePortalAccessRequest,
  denyPortalAccessRequest,
  listPortalAccessRequests,
  summarizePendingPortalAccessRequests,
  type ApprovePortalAccessRequestResult,
} from '../services/portalAccessRequests';
import type { PortalAccessRequestSource } from '../db/schema';
import { PortalAccountTransitionError } from '../services/portalAccountState';
import { resolveAccessibleOrg } from './orgPortalSettings';
import { issueAndSendInvite } from './orgPortalUsers';
import { buildPortalUrl } from './portal/helpers';

/**
 * The MSP side of the customer-portal access-request queue (portal
 * registration W3 #11380; spec §5.1, §5.10): list an org's requests, approve
 * or deny one, decide a batch, and the partner-wide pending count (plan D8).
 * Registered onto orgRoutes so every route inherits its authMiddleware.
 *
 * Transactions (#11203, docs/agents/tenancy-rls.md): approve and deny each own
 * ONE `withDbTransaction` (services/portalAccessRequests.ts), so any failure
 * has already rolled back every statement that decision ran when the catch
 * below sees it, and the request transaction stays usable. The catch sits
 * OUTSIDE the call. `/decide` runs the ids one after another, never in
 * `Promise.all`.
 *
 * A handler's throw is NOT a rollback: Hono turns it into a 500 and the
 * request transaction (opened by authMiddleware) commits whatever was decided
 * before it. So nothing after a decision may throw: `/decide` maps every
 * per-id failure to a result code and finishes the batch, and the audit row
 * and the email of each decision are written whatever happened to the others.
 *
 * Emails (OD3) go out after the service returns: a self request's approval
 * sends the normal invite, an SSO / add-in approval sends "you can now sign
 * in", a denial sends the neutral declined email. Each send runs in its own
 * savepoint (see notifyDecision). A failed send is logged and does not undo the
 * decision, the same as invites.
 */

// Hex 8-4-4-4-12, not zod's RFC-strict uuid(): seeded ids need not carry RFC
// version/variant bits, and a malformed id must be a 400 rather than a 22P02 500.
const ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const idParam = z.string().regex(ID_RE, 'Invalid id');
const orgParamSchema = z.object({ id: idParam });
const requestParamSchema = z.object({ id: idParam, requestId: idParam });
const listQuerySchema = z.object({
  status: z.enum(['pending', 'decided']).default('pending'),
  limit: z.coerce.number().int().min(1).max(200).optional(),
});

const APPROVE_ACTION = 'organization.portal_user.access_request.approve';
const DENY_ACTION = 'organization.portal_user.access_request.deny';
/** The `/decide` result for an id whose decision failed with anything but a refusal. */
const DECIDE_INTERNAL_ERROR = 'INTERNAL_ERROR';

type DecisionRefusal = { status: 400 | 403 | 404 | 409; body: { error: string; code: string } };

/** A refusal from the service as `{ error, code }` with its status; null for anything else. */
function decisionRefusal(err: unknown): DecisionRefusal | null {
  if (err instanceof PortalAccessRequestError) {
    return { status: err.httpStatus, body: { error: err.message, code: err.code } };
  }
  if (err instanceof PortalAccountTransitionError) {
    return { status: err.httpStatus, body: { error: err.message, code: err.code } };
  }
  return null;
}

type Decided =
  | { kind: 'approve'; requestId: string; result: ApprovePortalAccessRequestResult }
  | { kind: 'deny'; requestId: string; result: { email: string; source: PortalAccessRequestSource } };

/** One audit row per decided request (spec §5.10). Refusals write none. */
function auditDecision(c: Context, orgId: string, decided: Decided): void {
  const details = decided.kind === 'approve'
    ? { source: decided.result.source, outcome: decided.result.outcome, portalUserId: decided.result.portalUserId, email: decided.result.email }
    : { source: decided.result.source, outcome: 'denied', portalUserId: null, email: decided.result.email };
  writeRouteAudit(c, {
    orgId,
    action: decided.kind === 'approve' ? APPROVE_ACTION : DENY_ACTION,
    resourceType: 'portal_access_request',
    resourceId: decided.requestId,
    details,
  });
}

type EmailNames = { orgName: string | null; partnerName: string | undefined };

/**
 * The org and partner names the decision emails carry, read once per request.
 * Savepoint so a failed read rolls back on its own and the decision still
 * commits, with the emails unbranded (#11203).
 */
function emailNamesReader(orgId: string): () => Promise<EmailNames> {
  let cached: Promise<EmailNames> | undefined;
  const read = async (): Promise<EmailNames> => {
    try {
      return await withDbTransaction(async () => {
        const [row] = await db
          .select({ orgName: organizations.name, partnerName: partners.name })
          .from(organizations)
          .leftJoin(partners, eq(partners.id, organizations.partnerId))
          .where(eq(organizations.id, orgId))
          .limit(1);
        return { orgName: row?.orgName ?? null, partnerName: row?.partnerName ?? undefined };
      });
    } catch (err) {
      console.error(`[orgPortalAccessRequests] org/partner name read failed; sending unbranded orgId=${orgId}: ${safeErrorMessage(err)}`);
      return { orgName: null, partnerName: undefined };
    }
  };
  return () => (cached ??= read());
}

/** The email for one decision (OD3). Returns whether it went out; a failure throws. */
async function sendDecisionEmail(c: Context, orgId: string, decided: Decided, { orgName, partnerName }: EmailNames): Promise<boolean> {
  const auth = c.get('auth') as AuthContext;
  if (decided.kind === 'approve' && decided.result.outcome === 'invite_pending') {
    const { portalUserId, email, authEpoch } = decided.result;
    return issueAndSendInvite(c, orgId, { id: portalUserId, email, authEpoch }, orgName, auth.user.name);
  }
  const emailService = getEmailService();
  if (!emailService) {
    console.warn(`[orgPortalAccessRequests] ${decided.kind} email not sent (no email service configured) requestId=${decided.requestId} orgId=${orgId}`);
    return false;
  }
  // Partner from the VERIFIED auth context, never request input (spec §8.1),
  // exactly as issueAndSendInvite: a system-scope caller has partnerId null,
  // which resolves to the platform sender.
  const sender = { orgName: orgName ?? undefined, partnerId: auth.partnerId ?? null, partnerName };
  if (decided.kind === 'approve') {
    await emailService.sendPortalAccessApproved({ to: decided.result.email, loginUrl: buildPortalUrl('/login'), ...sender });
  } else {
    await emailService.sendPortalAccessDeclined({ to: decided.result.email, ...sender });
  }
  return true;
}

/**
 * Send the email for one decision. Returns whether it went out; never throws,
 * because the decision stands either way.
 *
 * Savepoint, with the catch outside it (#11203). The send path reads the
 * database: issueAndSendInvite's branding read, and the partner-lane sender
 * lookup (services/emailDomains/partnerLaneLookup.ts), which runs in place in a
 * partner request context. A failed statement there, even one caught further in
 * (issueAndSendInvite catches its own send), is rethrown when the request
 * transaction commits: a 500 that rolls the decision back. In the savepoint it
 * stops there and the decision commits with `emailSent: false`. Nothing the
 * send path writes needs to outlive a failed send, so the rollback costs nothing.
 */
async function notifyDecision(c: Context, orgId: string, decided: Decided, names: () => Promise<EmailNames>): Promise<boolean> {
  try {
    const resolved = await names();
    return await withDbTransaction(() => sendDecisionEmail(c, orgId, decided, resolved));
  } catch (err) {
    console.error(`[orgPortalAccessRequests] ${decided.kind} email failed requestId=${decided.requestId} orgId=${orgId}: ${safeErrorMessage(err)}`);
    return false;
  }
}

/**
 * Everything after one committed decision: its audit row, then its email.
 * Never throws (a throw here would leave the decision committed behind a 500
 * with no email). Returns whether the email went out.
 */
async function announceDecision(c: Context, orgId: string, decided: Decided, names: () => Promise<EmailNames>): Promise<boolean> {
  try {
    auditDecision(c, orgId, decided);
  } catch (err) {
    console.error(`[orgPortalAccessRequests] ${decided.kind} audit write failed requestId=${decided.requestId} orgId=${orgId}: ${safeErrorMessage(err)}`);
  }
  return notifyDecision(c, orgId, decided, names);
}

export function registerOrgPortalAccessRequestRoutes(orgRoutes: Hono): void {
  const requireOrgRead = requirePermission(PERMISSIONS.ORGS_READ.resource, PERMISSIONS.ORGS_READ.action);
  const requireOrgWrite = requirePermission(PERMISSIONS.ORGS_WRITE.resource, PERMISSIONS.ORGS_WRITE.action);

  orgRoutes.get(
    '/organizations/:id/portal-access-requests',
    requireScope('partner', 'system'),
    requireOrgRead,
    zValidator('param', orgParamSchema),
    zValidator('query', listQuerySchema),
    async (c) => {
      const org = await resolveAccessibleOrg(c);
      if (org instanceof Response) return org;
      const { status, limit } = c.req.valid('query');
      const { items, hasMore } = await listPortalAccessRequests(org.id, limit === undefined ? { status } : { status, limit });
      return c.json({ data: items, hasMore });
    },
  );

  // Registered before the `:requestId` routes. The shapes cannot collide
  // (`/decide` has one segment fewer than `/:requestId/approve`), and the order
  // keeps it that way if a `/:requestId` route is ever added.
  orgRoutes.post(
    '/organizations/:id/portal-access-requests/decide',
    requireScope('partner', 'system'),
    requireOrgWrite,
    requireMfa(),
    zValidator('param', orgParamSchema),
    zValidator('json', decidePortalAccessRequestsSchema),
    async (c) => {
      const org = await resolveAccessibleOrg(c);
      if (org instanceof Response) return org;
      const auth = c.get('auth') as AuthContext;
      const { requestIds, decision } = c.req.valid('json');

      // Lock order. Each decision takes `SELECT … FOR UPDATE` on its request
      // row and holds it until the request transaction commits, so two
      // overlapping batches run in client order ([A,B] beside [B,A]) would
      // each hold one row and wait for the other's (40P01). So every batch
      // decides its distinct ids in ascending id order: the row locks are
      // taken in one global order. Id order is enough for the address locks
      // too. Approve takes its per-address advisory lock only AFTER the row
      // lock, and within one org a pending request and its address are 1:1
      // (`portal_access_requests_pending_email_uq`), so address locks are
      // also taken in id order. A deadlock on anything else (say, another
      // request's uncommitted account row) fails that one id as
      // INTERNAL_ERROR, not the batch.
      // Ids are keyed lowercased, so a duplicate in any letter case is decided
      // once and every occurrence reports that result.
      const order = [...new Set(requestIds.map((id) => id.toLowerCase()))].sort();

      // Sequential: each call opens its own savepoint in the request
      // transaction, and two savepoints in a Promise.all fail together.
      const results = new Map<string, string>();
      const decided: Decided[] = [];
      let unexpectedFailure = false;
      for (const requestId of order) {
        const input = { orgId: org.id, requestId, deciderUserId: auth.user.id };
        try {
          if (decision === 'approve') {
            decided.push({ kind: 'approve', requestId, result: await approvePortalAccessRequest(input) });
            results.set(requestId, 'approved');
          } else {
            decided.push({ kind: 'deny', requestId, result: await denyPortalAccessRequest(input) });
            results.set(requestId, 'denied');
          }
        } catch (err) {
          // EVERY failure is caught, never rethrown: the service's savepoint
          // has already rolled back this id's statements, and a throw would
          // commit the ids decided before it with no audit row or email.
          const refusal = decisionRefusal(err);
          if (!refusal) {
            unexpectedFailure = true;
            console.error(`[orgPortalAccessRequests] decide ${decision} failed requestId=${requestId} orgId=${org.id}: ${safeErrorMessage(err)}`);
          }
          results.set(requestId, refusal ? refusal.body.code : DECIDE_INTERNAL_ERROR);
        }
      }

      // An unexpected failure is normally one its savepoint contained, and the
      // request transaction is still good. If it broke the transaction instead
      // (a lost connection), nothing here will commit, and an audit row (written
      // on its own connection) or an email would announce decisions that roll
      // back. This statement then throws, so the request is a 500 that
      // announces nothing. Deliberately bare: it must fail on that transaction.
      if (unexpectedFailure) await db.execute(sql`SELECT 1`);

      const names = emailNamesReader(org.id);
      for (const item of decided) {
        await announceDecision(c, org.id, item, names);
      }
      return c.json({
        data: requestIds.map((requestId) => ({
          requestId,
          result: results.get(requestId.toLowerCase()) ?? DECIDE_INTERNAL_ERROR,
        })),
      });
    },
  );

  orgRoutes.post(
    '/organizations/:id/portal-access-requests/:requestId/approve',
    requireScope('partner', 'system'),
    requireOrgWrite,
    requireMfa(),
    zValidator('param', requestParamSchema),
    async (c) => {
      const org = await resolveAccessibleOrg(c);
      if (org instanceof Response) return org;
      const auth = c.get('auth') as AuthContext;
      const { requestId } = c.req.valid('param');

      let result: ApprovePortalAccessRequestResult;
      try {
        result = await approvePortalAccessRequest({ orgId: org.id, requestId, deciderUserId: auth.user.id });
      } catch (err) {
        const refusal = decisionRefusal(err);
        // Anything else is a 500 with nothing committed: the service's
        // savepoint rolled the whole decision back, and nothing ran before it.
        if (!refusal) throw err;
        return c.json(refusal.body, refusal.status);
      }

      const decided: Decided = { kind: 'approve', requestId, result };
      const emailSent = await announceDecision(c, org.id, decided, emailNamesReader(org.id));
      return c.json({ data: { outcome: result.outcome, portalUserId: result.portalUserId }, emailSent });
    },
  );

  orgRoutes.post(
    '/organizations/:id/portal-access-requests/:requestId/deny',
    requireScope('partner', 'system'),
    requireOrgWrite,
    requireMfa(),
    zValidator('param', requestParamSchema),
    async (c) => {
      const org = await resolveAccessibleOrg(c);
      if (org instanceof Response) return org;
      const auth = c.get('auth') as AuthContext;
      const { requestId } = c.req.valid('param');

      let result: { email: string; source: PortalAccessRequestSource };
      try {
        result = await denyPortalAccessRequest({ orgId: org.id, requestId, deciderUserId: auth.user.id });
      } catch (err) {
        const refusal = decisionRefusal(err);
        if (!refusal) throw err; // a 500 with nothing committed, as approve
        return c.json(refusal.body, refusal.status);
      }

      const decided: Decided = { kind: 'deny', requestId, result };
      const emailSent = await announceDecision(c, org.id, decided, emailNamesReader(org.id));
      return c.json({ data: { status: 'denied' as const }, emailSent });
    },
  );

  orgRoutes.get(
    '/partners/me/portal-access-requests/summary',
    requireScope('partner'),
    requirePartner,
    requireOrgRead,
    async (c) => {
      const auth = c.get('auth') as AuthContext;
      // RLS already bounds the read to the caller's accessible orgs; the
      // canAccessOrg filter states the selected-orgs rule in the route too.
      const summary = await summarizePendingPortalAccessRequests();
      const orgs = summary.orgs.filter((o) => auth.canAccessOrg(o.orgId));
      return c.json({ data: { pendingTotal: orgs.reduce((sum, o) => sum + o.pending, 0), orgs } });
    },
  );
}
