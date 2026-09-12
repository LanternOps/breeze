import { Hono } from 'hono';
import { z } from 'zod';
import { scriptProposalPromoteSchema, scriptProposalRequestChangesSchema } from '@breeze/shared';
import { zValidator } from '../../lib/validation';
import { authMiddleware, requireMfa, requirePermission, requireScope } from '../../middleware/auth';
import { aiScriptAuthoringEnabled } from '../../config/env';
import { db } from '../../db';
import { PERMISSIONS } from '../../services/permissions';
import { writeAuditEventAsync } from '../../services/auditEvents';
import { loadScriptProposalDetail } from '../../services/scriptProposals/detail';
import { denyIntentForProposal, transitionProposal } from '../../services/scriptProposals';
import { postProposalOutcomeToAuthor } from '../../services/scriptProposals/authorNotify';
import { promoteProposalToLibrary } from '../../services/scriptProposals/promote';
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
    // release worker run the very content the approver just sent back.
    const moved = await db.transaction(async (tx) => {
      const ok = await transitionProposal(tx, id, ['reviewed', 'approved'], 'changes_requested', {
        decidedBy: auth.user.id, decidedAt: new Date(), decisionNote: note,
      });
      if (!ok) return false;
      await denyIntentForProposal(tx, row, 'changes_requested', auth.user.id);
      return true;
    });
    if (!moved) return c.json({ error: 'proposal_not_requestable' }, 409);

    const requestedByUserId = await loadProposalRequesterUserId(row);
    await postProposalOutcomeToAuthor(
      {
        id: row.id, orgId: row.orgId, authorKind: row.authorKind,
        sessionId: row.sessionId, agentRunId: row.agentRunId, requestedByUserId,
      },
      { kind: 'changes_requested', note, findings: loaded.dto.review?.findings ?? [] },
    );
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
