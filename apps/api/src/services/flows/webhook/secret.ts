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
import { and, eq } from 'drizzle-orm';
import { flowDocumentV1Schema } from '@breeze/shared';
import { db, runOutsideDbContext, withSystemDbAccessContext } from '../../../db';
import { flows } from '../../../db/schema/flows';
import { flowVersions } from '../../../db/schema/flowRuns';
import { isInteractiveUserSession, type AuthContext } from '../../../middleware/auth';
import { requestLikeFromSnapshot, writeAuditEvent } from '../../auditEvents';
import { columnAad, encryptedColumnRegistry, type EncryptedColumnSpec } from '../../encryptedColumnRegistry';
import { FlowStepPinError, flowStepPinSchema, stepPinsFor } from '../../flowValidator';
import { canManagePartnerWidePolicies } from '../../partnerWideAccess';
import { getUserPermissions } from '../../permissions';
import { decryptSecret, encryptSecret, hmacFingerprint, isEncryptedSecret } from '../../secretCrypto';
import { hasSiteCeiling } from '../../siteCeilingAccess';
import { ownerForFlowRow } from '../repository';
import { ceilingAllowsDelegation, missingPermissionsFor, permissionContextFor } from '../versions';

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
  | { ok: false; error: 'permission_missing'; missing: Array<{ stepId: string; permission: string }> }
  | {
      ok: false;
      error: 'flow_not_found' | 'not_webhook' | 'interactive_session_required' | 'partner_wide_forbidden' | 'delegation_scope_restricted'
        | 'draft_unresolvable';
    };

/** The live publication's document and pins (system read, explicit predicates), or null when unreadable. */
async function livePublication(flowId: string, seq: number) {
  const [pub] = await runOutsideDbContext(() => withSystemDbAccessContext(
    () => db
      .select({ definition: flowVersions.definition, stepPins: flowVersions.stepPins, definitionVersion: flowVersions.definitionVersion })
      .from(flowVersions)
      .where(and(eq(flowVersions.flowId, flowId), eq(flowVersions.publicationSeq, seq)))
      .limit(1),
    'flows.webhookSecret.livePublication',
  ));
  if (!pub) return null;
  const doc = flowDocumentV1Schema.safeParse(pub.definition);
  const pins = flowStepPinSchema.array().safeParse(pub.stepPins);
  return doc.success && pins.success ? { doc: doc.data, pins: pins.data, definitionVersion: pub.definitionVersion } : null;
}

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
    .select({
      id: flows.id, orgId: flows.orgId, partnerId: flows.partnerId, name: flows.name, definition: flows.definition,
      definitionVersion: flows.definitionVersion, enabledPublicationSeq: flows.enabledPublicationSeq,
    })
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

  // Gate parity with enable and manual start: whoever holds the secret starts
  // runs under the delegator's org-wide (or all-orgs) authority, so the person
  // who mints it must clear the same delegation ceiling — no site ceiling on
  // the membership or the token, all-orgs access for a partner-wide flow —
  // and, when a publication is live, hold every permission its steps need
  // (rule 7, the manual-run triggerer check).
  const owner = await ownerForFlowRow(row);
  if (!owner || !auth.user) return { ok: false, error: 'flow_not_found' };
  const perms = await getUserPermissions(auth.user.id, permissionContextFor(owner));
  if (!ceilingAllowsDelegation(perms, owner) || hasSiteCeiling(auth) || (!owner.orgId && auth.partnerOrgAccess !== 'all')) {
    return { ok: false, error: 'delegation_scope_restricted' };
  }
  let live: Awaited<ReturnType<typeof livePublication>> = null;
  if (row.enabledPublicationSeq !== null) {
    live = await livePublication(row.id, row.enabledPublicationSeq);
    if (!live) return { ok: false, error: 'flow_not_found' };
    const missing = missingPermissionsFor(live.doc, live.pins, perms);
    if (missing.length > 0) return { ok: false, error: 'permission_missing', missing };
  }
  // The minter must also hold what the draft's steps need now (PR review). An
  // enable keeps this secret only if it was minted against the content being
  // published (#10270 option b, versions.ts webhookSecretSurvivesEnable), so
  // every mint must be checked against the draft as it stands. Saved drafts
  // always resolve. If the steps no longer resolve (catalog drift since the
  // save), the check holds only when a live publication of the same content
  // (same definition_version) was checked above. Otherwise refuse, so that no
  // mint skips the check.
  let draftChecked = live !== null && live.definitionVersion === row.definitionVersion;
  const draft = flowDocumentV1Schema.safeParse(row.definition);
  if (draft.success) {
    try {
      const pins = await stepPinsFor(draft.data, { owner });
      const missing = missingPermissionsFor(draft.data, pins, perms);
      if (missing.length > 0) return { ok: false, error: 'permission_missing', missing };
      draftChecked = true;
    } catch (err) {
      if (!(err instanceof FlowStepPinError)) throw err;
    }
  }
  if (!draftChecked) return { ok: false, error: 'draft_unresolvable' };

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
