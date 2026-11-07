import { Hono } from 'hono';
import { z } from 'zod';
import {
  scriptProposalOverridePromoteSchema, scriptProposalOverrideRunSchema,
  scriptProposalPromoteSchema, scriptProposalRequestChangesSchema,
} from '@breeze/shared';
import { zValidator } from '../../lib/validation';
import {
  authMiddleware, requireInteractiveSession, requireMfa, requirePermission, requireScope, withAuthDbAccessContext,
} from '../../middleware/auth';
import { aiScriptAuthoringEnabled } from '../../config/env';
import { db } from '../../db';
import { PERMISSIONS } from '../../services/permissions';
import { writeAuditEventAsync, writeAuditEventStrict } from '../../services/auditEvents';
import { captureException } from '../../services/sentry';
import { loadScriptProposalDetail } from '../../services/scriptProposals/detail';
import { denyIntentForProposal, transitionProposal } from '../../services/scriptProposals';
import { postProposalOutcomeToAuthor } from '../../services/scriptProposals/authorNotify';
import { promoteProposalToLibrary } from '../../services/scriptProposals/promote';
import { resolveStrictAcknowledgement } from '../../services/approvals/strictAcknowledgement';
import {
  reviewOverrideAuditEvent, reviewOverrideNote, runReviewFailedOverride,
} from '../../services/scriptProposals/reviewOverride';
import {
  loadLatestReview, loadProposalRequesterUserId, loadProposalRow,
} from '../../services/scriptProposals/queries';

/**
 * `/api/v1/ai/script-proposals` — the approver-facing read + decision surface for
 * AI-authored script proposals (spec §4.7-§4.10, roadmap §3.5).
 *
 * Mounted in index.ts BEFORE `api.route('/ai', aiRoutes)` so a future root-level
 * `/:id` on aiRoutes can never capture this prefix — the same ordering discipline
 * `/ai/agents/schedules` before `/ai/agents` already follows.
 */
export const aiScriptProposalRoutes = new Hono();

aiScriptProposalRoutes.use('*', authMiddleware);

/** The whole surface is dark when the wave flag is off. */
aiScriptProposalRoutes.use('*', async (c, next) => {
  if (!aiScriptAuthoringEnabled()) return c.json({ error: 'feature_disabled' }, 404);
  await next();
});

const idParam = z.object({ id: z.string().guid() });

aiScriptProposalRoutes.get(
  '/:id',
  requireScope('organization', 'partner', 'system'),
  zValidator('param', idParam),
  async (c) => {
    // No requirePermission here on purpose: the REQUESTER may read their own
    // proposal without approvals:decide, and a decide-holder may read it without
    // being the requester. The rule is one function, loadScriptProposalDetail.
    const result = await loadScriptProposalDetail(c.get('auth'), c.req.valid('param').id);
    if (!result.ok) {
      return result.reason === 'not_found'
        ? c.json({ error: 'not_found' }, 404)
        : c.json({ error: 'forbidden' }, 403);
    }
    return c.json(result.dto);
  },
);

aiScriptProposalRoutes.post(
  '/:id/request-changes',
  requireScope('organization', 'partner', 'system'),
  zValidator('param', idParam),
  zValidator('json', scriptProposalRequestChangesSchema),
  async (c) => {
    const auth = c.get('auth');
    const { id } = c.req.valid('param');
    const { note } = c.req.valid('json');

    const loaded = await loadScriptProposalDetail(auth, id);
    if (!loaded.ok) {
      return loaded.reason === 'not_found' ? c.json({ error: 'not_found' }, 404) : c.json({ error: 'forbidden' }, 403);
    }
    // Requesting changes IS a decision (spec §4.7) — the requester-only read
    // grant is not enough.
    if (!loaded.dto.viewer.canDecide) return c.json({ error: 'forbidden' }, 403);

    const row = await loadProposalRow(id);
    if (!row) return c.json({ error: 'not_found' }, 404);

    // The transition and the intent denial commit together: a proposal that
    // reads `changes_requested` while its intent is still pending would let the
    // release worker run the very content the approver just sent back. And the
    // other way round: if the intent was ALREADY decided by a concurrent
    // approver (its CAS on pending_approval loses), the proposal must not be
    // marked changes_requested either — the whole tx rolls back and the caller
    // gets a 409, exactly like a lost decide race.
    class IntentAlreadyDecided extends Error {}
    let moved = false;
    try {
      moved = await db.transaction(async (tx) => {
        const ok = await transitionProposal(tx, id, ['reviewed', 'approved'], 'changes_requested', {
          decidedBy: auth.user.id, decidedAt: new Date(), decisionNote: note,
        });
        if (!ok) return false;
        if (row.intentId) {
          const denied = await denyIntentForProposal(tx, row, 'changes_requested', auth.user.id);
          if (!denied) throw new IntentAlreadyDecided();
        }
        return true;
      });
    } catch (err) {
      if (err instanceof IntentAlreadyDecided) return c.json({ error: 'intent_already_decided' }, 409);
      throw err;
    }
    if (!moved) return c.json({ error: 'proposal_not_requestable' }, 409);

    // Post-commit side effect: the decision is already durable, so a failed
    // delivery must not report the decision as failed (routes/approvals.ts
    // guards its own post-commit mirrors for the same reason). Reported.
    try {
      const requestedByUserId = await loadProposalRequesterUserId(row);
      await postProposalOutcomeToAuthor(
        {
          id: row.id, orgId: row.orgId, authorKind: row.authorKind,
          sessionId: row.sessionId, agentRunId: row.agentRunId, requestedByUserId,
        },
        { kind: 'changes_requested', note, findings: loaded.dto.review?.findings ?? [] },
      );
    } catch (err) {
      console.error(`[scriptProposals] author notification failed for ${id}:`, err);
      captureException(err instanceof Error ? err : new Error(String(err)), c, { area: 'script_proposal_request_changes_notify' });
    }
    void writeAuditEventAsync(c, {
      action: 'script.proposal.decided', orgId: row.orgId, actorId: auth.user.id,
      resourceType: 'script_proposal', resourceId: id,
      details: { decision: 'changes_requested', intentId: row.intentId },
    });
    return c.json({ status: 'changes_requested' });
  },
);

aiScriptProposalRoutes.post(
  '/:id/promote',
  requireScope('organization', 'partner', 'system'),
  // Same pair POST /scripts requires: promotion IS a library create, so it
  // carries the library's own gate, not approvals:decide.
  requirePermission(PERMISSIONS.SCRIPTS_WRITE.resource, PERMISSIONS.SCRIPTS_WRITE.action),
  requireMfa(),
  zValidator('param', idParam),
  zValidator('json', scriptProposalPromoteSchema),
  async (c) => {
    const auth = c.get('auth');
    const { id } = c.req.valid('param');
    const input = c.req.valid('json');

    // The read gate first, so a caller with scripts:write in some OTHER org
    // cannot promote a proposal they may not read. `canPromote` is the
    // per-proposal-org scripts:write + MFA + verified check.
    const loaded = await loadScriptProposalDetail(auth, id);
    if (!loaded.ok) {
      return loaded.reason === 'not_found' ? c.json({ error: 'not_found' }, 404) : c.json({ error: 'forbidden' }, 403);
    }
    if (!loaded.dto.viewer.canPromote) return c.json({ error: 'forbidden' }, 403);

    const proposal = await loadProposalRow(id);
    if (!proposal) return c.json({ error: 'not_found' }, 404);
    const review = await loadLatestReview(id, proposal.orgId);

    const result = await promoteProposalToLibrary({ auth, proposal, review, input });
    if (!result.ok) return c.json({ error: result.error }, result.status);

    void writeAuditEventAsync(c, {
      action: 'script.proposal.promoted', orgId: proposal.orgId, actorId: auth.user.id,
      resourceType: 'script_proposal', resourceId: id,
      details: { scriptId: result.scriptId, versionId: result.versionId, ownerScope: input.ownerScope },
    });
    return c.json({ scriptId: result.scriptId, versionId: result.versionId }, 201);
  },
);

/**
 * #10954: a person signs a `review_failed` proposal and runs it on its targets.
 * The rule and everything it must not weaken: services/scriptProposals/reviewOverride.ts.
 *
 * Registered in selfManagedDbContextRoutes.ts: the rows must commit before any
 * command is sent (#7103), so no request transaction may be held here.
 */
aiScriptProposalRoutes.post(
  '/:id/override-run',
  // First, and unconditional: an MCP key or OAuth grant carries its owner's user
  // id and, with ENABLE_2FA off, passes the MFA gate. Denied before any lookup.
  requireInteractiveSession(),
  requireScope('organization', 'partner', 'system'),
  requirePermission(PERMISSIONS.SCRIPTS_EXECUTE.resource, PERMISSIONS.SCRIPTS_EXECUTE.action),
  requireMfa(),
  zValidator('param', idParam),
  zValidator('json', scriptProposalOverrideRunSchema),
  async (c) => {
    const auth = c.get('auth');
    const { id } = c.req.valid('param');
    const { acknowledgedPatterns } = c.req.valid('json');

    const loaded = await withAuthDbAccessContext(auth, () => loadScriptProposalDetail(auth, id));
    if (!loaded.ok) {
      return loaded.reason === 'not_found' ? c.json({ error: 'not_found' }, 404) : c.json({ error: 'forbidden' }, 403);
    }
    const proposal = await loadProposalRow(id);
    if (!proposal) return c.json({ error: 'not_found' }, 404);
    if (proposal.status !== 'review_failed') return c.json({ error: 'proposal_not_review_failed' }, 409);
    if (!loaded.dto.viewer.canOverrideRun) return c.json({ error: 'forbidden' }, 403);

    const result = await runReviewFailedOverride({
      auth,
      proposal,
      submittedAcknowledgements: acknowledgedPatterns,
      writeStrictAudit: (event) => writeAuditEventStrict(c, event),
      writeAudit: (event) => writeAuditEventAsync(c, event),
    });
    if (!result.ok) return c.json(result.body, result.status);
    return c.json({ status: result.status, results: result.results });
  },
);

/**
 * #10954: a person signs a `review_failed` proposal into the library, in place of
 * the verified run the normal /promote requires. The normal pair plus run
 * permission, per the product decision on the issue.
 */
aiScriptProposalRoutes.post(
  '/:id/override-promote',
  requireInteractiveSession(),
  requireScope('organization', 'partner', 'system'),
  requirePermission(PERMISSIONS.SCRIPTS_WRITE.resource, PERMISSIONS.SCRIPTS_WRITE.action),
  requirePermission(PERMISSIONS.SCRIPTS_EXECUTE.resource, PERMISSIONS.SCRIPTS_EXECUTE.action),
  requireMfa(),
  zValidator('param', idParam),
  zValidator('json', scriptProposalOverridePromoteSchema),
  async (c) => {
    const auth = c.get('auth');
    const { id } = c.req.valid('param');
    const { acknowledgedPatterns: submitted, confirmNoPassingReview: _signedOff, ...input } = c.req.valid('json');

    const loaded = await loadScriptProposalDetail(auth, id);
    if (!loaded.ok) {
      return loaded.reason === 'not_found' ? c.json({ error: 'not_found' }, 404) : c.json({ error: 'forbidden' }, 403);
    }
    const proposal = await loadProposalRow(id);
    if (!proposal) return c.json({ error: 'not_found' }, 404);
    if (proposal.status !== 'review_failed') return c.json({ error: 'proposal_not_review_failed' }, 409);
    if (!loaded.dto.viewer.canOverrideSave) return c.json({ error: 'forbidden' }, 403);

    const acknowledgement = await resolveStrictAcknowledgement({
      auth,
      proposal: { strictHits: proposal.strictHits ?? [], orgId: proposal.orgId },
      submitted,
    });
    if (!acknowledgement.ok) {
      const { ok: _ok, ...body } = acknowledgement;
      return c.json(body, 422);
    }

    const review = await loadLatestReview(id, proposal.orgId);
    const result = await promoteProposalToLibrary({
      auth,
      proposal,
      review,
      input,
      override: {
        acknowledgedPatterns: acknowledgement.acknowledged,
        decisionNote: reviewOverrideNote(proposal.decisionNote),
      },
    });
    if (!result.ok) return c.json({ error: result.error }, result.status);

    // The script is committed, and its version already names the signer. A
    // failed write goes to the retry queue instead of reporting a failed save.
    const event = reviewOverrideAuditEvent({
      auth,
      proposal,
      decision: 'save_to_library',
      acknowledgedPatterns: acknowledgement.acknowledged,
      details: { scriptId: result.scriptId, versionId: result.versionId, ownerScope: input.ownerScope },
    });
    await writeAuditEventStrict(c, event).catch((err: unknown) => {
      captureException(err instanceof Error ? err : new Error(String(err)), c, { area: 'script_proposal_review_override_audit' });
      return writeAuditEventAsync(c, event);
    });
    return c.json({ scriptId: result.scriptId, versionId: result.versionId });
  },
);
