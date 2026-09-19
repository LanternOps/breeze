/**
 * AI patch agent W01 (#5747), Task 10 — "Run now" for a patch plan.
 *
 * A near-copy of `routes/fleetDesign.ts`'s `POST /runs`, and deliberately so:
 * both start a device-less, org-scoped autonomous run through the SAME
 * admission call, so they carry the same scope/permission/MFA gates, the same
 * 404-not-403 tenancy posture, and the same audit-every-outcome rule. The
 * differences from the device lane (`POST /ai/agents/:id/runs`) and why:
 *
 *  - There is no `:id` agent row to load: a patch plan always runs the ORG's
 *    effective `patch` agent, resolved the way every other kind-scoped
 *    admission path resolves it. `createAndEnqueueAgentRun` re-resolves and
 *    re-checks `enabled` / `mode !== 'off'` at admission time, so the read
 *    here is a fast 404, not the authority.
 *  - A declined admission answers HTTP 200 `{ success: false, skipped }`
 *    rather than 409: nothing was queued and the caller is told why, in the
 *    exact HTTP-200 failure shape the web's `runAction` detector reads
 *    (apps/web/src/lib/apiError.ts), so "Run now" can never toast "queued"
 *    for a run that never was — and can never fail silently either.
 *  - The run is `profile: 'patch'`, `deviceId: null`. `runService.ts`'s
 *    forward pin refuses any other combination for this profile; this route
 *    never constructs one, and `triggerPatchPlanRunSchema` is `.strict()` so
 *    a body carrying `deviceId` 400s instead of being quietly dropped.
 *
 * W01 is findings-only: a patch run mints ZERO action intents, so this route
 * queues a proposal, never an execution.
 */
import { randomUUID } from 'node:crypto';
import { Hono } from 'hono';
import { triggerPatchPlanRunSchema } from '@breeze/shared';
import { zValidator } from '../lib/validation';
import { authMiddleware, requireMfa, requirePermission, requireScope } from '../middleware/auth';
import { PERMISSIONS } from '../services/permissions';
import { resolveEffectiveAgent } from '../services/aiAgents/effectivePolicy';
import { createAndEnqueueAgentRun } from '../services/aiAgents/runService';
import { writeRouteAudit } from '../services/auditEvents';

export const patchPlanRoutes = new Hono();
// Mounted bare by index.ts (no upstream auth) — the router owns its own gate,
// exactly as `routes/fleetDesign.ts` does (#5866 / #5871).
patchPlanRoutes.use('*', authMiddleware);

const scopes = requireScope('organization', 'partner', 'system');
const requireAiWrite = requirePermission(PERMISSIONS.AI_AGENTS_WRITE.resource, PERMISSIONS.AI_AGENTS_WRITE.action);

// Triggering a patch run is as consequential as any other autonomous agent
// trigger, so it carries the same write-permission + MFA gates as
// `POST /ai/agents/:id/runs` and `POST /ai/fleet-design/runs`.
patchPlanRoutes.post(
  '/runs',
  scopes,
  requireAiWrite,
  requireMfa(),
  zValidator('json', triggerPatchPlanRunSchema),
  async (c) => {
    const auth = c.get('auth');
    const { orgId } = c.req.valid('json');

    // 404, not 403: a cross-tenant probe must read identically to a typo'd
    // org id — the same posture `routes/fleetDesign.ts` documents.
    if (!auth.canAccessOrg(orgId)) return c.json({ error: 'not_found' }, 404);

    const resolved = await resolveEffectiveAgent(auth, orgId, 'patch');
    if (!resolved) return c.json({ error: 'no_patch_agent' }, 404);

    const result = await createAndEnqueueAgentRun({
      orgId,
      kind: 'patch',
      triggerKind: 'manual',
      deviceId: null,
      profile: 'patch',
      // A human pressing "Run now" twice means twice — same posture as every
      // other manual-trigger route.
      dedupeKey: `patch-manual-${randomUUID()}`,
      triggerRef: { requestedByUserId: auth.user.id, agentId: resolved.agentId },
    });

    // Every outcome is audited: `createAndEnqueueAgentRun` writes no audit row
    // of its own, so this is the only record of which human asked for a patch
    // run — including when the answer was "not now".
    writeRouteAudit(c, {
      orgId,
      action: 'ai_patch_plan.run.manual_trigger',
      resourceType: 'ai_agent',
      resourceId: resolved.agentId,
      details: result.created ? { runId: result.run.id } : { skipped: result.skipped },
      result: result.created ? 'success' : 'failure',
    });

    if (!result.created) return c.json({ success: false, skipped: result.skipped }, 200);
    return c.json({ runId: result.run.id }, 202);
  },
);
