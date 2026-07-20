/**
 * Narrow, security-sensitive surface for action_intents. Deliberately NOT part
 * of the mobile /mobile/approvals router. Today it exposes exactly one thing:
 * the one-time reveal of a headless reset-password temporary credential.
 *
 * Security contract (spec 2026-07-19-reset-password-reveal-design.md):
 * - Shape-1 org RLS scopes every read and the burn write; fail closed.
 * - Requester-only; admin fallback (approvals:decide + org access) exists only
 *   for API-key-requested intents, which have no requesting user.
 * - At most one reveal ever succeeds (CAS burn); 7-day window from executedAt.
 * - The plaintext appears ONLY in the success response body — never in audit
 *   details, logs, metrics, or error messages.
 */
import { Hono } from 'hono';
import { z } from 'zod';
import { zValidator } from '@hono/zod-validator';
import { eq } from 'drizzle-orm';
import { db, runOutsideDbContext, withSystemDbAccessContext } from '../db';
import { actionIntents } from '../db/schema/actionIntents';
import { authMiddleware } from '../middleware/auth';
import { canAccessOrg, getUserPermissions, userCanDecideApprovals } from '../services/permissions';
import { writeRouteAudit } from '../services/auditEvents';
import { recordActionIntentEvent } from '../services/actionIntents/metrics';
import {
  REVEAL_WINDOW_DAYS,
  burnTemporaryPassword,
  hasSealedTemporaryPassword,
  unsealTemporaryPassword,
} from '../services/actionIntents/resultSecrets';

export const actionIntentsRoutes = new Hono();

actionIntentsRoutes.use('*', authMiddleware);

const REVEAL_WINDOW_MS = REVEAL_WINDOW_DAYS * 24 * 60 * 60 * 1000;
const revealParamSchema = z.object({ id: z.string().uuid() });

actionIntentsRoutes.post(
  '/:id/reveal-secret',
  zValidator('param', revealParamSchema),
  async (c) => {
    const auth = c.get('auth');
    const { id } = c.req.valid('param');

    // Shape-1 org RLS scopes this select — rows outside the caller's orgs are
    // simply invisible, which folds into the uniform 404 below.
    const [intent] = await db
      .select()
      .from(actionIntents)
      .where(eq(actionIntents.id, id))
      .limit(1);

    // Uniform 404: no oracle distinguishing "no such intent" from "wrong
    // status" from "nothing to reveal".
    const result = (intent?.result ?? {}) as Record<string, unknown>;
    if (!intent || intent.status !== 'completed' || !hasSealedTemporaryPassword(result)) {
      return c.json({ error: 'not_found' }, 404);
    }

    const revealPath = intent.requestedByUserId ? 'requester' : 'admin_fallback';
    const audit = (outcome: 'success' | 'denied') =>
      writeRouteAudit(c, {
        orgId: intent.orgId,
        action: 'action_intent.temp_password.reveal',
        resourceType: 'action_intent',
        resourceId: intent.id,
        result: outcome,
        details: { intentId: intent.id, actionName: intent.actionName, revealPath },
      });

    if (intent.requestedByUserId) {
      if (intent.requestedByUserId !== auth.user.id) {
        audit('denied');
        return c.json({ error: 'forbidden' }, 403);
      }
    } else {
      // API-key/MCP-requested intent: no requesting user exists. Mirror the
      // decide path's live permission re-resolution (approvals.ts:540-566).
      const perms = await runOutsideDbContext(() =>
        withSystemDbAccessContext(() =>
          getUserPermissions(auth.user.id, {
            partnerId: auth.partnerId ?? undefined,
            orgId: intent.orgId,
          }),
        ),
      );
      if (!perms || !canAccessOrg(perms, intent.orgId) || !userCanDecideApprovals(perms)) {
        audit('denied');
        return c.json({ error: 'forbidden' }, 403);
      }
    }

    const executedAtMs = intent.executedAt ? new Date(intent.executedAt).getTime() : 0;
    if (!executedAtMs || Date.now() - executedAtMs > REVEAL_WINDOW_MS) {
      // Lazily redact so the ciphertext doesn't outlive its window.
      await burnTemporaryPassword(intent.id, { expired: true });
      return c.json({ error: 'reveal_expired' }, 410);
    }

    // Decrypt BEFORE burning — never burn a secret we could not return.
    let temporaryPassword: string | null;
    try {
      temporaryPassword = unsealTemporaryPassword(result);
    } catch (err) {
      console.error('[action-intents] temp password decrypt failed:', {
        intentId: intent.id,
        error: err,
      });
      return c.json(
        { error: 'Failed to decrypt secret — check APP_ENCRYPTION_KEY configuration' },
        500,
      );
    }
    if (!temporaryPassword) {
      return c.json({ error: 'Secret material is empty' }, 500);
    }

    // CAS burn: exactly one concurrent caller wins; only the winner returns
    // the plaintext.
    const burned = await burnTemporaryPassword(intent.id, {
      revealedByUserId: auth.user.id,
    });
    if (!burned) {
      return c.json({ error: 'already_revealed' }, 410);
    }

    audit('success');
    recordActionIntentEvent({
      orgId: intent.orgId,
      intentId: intent.id,
      actionName: intent.actionName,
      argumentDigest: intent.argumentDigest,
      source: intent.source,
      outcome: 'revealed',
      actorId: auth.user.id,
      details: { revealPath },
    });

    return c.json({
      data: {
        temporaryPassword,
        userId: typeof result.userId === 'string' ? result.userId : null,
        forceChangeNextSignIn: result.forceChangeNextSignIn !== false,
        revealedAt: new Date().toISOString(),
      },
    });
  },
);
