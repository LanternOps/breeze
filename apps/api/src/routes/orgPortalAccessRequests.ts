import type { Context, Hono } from 'hono';
import { z } from 'zod';
import { eq } from 'drizzle-orm';
import { decidePortalAccessRequestsSchema } from '@breeze/shared';
import { zValidator } from '../lib/validation';
import { db, withDbTransaction } from '../db';
import { organizations, partners } from '../db/schema';
import { requireMfa, requirePartner, requirePermission, requireScope, type AuthContext } from '../middleware/auth';
import { PERMISSIONS } from '../services/permissions';
import { writeRouteAudit } from '../services/auditEvents';
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
 * ONE `withDbTransaction` (services/portalAccessRequests.ts), so a refusal has
 * already rolled back every statement it ran when the catch below sees it, and
 * the request transaction commits cleanly. The catch sits OUTSIDE the call and
 * this file adds no transaction of its own. `/decide` runs the ids one after
 * another, never in `Promise.all`.
 *
 * Emails (OD3) go out after the service returns: a self request's approval
 * sends the normal invite, an SSO / add-in approval sends "you can now sign
 * in", a denial sends the neutral declined email. A failed send is logged and
 * does not undo the decision, the same as invites.
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

type DecisionRefusal = { status: 400 | 403 | 404 | 409; body: { error: string; code: string } };

/** A refusal from the service as `{ error, code }` with its status; anything else is rethrown (a 500). */
function decisionRefusal(err: unknown): DecisionRefusal {
  if (err instanceof PortalAccessRequestError) {
    return { status: err.httpStatus, body: { error: err.message, code: err.code } };
  }
  if (err instanceof PortalAccountTransitionError) {
    return { status: err.httpStatus, body: { error: err.message, code: err.code } };
  }
  throw err;
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
      console.error('[orgPortalAccessRequests] org/partner name read failed; sending unbranded', err);
      return { orgName: null, partnerName: undefined };
    }
  };
  return () => (cached ??= read());
}

/**
 * Send the email for one decision (OD3). Returns whether it went out; never
 * throws, because the decision stands either way.
 */
async function notifyDecision(c: Context, orgId: string, decided: Decided, names: () => Promise<EmailNames>): Promise<boolean> {
  const auth = c.get('auth') as AuthContext;
  try {
    const { orgName, partnerName } = await names();
    if (decided.kind === 'approve' && decided.result.outcome === 'invite_pending') {
      const { portalUserId, email, authEpoch } = decided.result;
      return await issueAndSendInvite(c, orgId, { id: portalUserId, email, authEpoch }, orgName, auth.user.name);
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
  } catch (err) {
    console.error(`[orgPortalAccessRequests] ${decided.kind} email failed requestId=${decided.requestId} orgId=${orgId}`, err);
    return false;
  }
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

      // Sequential: each call opens its own savepoint in the request
      // transaction, and two savepoints in a Promise.all fail together.
      const data: Array<{ requestId: string; result: string }> = [];
      const decided: Decided[] = [];
      for (const requestId of requestIds) {
        const input = { orgId: org.id, requestId, deciderUserId: auth.user.id };
        try {
          if (decision === 'approve') {
            decided.push({ kind: 'approve', requestId, result: await approvePortalAccessRequest(input) });
            data.push({ requestId, result: 'approved' });
          } else {
            decided.push({ kind: 'deny', requestId, result: await denyPortalAccessRequest(input) });
            data.push({ requestId, result: 'denied' });
          }
        } catch (err) {
          // A refusal is reported for this id and the batch goes on. Anything
          // else rethrows: the request transaction then rolls every decision
          // back, which is why no audit row or email is written until the loop ends.
          data.push({ requestId, result: decisionRefusal(err).body.code });
        }
      }

      const names = emailNamesReader(org.id);
      for (const item of decided) {
        auditDecision(c, org.id, item);
        await notifyDecision(c, org.id, item, names);
      }
      return c.json({ data });
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
        return c.json(refusal.body, refusal.status);
      }

      const decided: Decided = { kind: 'approve', requestId, result };
      auditDecision(c, org.id, decided);
      const emailSent = await notifyDecision(c, org.id, decided, emailNamesReader(org.id));
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
        return c.json(refusal.body, refusal.status);
      }

      const decided: Decided = { kind: 'deny', requestId, result };
      auditDecision(c, org.id, decided);
      const emailSent = await notifyDecision(c, org.id, decided, emailNamesReader(org.id));
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
