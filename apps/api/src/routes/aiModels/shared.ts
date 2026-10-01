/**
 * Gates and the write wrapper shared by the /ai/models partner routes (W04,
 * #7602). The scanner still indexes it (it reads c.get('auth')): mcpCoverage
 * lists it as internal_plumbing.
 */
import type { Context, MiddlewareHandler } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import { requireMfa, requirePermission } from '../../middleware/auth';
import { PERMISSIONS, userCanDecideApprovals } from '../../services/permissions';
import { canManagePartnerWidePolicies, PARTNER_WIDE_WRITE_DENIED_MESSAGE } from '../../services/partnerWideAccess';
import { ensurePartnerCutover } from '../../services/aiModels/registryCutover';
import { RegistryWriteError } from '../../services/aiModels/registryWriteErrors';
import { enqueueConnectionSync } from '../../jobs/aiModelDiscoveryWorker';
import { PartnerLlmError } from '../../services/partnerLlmConfig';
import { captureException } from '../../services/sentry';

// Fixed-length tuples, not MiddlewareHandler[]: Hono's typed route overloads
// only accept a spread whose length is known.

/** Partner registry reads: the /ai/provider gate (MFA is not required to read). */
export const partnerRead: readonly [MiddlewareHandler] = [
  requirePermission(PERMISSIONS.BILLING_MANAGE.resource, PERMISSIONS.BILLING_MANAGE.action),
];

/** Partner registry writes: every one changes cost or destination, so MFA too. */
export const partnerWrite: readonly [MiddlewareHandler, MiddlewareHandler] = [
  requirePermission(PERMISSIONS.BILLING_MANAGE.resource, PERMISSIONS.BILLING_MANAGE.action),
  requireMfa(),
];

/** Same gate as routes/aiProvider.ts: a partner token with orgAccess 'all' (or system with a partner context). */
export function requirePartnerWide(c: Context): { partnerId: string; userId: string } {
  const auth = c.get('auth');
  if (!auth?.partnerId) throw new HTTPException(403, { message: 'Partner context required' });
  if (!canManagePartnerWidePolicies(auth)) throw new HTTPException(403, { message: PARTNER_WIDE_WRITE_DENIED_MESSAGE });
  return { partnerId: auth.partnerId, userId: auth.user.id };
}

/** approvals:decide — required to change the script reviewer's model (partnerAiScriptPolicy.ts precedent). */
export function canDecideApprovals(c: Context): boolean {
  const perms = c.get('permissions');
  return Boolean(perms) && userCanDecideApprovals(perms);
}

/** Path params: a malformed id is a 400, never a uuid cast error from the DB. */
export const idParamSchema = z.object({ id: z.string().uuid() });
export const platformModelIdParamSchema = z.object({ platformModelId: z.string().uuid() });

export const APPROVALS_DECIDE_REQUIRED = {
  error: 'approvals:decide is required to change the script reviewer’s model',
  code: 'APPROVALS_DECIDE_REQUIRED',
} as const;

/**
 * Every registry write: W03's per-partner cutover gate first (a partner not yet
 * cut over would have the edit overwritten by its projection), then the write.
 * Typed errors map to their status; 5xx are captured, and no cause is ever echoed.
 */
export async function registryWrite(c: Context, partnerId: string, fn: () => Promise<Response>): Promise<Response> {
  // W03 contract (Q5): resolves false on failure (it captures the error
  // itself). A rejection is treated the same way.
  const cutOver = await ensurePartnerCutover(partnerId).catch((error: unknown) => {
    captureException(error, undefined, { service: 'aiModels', stage: 'cutover' });
    return false;
  });
  if (!cutOver) {
    return c.json({ error: 'AI configuration is being upgraded. Try again in a moment.', code: 'registry_unavailable' }, 503);
  }
  try {
    return await fn();
  } catch (error) {
    if (error instanceof RegistryWriteError) {
      // registry_busy is expected contention on the partner lock, not a fault.
      if (error.status >= 500 && error.code !== 'registry_busy') captureException(error, undefined, { service: 'aiModels' });
      return c.json({ error: error.message, code: error.code, ...(error.details ? { details: error.details } : {}) }, error.status);
    }
    if (error instanceof PartnerLlmError) {
      if (error.status >= 500) captureException(error, undefined, { service: 'aiModels' });
      return c.json({ error: error.message }, error.status);
    }
    throw error;
  }
}

/**
 * Queue model discovery for one connection (W03's `sync-connection` job, which
 * collapses onto a waiting/active job for the same connection). Returns null
 * when queued; a queue failure (Redis down) is a 503, captured, never echoed.
 */
export async function queueConnectionSync(c: Context, connectionId: string): Promise<Response | null> {
  try {
    await enqueueConnectionSync(connectionId);
    return null;
  } catch (error) {
    captureException(error, undefined, { service: 'aiModels', stage: 'enqueue' });
    return c.json({ error: 'Could not queue the model refresh. Try again in a moment.', code: 'queue_unavailable' }, 503);
  }
}
