import type { Context } from 'hono';
import { hasSatisfiedMfa, isInteractiveUserSession, type AuthContext } from '../middleware/auth';
import { getUserEpochs } from '../services/authEpochs';
import { consumeStepUpGrant, type StepUpOperation } from '../services/mfaStepUpGrant';
import { ENABLE_2FA } from './auth/schemas';

/** Billing actions that move money or change who is asked to authorize it. */
export type BillingStepUpOperation = Extract<StepUpOperation,
  'autopay_charge_now' | 'partner_payment_settings_update' | 'org_payment_settings_update' | 'autopay_request_recipient'>;

/**
 * Second-factor confirmation for a billing action (charging a client now,
 * changing partner or organization payment settings, sending a client's
 * authorization request to an address other than its billing contact).
 *
 * Same contract as the device move-org and maintenance step-ups: an
 * interactive user session with a satisfied second factor, and, while
 * two-factor authentication is enabled on the deployment, a fresh single-use
 * grant for this exact operation and resource, consumed here. Call it after
 * the route's read-only checks and immediately before the action, so a
 * request that would be refused anyway burns no grant.
 *
 * Missing, stale, replayed and mismatched grants get one answer on purpose: a
 * `403 STEP_UP_REQUIRED` naming the operation and the resource to bind the
 * grant to (the client sends that resource back verbatim to POST
 * /auth/mfa/step-up and resubmits with `stepUpGrant`). With two-factor
 * authentication disabled no grant is asked for, as for the other step-up
 * operations.
 *
 * Returns the refusal to send, or null when the action may proceed.
 */
export async function requireBillingStepUp(c: Context, input: {
  operation: BillingStepUpOperation;
  /** Echoed to the client; must be exactly what the mint route digests for this operation. */
  resource: Record<string, unknown>;
  resourceDigest: `sha256:${string}`;
  grant: string | undefined;
}): Promise<Response | null> {
  const auth = c.get('auth') as AuthContext;
  if (!isInteractiveUserSession(auth)) return c.json({ error: 'Interactive user session required' }, 403);
  if (!hasSatisfiedMfa(auth)) return c.json({ error: 'MFA required', code: 'MFA_REQUIRED' }, 403);
  if (!ENABLE_2FA) return null;
  const required = () => c.json({ error: 'Step-up required', code: 'STEP_UP_REQUIRED',
    stepUp: { operation: input.operation, resource: input.resource } }, 403);
  if (!input.grant) return required();
  const epochs = await getUserEpochs(auth.user.id);
  const sid = auth.token?.sid;
  if (!epochs || !sid) {
    // Nothing was attempted: coded so a client never reads it as an unknown charge result.
    console.error(`[billingStepUp] ${input.operation}: ${!sid ? 'session has no sid' : 'user epochs unavailable'} for user ${auth.user.id}`);
    return c.json({ error: 'Second-factor verification is temporarily unavailable', code: 'STEP_UP_UNAVAILABLE' }, 503);
  }
  const consumed = await consumeStepUpGrant(input.grant, {
    userId: auth.user.id,
    operation: input.operation,
    authEpoch: epochs.authEpoch,
    mfaEpoch: epochs.mfaEpoch,
    sid,
    resourceDigest: input.resourceDigest,
  });
  return consumed ? null : required();
}
