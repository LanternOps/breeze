/**
 * Platform-admin AI kill-switch API (wave 6 PR 2, #3828 — Task 4).
 *
 *   GET  /api/v1/admin/ai-kill-state          state + epoch + provenance
 *   POST /api/v1/admin/ai-kill-state          flip it (+ MFA, reason required)
 *
 * This is the first AUTHORIZED write surface for `ai_kill_state` — the row
 * shipped in wave 5A with `bumpAiKillState` deliberately uncalled, leaving a
 * direct SQL UPDATE as the only operational path. WHY PLATFORM-ADMIN ONLY:
 * the row is global (id='global', no tenant axis) — flipping it stops
 * unattended AI activity for EVERY partner at once, which is a platform
 * operation by construction, same posture as tenant-erasure.
 *
 * Propagation bound: each API process re-reads the row on its hot paths with
 * a 5s TTL cache (`services/aiKillState.ts`), so a flip takes effect
 * everywhere within ~5 seconds — the GET here bypasses that cache and shows
 * the database truth. Operational runbook (including the SQL fallback for
 * when no platform admin exists — true of production today):
 * `docs/deploy/ai-kill-switch.md`.
 */
import { Hono } from 'hono';
import { z } from 'zod';
import { zValidator } from '../../lib/validation';
import { requireMfa } from '../../middleware/auth';
import { bumpAiKillState, readAiKillStateRow } from '../../services/aiKillState';
import { createAuditLogAsync } from '../../services/auditService';
import { getTrustedClientIpOrUndefined } from '../../services/clientIp';

export const aiKillStateAdminRoutes = new Hono();

// Strict: `epoch`/`updatedBy` can never be smuggled in — the epoch only ever
// increments inside `bumpAiKillState`, and identity comes from the session.
const flipSchema = z.strictObject({
  killed: z.boolean(),
  reason: z.string().trim().min(3).max(500),
});

aiKillStateAdminRoutes.get('/', async (c) => {
  const row = await readAiKillStateRow();
  return c.json({ data: row });
});

aiKillStateAdminRoutes.post(
  '/',
  requireMfa(),
  zValidator('json', flipSchema),
  async (c) => {
    const auth = c.get('auth');
    const { killed, reason } = c.req.valid('json');

    const snapshot = await bumpAiKillState(killed, reason, auth.user.id);

    // Non-throwing (retry-queued) audit: once the bump commits, the response
    // MUST reflect the real switch state. A throwing audit under exactly the
    // DB stress that prompts an emergency kill would 500 a flip that already
    // took effect — inviting a retry (double epoch bump reads as a second
    // revocation downstream) or an unnecessary jump to the SQL fallback.
    await createAuditLogAsync({
      orgId: null,
      actorType: 'user',
      actorId: auth.user.id,
      actorEmail: auth.user.email,
      action: 'ai_kill_state.updated',
      resourceType: 'ai_kill_state',
      resourceId: 'global',
      details: { killed: snapshot.killed, epoch: snapshot.epoch, reason },
      ipAddress: getTrustedClientIpOrUndefined(c),
      userAgent: c.req.header('user-agent'),
      result: 'success',
    });

    return c.json({ data: snapshot });
  },
);
