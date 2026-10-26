/**
 * Tool Catalog W05 (#5220), plan Task A5 / Decision 3 — the per-flow webhook
 * secret.
 *
 *  - One secret per flow on `flows.webhook_secret_encrypted`: secretCrypto
 *    with row-bound AAD (`encryptedColumnRegistry` flows.webhook_secret_encrypted),
 *    so a ciphertext copied onto another flow does not decrypt.
 *  - `webhook_secret_fingerprint` (hmacFingerprint) is display / change
 *    detection only. It is keyed by the active encryption key generation, so
 *    it is never used for verification.
 *  - Created or rotated by an interactive user (automations.write + MFA at the
 *    route; partner-wide ⇒ canManagePartnerWidePolicies) and returned ONCE.
 *    Rotation cuts the old secret off immediately (no grace window): the
 *    ingress reads the live ciphertext per request and createFlowRun compares
 *    `webhook_secret_rotated_at` under the flow row lock.
 *  - The audit carries the flow id and fingerprint, never the secret.
 */
import { randomBytes } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { db } from '../../../db';
import { flows } from '../../../db/schema/flows';
import { isInteractiveUserSession, type AuthContext } from '../../../middleware/auth';
import { requestLikeFromSnapshot, writeAuditEvent } from '../../auditEvents';
import { columnAad, encryptedColumnRegistry, type EncryptedColumnSpec } from '../../encryptedColumnRegistry';
import { canManagePartnerWidePolicies } from '../../partnerWideAccess';
import { decryptSecret, encryptSecret, hmacFingerprint, isEncryptedSecret } from '../../secretCrypto';

export const FLOW_WEBHOOK_SECRET_SPEC: EncryptedColumnSpec = (() => {
  const spec = encryptedColumnRegistry.find((e) => e.table === 'flows' && e.column === 'webhook_secret_encrypted');
  if (!spec) throw new Error('flows.webhook_secret_encrypted is missing from encryptedColumnRegistry');
  return spec;
})();

/** `bwh_` + 32 random bytes, base64url (43 chars). */
export const FLOW_WEBHOOK_SECRET_PREFIX = 'bwh_';

export function encryptFlowWebhookSecret(flowId: string, plaintext: string): string {
  const sealed = encryptSecret(plaintext, { aad: columnAad(FLOW_WEBHOOK_SECRET_SPEC, flowId) });
  if (!sealed) throw new Error('Could not encrypt the flow webhook secret.');
  return sealed;
}

/**
 * The plaintext secret, or null when none is stored. Fails closed: a column
 * value that is not ciphertext (written around this module) is never accepted
 * as a secret. A ciphertext bound to another row throws.
 */
export function decryptFlowWebhookSecret(row: { id: string; webhookSecretEncrypted: string | null }): string | null {
  const stored = row.webhookSecretEncrypted;
  if (!stored || !isEncryptedSecret(stored)) return null;
  const plaintext = decryptSecret(stored, { aad: columnAad(FLOW_WEBHOOK_SECRET_SPEC, row.id) });
  return plaintext || null;
}

function draftTriggerType(definition: unknown): unknown {
  return (definition as { trigger?: { type?: unknown } } | null)?.trigger?.type;
}

export type RotateWebhookSecretResult =
  | { ok: true; secret: string; fingerprint: string; rotatedAt: string }
  | { ok: false; error: 'flow_not_found' | 'not_webhook' | 'interactive_session_required' | 'partner_wide_forbidden' };

/**
 * Create or rotate the flow's webhook secret, in the CALLER's DB context:
 * `FOR UPDATE` under RLS only matches a row the caller may write, and
 * serializes against a concurrent enable or rotation. The draft trigger must
 * be a webhook (auth mode and org resolver live in the document; changing them
 * needs a re-enable, rotating the secret does not).
 */
export async function createOrRotateWebhookSecret(auth: AuthContext, flowId: string): Promise<RotateWebhookSecretResult> {
  if (!isInteractiveUserSession(auth)) return { ok: false, error: 'interactive_session_required' };

  const [row] = await db
    .select({ id: flows.id, orgId: flows.orgId, partnerId: flows.partnerId, name: flows.name, definition: flows.definition })
    .from(flows)
    .where(eq(flows.id, flowId))
    .for('update')
    .limit(1);
  if (!row) return { ok: false, error: 'flow_not_found' };
  if (!row.orgId) {
    // An org token reads a partner-wide flow through the SELECT-only branch;
    // it must look absent here, like every other partner-wide write.
    if (auth.scope !== 'partner' && auth.scope !== 'system') return { ok: false, error: 'flow_not_found' };
    if (!canManagePartnerWidePolicies(auth)) return { ok: false, error: 'partner_wide_forbidden' };
  }
  if (draftTriggerType(row.definition) !== 'webhook') return { ok: false, error: 'not_webhook' };

  const secret = `${FLOW_WEBHOOK_SECRET_PREFIX}${randomBytes(32).toString('base64url')}`;
  const fingerprint = hmacFingerprint(secret);
  const rotatedAt = new Date();
  const [updated] = await db
    .update(flows)
    .set({
      webhookSecretEncrypted: encryptFlowWebhookSecret(row.id, secret),
      webhookSecretFingerprint: fingerprint,
      webhookSecretRotatedAt: rotatedAt,
      updatedAt: rotatedAt,
    })
    .where(eq(flows.id, row.id))
    .returning({ id: flows.id });
  if (!updated) return { ok: false, error: 'flow_not_found' };

  try {
    writeAuditEvent(requestLikeFromSnapshot({}), {
      orgId: row.orgId,
      ...(row.orgId ? {} : { partnerId: row.partnerId }),
      ...(auth.user ? { actorId: auth.user.id, actorEmail: auth.user.email } : { actorType: 'system' as const }),
      action: 'flow.webhook_secret.rotate',
      resourceType: 'flow',
      resourceId: row.id,
      resourceName: row.name,
      result: 'success',
      details: { flowId: row.id, fingerprint },
    });
  } catch (err) {
    console.error('[flows] webhook secret audit write failed', err);
  }
  return { ok: true, secret, fingerprint, rotatedAt: rotatedAt.toISOString() };
}
