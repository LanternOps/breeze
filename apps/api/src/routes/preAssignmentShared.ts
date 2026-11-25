/**
 * Gates and helpers shared by the pre-assignment route files
 * (routes/preAssignment.ts and routes/preAssignmentDeployKeys.ts), so both
 * enforce exactly the same access rule. Registers no route itself.
 */
import type { Context } from 'hono';
import { z } from 'zod';
import {
  requireInteractiveSession,
  requireMfa,
  requirePermission,
  requireScope,
  type AuthContext,
} from '../middleware/auth';
import { PERMISSIONS } from '../services/permissions';
import { canManagePartnerWidePolicies, PARTNER_WIDE_WRITE_DENIED_MESSAGE } from '../services/partnerWideAccess';
import { validateStepUpGrant, type StepUpGrantBinding, type StepUpOperation } from '../services/mfaStepUpGrant';
import { getUserEpochs } from '../services/authEpochs';
import { ENABLE_2FA } from './auth/schemas';

/**
 * Partner or system scope, an interactive user session (API keys and MCP
 * tokens are refused), devices:write + organizations:write, and an
 * MFA-assured session. canManagePartnerWidePolicies is checked per handler by
 * resolvePartner.
 */
export const preAssignmentGates = [
  requireScope('partner', 'system'),
  requireInteractiveSession(),
  requirePermission(PERMISSIONS.DEVICES_WRITE.resource, PERMISSIONS.DEVICES_WRITE.action),
  requirePermission(PERMISSIONS.ORGS_WRITE.resource, PERMISSIONS.ORGS_WRITE.action),
  requireMfa(),
] as const;

export const STEP_UP_REQUIRED_BODY = { error: 'Step-up required', code: 'STEP_UP_REQUIRED' } as const;

export const partnerQuerySchema = z.object({ partnerId: z.string().uuid().optional() });

export type PartnerResolution = { ok: true; partnerId: string } | { ok: false; response: Response };

/**
 * The partner whose holding area this request acts on. Partner callers act on
 * their own partner only; system callers must name one. Only full partner
 * admins (canManagePartnerWidePolicies) get past it.
 */
export function resolvePartner(c: Context, auth: AuthContext, requested: string | undefined): PartnerResolution {
  if (!canManagePartnerWidePolicies(auth)) {
    return { ok: false, response: c.json({ error: PARTNER_WIDE_WRITE_DENIED_MESSAGE }, 403) };
  }
  if (auth.scope === 'system') {
    if (!requested) {
      return { ok: false, response: c.json({ error: 'partnerId is required for system scope' }, 400) };
    }
    return { ok: true, partnerId: requested };
  }
  if (!auth.partnerId || (requested && requested !== auth.partnerId)) {
    return { ok: false, response: c.json({ error: 'Access to this partner denied' }, 403) };
  }
  return { ok: true, partnerId: auth.partnerId };
}

export type PreAssignmentStepUpOperation = Extract<
  StepUpOperation,
  'parked_device_assign' | 'parked_device_assign_bulk' | 'pre_assignment_enable' | 'deploy_key_mint' | 'deploy_key_rotate'
>;

/**
 * Builds and validates the step-up binding. Returns null with 2FA off, the
 * binding when the grant validates, or a 403/503 response. Validation does
 * not consume the grant; the service consumes it inside its transaction.
 */
export async function checkStepUp(
  c: Context,
  auth: AuthContext,
  operation: PreAssignmentStepUpOperation,
  resourceDigest: string,
  grantId: string | undefined,
): Promise<{ binding: StepUpGrantBinding | null } | { response: Response }> {
  if (!ENABLE_2FA) return { binding: null };
  const epochs = await getUserEpochs(auth.user.id);
  const sid = auth.token?.sid;
  if (!epochs || !sid) return { response: c.json({ error: 'Service temporarily unavailable' }, 503) };
  const binding: StepUpGrantBinding = {
    userId: auth.user.id,
    operation,
    authEpoch: epochs.authEpoch,
    mfaEpoch: epochs.mfaEpoch,
    sid,
    resourceDigest,
  };
  // Missing, stale and mismatched grants are one response on purpose.
  if (!grantId || !(await validateStepUpGrant(grantId, binding))) {
    return { response: c.json(STEP_UP_REQUIRED_BODY, 403) };
  }
  return { binding };
}
