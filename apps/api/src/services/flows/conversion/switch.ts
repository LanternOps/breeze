/**
 * Tool Catalog W06 (#5221) Task B3 — switching a legacy Job ("automation") to
 * its converted flow (plan Decisions 2, 4, 5, 6, 14).
 *
 * ONE transaction, the caller's (a savepoint of the request transaction), as
 * the interactive user who clicks Switch. Any refusal unwinds the savepoint, so
 * nothing the attempt wrote survives (generated scripts, the draft rewrite, the
 * carried webhook secret, the publication, the ledger and the Job):
 *
 *  1. Locks, in the order every other writer of these rows uses — the Job row
 *     `FOR UPDATE`, then the flow row, then the ledger row — and re-reads all
 *     three. (Plan deviation: the plan locks the ledger first. The automation
 *     PUT locks the Job and then resets the ledger; a draft save locks the flow
 *     and then resets the ledger; admission locks only the Job. Ledger-first
 *     would deadlock against the first two; Job → flow → ledger cannot.)
 *  2. Checks on the locked state: still `shadow`; the Job's source digest is
 *     the ledger's; the draft is the version the user saw and the ledger's
 *     document digest; the shadow is ≥ CONVERSION_MIN_SHADOW_MS old even when
 *     acknowledged; a short or divergent shadow needs `acknowledgeDivergence`;
 *     a `site_ceiling_removed` finding needs `acceptScopeWidening`.
 *  3. The generated scripts (Decision 14) through the normal script-create
 *     path, as the user, and one draft save that rewrites their ids.
 *  4. A webhook Job's legacy secret is decrypted and carried onto the flow
 *     (`setFlowWebhookSecretFromLegacy`), so the sender's signatures keep
 *     verifying and the secret survives this publication.
 *  5. `enableFlow` runs every W04/W05/A6 check (rule 7, the delegation ceiling,
 *     the fleet lane) with the user as delegator. Its script reads go through
 *     THIS transaction (`scriptReadExecutor`): the generated scripts exist
 *     nowhere else yet. Pre-approvals are exactly the ones the request names.
 *  6. In enable's `onPublished`: the ledger becomes `switched` with
 *     `switch_at = switched_at + SWITCH_LEAD_MS`, and the Job is retired
 *     (`enabled = false`, `retired_reason = 'converted_to_flow'`,
 *     `converted_to_flow_id`) — the exact shape B2's legacy loader looks for.
 *     Enable stamps the schedule cursor at its own clock, before `switched_at`.
 *
 * The audit (`flow.conversion.switched`, ids and codes only, never the secret
 * or a script body) is written only after the request transaction commits.
 */
import { and, eq } from 'drizzle-orm';
import {
  flowDocumentV1Schema,
  SWITCH_LEAD_MS,
  type ConversionSwitchRequest,
  type FlowConversionDto,
  type FlowConversionFinding,
  type FlowDetailDto,
  type FlowValidationResult,
} from '@breeze/shared';
import { db, runAfterDbContextCommit, withDbTransaction } from '../../../db';
import { automations, flowAutomationConversions, flows, type FlowAutomationConversionRow } from '../../../db/schema';
import { isInteractiveUserSession, type AuthContext } from '../../../middleware/auth';
import { requestLikeFromSnapshot, writeAuditEvent } from '../../auditEvents';
import { canManagePartnerWidePolicies } from '../../partnerWideAccess';
import { getUserPermissions, type UserPermissions } from '../../permissions';
import { decryptForColumn } from '../../secretCrypto';
import { captureException } from '../../sentry';
import { hasSiteCeiling } from '../../siteCeilingAccess';
import { ownerForFlowRow } from '../repository';
import { saveDraftFlow } from '../service';
import { ceilingAllowsDelegation, enableFlow, permissionContextFor, type EnableFlowResult } from '../versions';
import { setFlowWebhookSecretFromLegacy } from '../webhook/secret';
import { loadConversionContext } from './context';
import { automationSourceDigest, convertAutomation } from './convertAutomation';
import {
  createGeneratedScripts,
  placeholdersNamedBy,
  plannedGeneratedScripts,
  rewriteScriptIds,
  type CreatedGeneratedScript,
  type GeneratedScriptsResult,
} from './generatedScripts';
import { flowDocumentDigest } from './ledger';
import { conversionReachCondition, readReachableAutomation, switchBlockedBy, toConversionDto } from './service';

type EnableRefusal = Exclude<EnableFlowResult, { ok: true }>;

export type SwitchConversionResult =
  | {
      ok: true;
      conversion: FlowConversionDto;
      flow: FlowDetailDto;
      publication: { id: string; publicationSeq: number; definitionVersion: number };
      webhookSecretInvalidated: boolean;
      generatedScripts: Array<{ stepId: string; scriptId: string; name: string }>;
    }
  | {
      ok: false;
      error: 'conversion_not_found' | 'interactive_session_required' | 'partner_wide_forbidden' | 'delegation_scope_restricted'
        | 'not_shadow' | 'source_changed' | 'version_conflict' | 'shadow_too_new' | 'shadow_too_short' | 'shadow_divergent'
        | 'scope_widening_not_accepted';
    }
  | { ok: false; error: 'unconvertible'; findings: FlowConversionFinding[] }
  | { ok: false; error: 'draft_rejected'; reason: string | null; validation?: FlowValidationResult }
  | Exclude<GeneratedScriptsResult, { ok: true }>
  | EnableRefusal;

type SwitchRefusal = Exclude<SwitchConversionResult, { ok: true }>;

/** Unwinds the switch's savepoint with a refusal. */
class SwitchRefused extends Error {
  constructor(readonly result: SwitchRefusal) {
    super(result.error);
  }
}
const refuse = (result: SwitchRefusal): never => {
  throw new SwitchRefused(result);
};

/** The legacy Job's webhook secret in plaintext, read as the legacy webhook route reads it; null when none. */
function legacyWebhookSecret(trigger: unknown): string | null {
  if (!trigger || typeof trigger !== 'object' || Array.isArray(trigger)) return null;
  const t = trigger as Record<string, unknown>;
  if (t.type !== 'webhook') return null;
  const stored = t.secret ?? t.webhookSecret;
  if (typeof stored !== 'string' || stored.length === 0) return null;
  return decryptForColumn('automations', 'trigger', stored) || null;
}

function auditSwitched(
  auth: AuthContext,
  conversionId: string,
  row: { id: string; name: string; orgId: string | null; partnerId: string | null },
  details: Record<string, unknown>,
): void {
  try {
    writeAuditEvent(requestLikeFromSnapshot({}), {
      orgId: row.orgId,
      ...(row.orgId ? {} : { partnerId: row.partnerId }),
      actorId: auth.user.id,
      actorEmail: auth.user.email,
      action: 'flow.conversion.switched',
      resourceType: 'flow_automation_conversion',
      resourceId: conversionId,
      resourceName: row.name,
      result: 'success',
      details,
    });
  } catch (err) {
    console.error('[flows] conversion switch audit write failed', err);
    captureException(
      err,
      undefined,
      { ...(row.orgId ? { org_id: row.orgId } : {}), flow_site: 'conversion.switch_audit' },
      { fingerprint: ['flow', 'conversion.switch_audit'] },
    );
  }
}

export async function switchConversion(
  auth: AuthContext,
  conversionId: string,
  req: ConversionSwitchRequest,
): Promise<SwitchConversionResult> {
  if (!isInteractiveUserSession(auth)) return { ok: false, error: 'interactive_session_required' };
  // A site-limited token never delegates org-wide authority (enable re-checks the membership).
  if (hasSiteCeiling(auth)) return { ok: false, error: 'delegation_scope_restricted' };

  // ── unlocked pre-reads: visibility, the owner, the converter's facts ──────
  const reach = conversionReachCondition(auth);
  const byId = eq(flowAutomationConversions.id, conversionId);
  const [pre] = await db.select().from(flowAutomationConversions).where(reach ? and(byId, reach) : byId).limit(1);
  if (!pre) return { ok: false, error: 'conversion_not_found' };
  const preJob = await readReachableAutomation(auth, pre.automationId, false);
  if (!preJob) return { ok: false, error: 'conversion_not_found' };
  if (!preJob.orgId && !canManagePartnerWidePolicies(auth)) return { ok: false, error: 'partner_wide_forbidden' };
  if (pre.state !== 'shadow') return { ok: false, error: 'not_shadow' };
  const [preFlow] = await db.select().from(flows).where(eq(flows.id, pre.flowId)).limit(1);
  if (!preFlow) return { ok: false, error: 'conversion_not_found' };
  const owner = await ownerForFlowRow(preFlow);
  if (!owner) return { ok: false, error: 'conversion_not_found' };
  // The user's live membership: refused before anything is written (enable
  // repeats it under the lock, as it does for every enable).
  const perms = await getUserPermissions(auth.user.id, permissionContextFor(owner));
  if (!ceilingAllowsDelegation(perms, owner) || (!owner.orgId && auth.partnerOrgAccess !== 'all')) {
    return { ok: false, error: 'delegation_scope_restricted' };
  }
  const delegator: UserPermissions = perms;
  // System reads with explicit owner predicates, before any lock (as createConversion).
  const ctx = await loadConversionContext(preJob);

  let created: CreatedGeneratedScript[] = [];
  let secretFingerprint: string | null = null;
  let acknowledged = false;
  let widened = false;
  try {
    const outcome = await withDbTransaction(async () => {
      // 1. Job → flow → ledger, each re-read under its lock.
      const job = await readReachableAutomation(auth, pre.automationId, true);
      if (!job) return refuse({ ok: false, error: 'conversion_not_found' });
      const [flow] = await db.select().from(flows).where(eq(flows.id, pre.flowId)).for('update').limit(1);
      if (!flow) return refuse({ ok: false, error: 'conversion_not_found' });
      const [ledger] = await db.select().from(flowAutomationConversions).where(byId).for('update').limit(1);
      if (!ledger) return refuse({ ok: false, error: 'conversion_not_found' });

      // 2. Checks.
      if (ledger.state !== 'shadow') return refuse({ ok: false, error: 'not_shadow' });
      const liveDigest = automationSourceDigest(job);
      if (job.orgId !== preJob.orgId || job.partnerId !== preJob.partnerId || liveDigest !== ledger.sourceDigest) {
        return refuse({ ok: false, error: 'source_changed' });
      }
      if (flow.definitionVersion !== req.expectedFlowVersion || flowDocumentDigest(flow.definition) !== ledger.documentDigest) {
        return refuse({ ok: false, error: 'version_conflict' });
      }
      const blocker = switchBlockedBy(ledger, liveDigest, new Date());
      if (blocker === 'unconvertible') return refuse({ ok: false, error: 'unconvertible', findings: ledger.findings ?? [] });
      // Never acknowledgeable: claims must cover the HMAC and replay windows (Decision 6).
      if (blocker === 'source_changed' || blocker === 'shadow_too_new') return refuse({ ok: false, error: blocker });
      if (blocker !== null && !req.acknowledgeDivergence) return refuse({ ok: false, error: blocker });
      acknowledged = blocker !== null;

      // The locked source re-converted with the pre-read facts: the generated
      // scripts and the scope-widening finding as they hold now.
      const converted = convertAutomation(job, ctx);
      if (converted.fidelity === 'unconvertible' || !converted.document) {
        return refuse({ ok: false, error: 'unconvertible', findings: converted.findings });
      }
      widened = [...converted.findings, ...(ledger.findings ?? [])].some((f) => f.code === 'site_ceiling_removed');
      if (widened && !req.acceptScopeWidening) return refuse({ ok: false, error: 'scope_widening_not_accepted' });

      const draft = flowDocumentV1Schema.safeParse(flow.definition);
      if (!draft.success) return refuse({ ok: false, error: 'draft_rejected', reason: 'draft_unparseable' });

      // 3. Generated scripts as the user, then ONE draft save with their ids.
      let expectedVersion = flow.definitionVersion;
      const plans = placeholdersNamedBy(draft.data, plannedGeneratedScripts(job.id, converted.generatedScripts));
      if (plans.length > 0) {
        const made = await createGeneratedScripts(auth, owner, delegator, plans);
        if (!made.ok) return refuse(made);
        created = made.created;
        const rewritten = rewriteScriptIds(draft.data, new Map(created.map((c) => [c.placeholderId, c.scriptId])));
        const saved = await saveDraftFlow(auth, {
          flowId: flow.id,
          document: rewritten,
          expectedVersion: flow.definitionVersion,
          scriptReadExecutor: db,
        });
        if (!saved.saved) {
          return refuse({
            ok: false,
            error: 'draft_rejected',
            reason: saved.error ?? null,
            ...(saved.validation ? { validation: saved.validation } : {}),
          });
        }
        expectedVersion = saved.flow.definitionVersion;
      }

      // 4. The legacy webhook secret, carried (never logged or returned).
      if (draft.data.trigger.type === 'webhook') {
        const plaintext = legacyWebhookSecret(job.trigger);
        if (plaintext) {
          const carried = await setFlowWebhookSecretFromLegacy(db, flow.id, plaintext);
          if (!carried.ok) return refuse({ ok: false, error: 'conversion_not_found' });
          secretFingerprint = carried.fingerprint;
        }
      }

      // 5–6. Enable, and in its transaction the ledger and the Job.
      let switched: FlowAutomationConversionRow | undefined;
      const enabled = await enableFlow(
        auth,
        flow.id,
        {
          expectedVersion,
          preApprovedStepIds: req.preApprovals.map((p) => p.stepId),
          fleetMaxTargets: Object.fromEntries(req.preApprovals.map((p) => [p.stepId, p.maxTargets])),
        },
        {
          switchingConversionId: ledger.id,
          scriptReadExecutor: db,
          onPublished: async (tx, pub) => {
            const switchedAt = new Date();
            [switched] = await tx
              .update(flowAutomationConversions)
              .set({
                state: 'switched',
                switchedAt,
                switchAt: new Date(switchedAt.getTime() + SWITCH_LEAD_MS),
                switchedBy: auth.user.id,
                divergenceAcknowledged: acknowledged,
                scopeWideningAccepted: widened,
                documentDigest: flowDocumentDigest(pub.flow.definition),
                // The shadow evidence the gate judged, not the draft rewrite's reset.
                shadowRuns: ledger.shadowRuns,
                shadowDivergences: ledger.shadowDivergences,
                shadowStartedAt: ledger.shadowStartedAt,
                shadowLastAt: ledger.shadowLastAt,
                shadowLastDivergence: ledger.shadowLastDivergence,
                updatedAt: switchedAt,
              })
              .where(and(byId, eq(flowAutomationConversions.state, 'shadow')))
              .returning();
            if (!switched) throw new Error('flow conversion moved under the switch lock');
            const [retired] = await tx
              .update(automations)
              .set({
                enabled: false,
                retiredAt: switchedAt,
                retiredReason: 'converted_to_flow',
                convertedToFlowId: flow.id,
                updatedAt: switchedAt,
              })
              .where(eq(automations.id, job.id))
              .returning({ id: automations.id });
            if (!retired) throw new Error('automation moved under the switch lock');
          },
        },
      );
      if (!enabled.ok) return refuse(enabled);
      // The carried secret was stamped for exactly this publication.
      if (enabled.webhookSecretInvalidated && secretFingerprint) throw new Error('the carried webhook secret did not survive the switch enable');
      if (!switched) throw new Error('enable returned without publishing');
      return {
        ok: true as const,
        conversion: toConversionDto(switched, liveDigest),
        flow: enabled.flow,
        publication: enabled.publication,
        webhookSecretInvalidated: enabled.webhookSecretInvalidated,
        generatedScripts: created.map((c) => ({ stepId: c.stepId, scriptId: c.scriptId, name: c.name })),
      };
    });

    // After the switch's state is final: written only if the request commits.
    runAfterDbContextCommit('flows.conversion.switch_audit', () => auditSwitched(auth, outcome.conversion.id, preJob, {
      automationId: preJob.id,
      flowId: outcome.conversion.flowId,
      publicationSeq: outcome.publication.publicationSeq,
      switchAt: outcome.conversion.switchAt,
      ownerScope: preJob.orgId ? 'organization' : 'partner',
      preApprovedStepIds: req.preApprovals.map((p) => p.stepId),
      generatedScriptIds: outcome.generatedScripts.map((g) => g.scriptId),
      divergenceAcknowledged: acknowledged,
      scopeWideningAccepted: widened,
      ...(secretFingerprint ? { webhookSecretCarried: true, webhookSecretFingerprint: secretFingerprint } : {}),
    }));
    return outcome;
  } catch (err) {
    if (err instanceof SwitchRefused) return err.result;
    throw err;
  }
}
