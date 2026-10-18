// Owner: W02d (access-request inbox and decisions; plan W02d Task 4), mounted at /orgs.
// Approve and Resend release documents to an outside party, so they need MFA; Deny and Revoke only take access
// away and need organizations:write alone. The NDA text and the "ticket per request" toggle are page settings,
// written through PUT /trust-page (W02a) — this file adds no settings route.
import { Hono, type Context } from 'hono';
import { z } from 'zod';
import { trustAccessDecisionSchema, trustAccessRequestStatusSchema, PERMISSION_GRANTS } from '@breeze/shared';
import { zValidator } from '../lib/validation';
import { authMiddleware, requireMfa, requirePermission, requireScope, type AuthContext } from '../middleware/auth';
import { createAuditLogAsync } from '../services/auditService';
import { captureException } from '../services/sentry';
import { TrustPageError } from '../services/trustPage/publication';
import {
  approveAccessRequest, denyAccessRequest, listAccessRequests, resendAccessGrant, revokeAccessGrant,
} from '../services/trustPage/access/requests';

export const trustPageAccessRoutes = new Hono();
trustPageAccessRoutes.use('*', authMiddleware);
const scopes = requireScope('partner', 'system');
const orgRead = requirePermission(PERMISSION_GRANTS.ORGS_READ.resource, PERMISSION_GRANTS.ORGS_READ.action);
const orgWrite = requirePermission(PERMISSION_GRANTS.ORGS_WRITE.resource, PERMISSION_GRANTS.ORGS_WRITE.action);
const orgParam = z.object({ orgId: z.string().guid() });
const requestParam = z.object({ orgId: z.string().guid(), requestId: z.string().guid() });
const listQuery = z.object({ status: trustAccessRequestStatusSchema.optional() });

const notFound = (c: Context) => c.json({ error: 'Not found', code: 'NOT_FOUND' }, 404);
/** Partner users reach only their accessible orgs; RLS and the org-scoped request lookup back this up. */
const canAccess = (c: Context, orgId: string) => {
  const auth = c.get('auth') as AuthContext;
  return !(auth.scope === 'partner' && !auth.canAccessOrg(orgId));
};
function handleError(c: Context, err: unknown): Response {
  if (err instanceof TrustPageError) return c.json({ error: err.message, code: err.code }, err.status);
  captureException(err); throw err;
}
const audit = (c: Context, orgId: string, action: string, requestId: string, details: Record<string, unknown> = {}) => {
  const auth = c.get('auth') as AuthContext;
  return createAuditLogAsync({
    orgId, actorId: auth.user.id, actorEmail: auth.user.email, action, resourceType: 'trust_page_access_request', resourceId: requestId,
    details: { requestId, ...details }, result: 'success',
  });
};
const optionalJson = async (c: Context) => {
  try { return trustAccessDecisionSchema.safeParse(await c.req.json()); } catch { return trustAccessDecisionSchema.safeParse({}); }
};

trustPageAccessRoutes.get('/:orgId/trust-page/access-requests', scopes, orgRead, zValidator('param', orgParam), zValidator('query', listQuery), async (c) => {
  const { orgId } = c.req.valid('param');
  if (!canAccess(c, orgId)) return notFound(c);
  try {
    return c.json({ data: { requests: await listAccessRequests(orgId, c.req.valid('query').status, new Date()) } });
  } catch (err) { return handleError(c, err); }
});

trustPageAccessRoutes.post('/:orgId/trust-page/access-requests/:requestId/approve', scopes, orgWrite, requireMfa(), zValidator('param', requestParam), zValidator('json', trustAccessDecisionSchema), async (c) => {
  const { orgId, requestId } = c.req.valid('param');
  if (!canAccess(c, orgId)) return notFound(c);
  const auth = c.get('auth') as AuthContext;
  try {
    const out = await approveAccessRequest({ requestId, orgId, actorUserId: auth.user.id, note: c.req.valid('json').note ?? null, now: new Date() });
    await audit(c, orgId, 'trust_page.access.approve', requestId, { grantedDocumentIds: out.grantedDocumentIds, grantExpiresAt: out.grantExpiresAt.toISOString() });
    return c.json({ data: { status: 'approved', grantExpiresAt: out.grantExpiresAt.toISOString(), grantedDocumentIds: out.grantedDocumentIds } });
  } catch (err) { return handleError(c, err); }
});

trustPageAccessRoutes.post('/:orgId/trust-page/access-requests/:requestId/deny', scopes, orgWrite, zValidator('param', requestParam), async (c) => {
  const { orgId, requestId } = c.req.valid('param');
  if (!canAccess(c, orgId)) return notFound(c);
  const parsed = await optionalJson(c);
  if (!parsed.success) return c.json({ error: 'The note is too long (500 characters at most).', code: 'VALIDATION_ERROR' }, 400);
  const auth = c.get('auth') as AuthContext;
  try {
    await denyAccessRequest({ requestId, orgId, actorUserId: auth.user.id, note: parsed.data.note ?? null, now: new Date() });
    await audit(c, orgId, 'trust_page.access.deny', requestId, { noteRecorded: Boolean(parsed.data.note) });
    return c.json({ data: { status: 'denied' } });
  } catch (err) { return handleError(c, err); }
});

trustPageAccessRoutes.post('/:orgId/trust-page/access-requests/:requestId/revoke', scopes, orgWrite, zValidator('param', requestParam), async (c) => {
  const { orgId, requestId } = c.req.valid('param');
  if (!canAccess(c, orgId)) return notFound(c);
  const auth = c.get('auth') as AuthContext;
  try {
    await revokeAccessGrant({ requestId, orgId, actorUserId: auth.user.id, now: new Date() });
    await audit(c, orgId, 'trust_page.access.revoke', requestId);
    return c.json({ data: { status: 'revoked' } });
  } catch (err) { return handleError(c, err); }
});

trustPageAccessRoutes.post('/:orgId/trust-page/access-requests/:requestId/resend', scopes, orgWrite, requireMfa(), zValidator('param', requestParam), async (c) => {
  const { orgId, requestId } = c.req.valid('param');
  if (!canAccess(c, orgId)) return notFound(c);
  const auth = c.get('auth') as AuthContext;
  try {
    await resendAccessGrant({ requestId, orgId, actorUserId: auth.user.id, now: new Date() });
    await audit(c, orgId, 'trust_page.access.resend', requestId);
    return c.json({ data: { status: 'approved' } });
  } catch (err) { return handleError(c, err); }
});
