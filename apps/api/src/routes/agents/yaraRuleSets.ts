/**
 * Agent-authenticated YARA bundle fetch (#6263 W03a, W02 §C2).
 *
 *   GET /api/v1/agents/:id/yara/rule-sets/:ruleSetId/:version
 *
 * `:id` is the AGENT id, like every agent route; agentAuthMiddleware binds it
 * to the bearer token and opens the agent's RLS context (scope organization =
 * the device's org, currentPartnerId = its partner). The set is read under
 * THAT context — RLS's partner-wide and built-in SELECT branches make exactly
 * the device's own org sets, its partner's partner-wide sets and the built-in
 * pack readable. Nothing here escalates to a system context.
 *
 * DECISION W03-d: on top of RLS the set must be attached to the device's
 * effective security policy (or be the built-in pack). RLS alone would let a
 * device read any partner-wide set of its partner by guessing the id.
 *
 * Responses (W02 §C2): 200 with the published bundle bytes, byte for byte,
 * `Content-Type: application/vnd.breeze.yara-bundle+json` and
 * `ETag: "<sha256>"`; 404 when the set is not visible, not attached, disabled
 * or never published; 409 when `version` is not the current published version
 * (DECISION W03-b — there is no version history). Each is a per-set failure on
 * the agent, never a failed scan.
 */
import { Hono } from 'hono';
import { z } from 'zod';
import { eq } from 'drizzle-orm';
import { YARA_BUILTIN_RULE_SET_ID, YARA_BUNDLE_CONTENT_TYPE } from '@breeze/shared';
import { zValidator } from '../../lib/validation';
import { db } from '../../db';
import { devices, yaraRuleSets } from '../../db/schema';
import { requireAgentRole } from '../../middleware/requireAgentRole';
import { resolveSecurityScanPolicyForDevice } from '../../services/featureConfigResolver';

export const agentYaraRuleSetRoutes = new Hono();
// Fetching detection rules is the main agent's job (the watchdog never scans).
agentYaraRuleSetRoutes.use('*', requireAgentRole);

const paramsSchema = z.object({
  id: z.string().min(1),
  ruleSetId: z.string().uuid(),
  version: z.coerce.number().int().min(1).max(2_147_483_647),
});

const NOT_FOUND = { error: 'Rule set not found' } as const;

agentYaraRuleSetRoutes.get(
  '/:id/yara/rule-sets/:ruleSetId/:version',
  zValidator('param', paramsSchema),
  async (c) => {
    const { id: agentId, ruleSetId, version } = c.req.valid('param');
    const setId = ruleSetId.toLowerCase();

    const [device] = await db
      .select({ id: devices.id })
      .from(devices)
      .where(eq(devices.agentId, agentId))
      .limit(1);
    if (!device) return c.json(NOT_FOUND, 404);

    if (setId !== YARA_BUILTIN_RULE_SET_ID) {
      const policy = await resolveSecurityScanPolicyForDevice(device.id);
      if (!policy || !policy.settings.ruleSetIds.includes(setId)) return c.json(NOT_FOUND, 404);
    }

    const [set] = await db
      .select({
        enabled: yaraRuleSets.enabled,
        publishedVersion: yaraRuleSets.publishedVersion,
        publishedBundle: yaraRuleSets.publishedBundle,
        publishedSha256: yaraRuleSets.publishedSha256,
      })
      .from(yaraRuleSets)
      .where(eq(yaraRuleSets.id, setId))
      .limit(1);
    if (!set || !set.enabled || set.publishedVersion < 1 || !set.publishedBundle || !set.publishedSha256) {
      return c.json(NOT_FOUND, 404);
    }
    if (set.publishedVersion !== version) {
      return c.json({ error: 'Rule set version is no longer current', currentVersion: set.publishedVersion }, 409);
    }

    const bytes = new Uint8Array(set.publishedBundle);
    return c.body(bytes, 200, {
      'Content-Type': YARA_BUNDLE_CONTENT_TYPE,
      ETag: `"${set.publishedSha256}"`,
      'Cache-Control': 'private, no-store',
    });
  },
);
