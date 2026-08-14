import { Hono } from 'hono';
import { and, eq, gt, inArray, isNull, sql } from 'drizzle-orm';
import { z } from 'zod';
import { zValidator } from '../../lib/validation';
import { db } from '../../db';
import { agentUninstallTokens } from '../../db/schema';
import { hashEnrollmentKeyCandidates } from '../../services/enrollmentKeySecurity';
import { getTrustedClientIp } from '../../services/clientIp';
import type { AgentAuthContext } from '../../middleware/agentAuth';

export const uninstallAuthorizeRoutes = new Hono();

const bodySchema = z.object({ token: z.string().min(8).max(256) }).strict();

/**
 * POST /agents/:id/uninstall-authorize — the gate on LOCAL uninstall.
 *
 * A technician mints a token with POST /devices/:id/uninstall-token
 * (DEVICES_DELETE + MFA) and hands it to `nu-agent uninstall --token`. The
 * agent calls this route before it tears anything down and REFUSES on any
 * non-allow answer, including a network failure — fail closed. Without a
 * valid token nothing local can remove the agent, which is the whole point:
 * GET /agents/uninstall.sh used to remove everything with no authentication
 * at all, so any local admin could strip a managed client machine.
 *
 * Device-token authenticated via the parent router's `/:id/*` →
 * agentAuthMiddleware wrapping (index.ts). Like every other route in this
 * package the authoritative device id is the TOKEN-RESOLVED
 * `agent.deviceId`, never the `:id` path segment, so an agent cannot burn or
 * act on another device's token even if it knows the id.
 *
 * The burn is a single atomic UPDATE — `SET consumed_at = now() WHERE
 * token = $hash AND device_id = $self AND consumed_at IS NULL AND expires_at >
 * now() RETURNING` — the same TOCTOU-safe shape as installer.ts's
 * redeemBootstrapToken consume guard. Two concurrent presentations of the same
 * token serialize in Postgres and exactly one sees a row that still satisfies
 * the predicate; the loser gets an empty RETURNING and is denied. Never
 * read-then-write.
 *
 * Every denial reason (unknown / wrong device / expired / already consumed)
 * returns the same 403 body so the response cannot be used to probe which
 * condition was hit.
 */
uninstallAuthorizeRoutes.post(
  '/:id/uninstall-authorize',
  zValidator('json', bodySchema),
  async (c) => {
    const agent = c.get('agent') as AgentAuthContext | undefined;
    if (!agent?.deviceId) {
      return c.json({ error: 'Agent context not found' }, 401);
    }

    const { token } = c.req.valid('json');
    const ip = getTrustedClientIp(c, c.env?.incoming?.socket?.remoteAddress ?? 'unknown');

    // Legacy peppers are consulted on the READ path only (same rule as
    // enrollment keys) so an operator rotating ENROLLMENT_KEY_PEPPER does not
    // strand tokens minted minutes earlier.
    const candidates = hashEnrollmentKeyCandidates(token);

    const [burned] = await db
      .update(agentUninstallTokens)
      .set({
        consumedAt: new Date(),
        consumedFromIp: ip === 'unknown' ? null : ip,
        updatedAt: new Date(),
      })
      .where(
        and(
          inArray(agentUninstallTokens.token, candidates),
          eq(agentUninstallTokens.deviceId, agent.deviceId),
          isNull(agentUninstallTokens.consumedAt),
          gt(agentUninstallTokens.expiresAt, sql`NOW()`),
        ),
      )
      .returning({ id: agentUninstallTokens.id });

    if (!burned) {
      console.error('[agents] uninstall authorization denied', {
        deviceId: agent.deviceId,
        ip,
      });
      return c.json({ allowed: false, error: 'uninstall not authorized' }, 403);
    }

    console.log('[agents] uninstall authorized', {
      deviceId: agent.deviceId,
      tokenId: burned.id,
      ip,
    });

    return c.json({ allowed: true, deviceId: agent.deviceId, tokenId: burned.id });
  },
);
