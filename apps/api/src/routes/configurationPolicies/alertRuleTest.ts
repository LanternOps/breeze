import { Hono } from 'hono';
import { eq } from 'drizzle-orm';
import { zValidator } from '../../lib/validation';
import type { AuthContext } from '../../middleware/auth';
import { requirePermission, requireScope, siteAccessCheck } from '../../middleware/auth';
import { PERMISSIONS } from '../../services/permissions';
import { db } from '../../db';
import { devices } from '../../db/schema';
import { evaluateConditions } from '../../services/alertConditions';
import { getConfigPolicy } from '../../services/configurationPolicy';
import { resolveGoverningAlertRulePolicyForDevice } from '../../services/featureConfigResolver';
import { idParamSchema, testConfigPolicyAlertRuleSchema } from './schemas';

export const alertRuleTestRoutes = new Hono();

const requireConfigPolicyRead = requirePermission(
  PERMISSIONS.DEVICES_READ.resource,
  PERMISSIONS.DEVICES_READ.action
);

/**
 * POST /:id/alert-rules/test — evaluate a config-policy alert-rule draft
 * against one device and report the verdict the firing path would reach.
 *
 * The sibling endpoint `POST /alerts/rules/:id/test` tests a STANDALONE
 * `alert_rules` row. Config-policy alert rules are a different shape entirely —
 * `config_policy_alert_rules` rows with no stable id, targeted by the policy's
 * assignments rather than by a `targetType`/`targetId` on the rule — so that
 * endpoint is structurally unreachable from the policy editor (#3988).
 *
 * The verdict has the same two halves as the standalone one, and the same
 * honesty contract (#3752/#3923): a rule that would not fire must never render
 * as a pass, and a negative must say WHICH half caused it.
 *
 *  - `targetMatch`: would this policy's alert rules be the ones that run on this
 *    device? Resolved through the real assignment hierarchy.
 *  - `conditionResults` / `wouldTrigger`: the real evaluator's verdict, run
 *    against this device's actual state.
 *
 * SCOPE, deliberately narrower than "an alert appears": the config-policy
 * firing path is evaluateDeviceAlertsFromPolicy() (services/alertService.ts) —
 * NOT createAlert(), which belongs to the standalone-rule path. It skips the
 * whole device while a maintenance window with suppressAlerts is active, then
 * applies its own cooldown (isConfigPolicyRuleCooling), open-alert dedup (an
 * alerts.configPolicyId lookup) and flapping suppression before inserting a
 * row. None of that is simulated here; the UI renders the caveat next to a
 * positive verdict.
 */
alertRuleTestRoutes.post(
  '/:id/alert-rules/test',
  requireScope('organization', 'partner', 'system'),
  requireConfigPolicyRead,
  zValidator('param', idParamSchema),
  zValidator('json', testConfigPolicyAlertRuleSchema),
  async (c) => {
    const auth = c.get('auth') as AuthContext;
    const { id } = c.req.valid('param');
    const { deviceId, conditions } = c.req.valid('json');

    // Tenant gate #1: the policy. `getConfigPolicy` applies the org/partner
    // access condition, so an id from another tenant is a 404 here and never
    // reaches the resolver comparison below.
    const policy = await getConfigPolicy(id, auth);
    if (!policy) return c.json({ error: 'Configuration policy not found' }, 404);

    // Tenant gate #2: the device. The governance resolver deliberately runs in a
    // system RLS context (partner-wide policies are invisible under an
    // org-scoped one), so it cannot be the tenancy boundary — the device has to
    // be access-checked on both the org and the site axis right here. RLS does
    // not defend the site axis at all.
    const [device] = await db
      .select({
        id: devices.id,
        orgId: devices.orgId,
        siteId: devices.siteId,
        hostname: devices.hostname,
        osType: devices.osType,
      })
      .from(devices)
      .where(eq(devices.id, deviceId))
      .limit(1);

    if (
      !device
      || !auth.canAccessOrg(device.orgId)
      || !siteAccessCheck(auth.allowedSiteIds)(device.siteId)
    ) {
      return c.json({ error: 'Device not found or belongs to different organization' }, 404);
    }

    // Would THIS policy's alert rules be the ones that run on this device once
    // the draft is saved? The assignment hierarchy decides (level, then
    // priority, then age), with role and OS filters applied.
    const governing = await resolveGoverningAlertRulePolicyForDevice(device.id, id);
    const targetMatch = governing.outcome === 'governs';
    // Each negative gets its own remedy: assign the policy, or resolve the
    // precedence conflict. The reason never identifies the policy that won
    // instead — `governing.winningPolicyId` may name a policy in another org
    // under the partner, so it stays server-side.
    const targetReason =
      governing.outcome === 'governs'
        ? 'This configuration policy provides the alert rules for this device'
        : governing.outcome === 'outranked'
          ? 'Another configuration policy takes precedence for this device, so these alert rules would not apply to it'
          : 'This configuration policy is not assigned to this device';

    const evaluation = await evaluateConditions(conditions, device.id);

    const conditionResults: Array<{ condition: string; result: boolean; reason: string }> = [
      ...evaluation.conditionsMet.map((description) => ({
        condition: description,
        result: true,
        reason: description,
      })),
      ...evaluation.conditionsNotMet.map((description) => ({
        condition: description,
        result: false,
        reason: description,
      })),
    ];

    // OR groups mean `conditionResults.every(...)` is NOT the verdict — a
    // compound rule can trigger with some conditions unmet. `evaluation.triggered`
    // is the value the firing path uses.
    const wouldTrigger = targetMatch && evaluation.triggered;

    return c.json({
      policy: { id: policy.id, name: policy.name },
      device: {
        id: device.id,
        hostname: device.hostname,
        osType: device.osType,
      },
      targetMatch,
      targetReason,
      conditionResults,
      // Measured values behind the verdict (metric, actual value, threshold).
      // Returned for API consumers; the current UI does not render it.
      evaluationContext: evaluation.context,
      wouldTrigger,
      testedAt: new Date().toISOString(),
    });
  }
);
