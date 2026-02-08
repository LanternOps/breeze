import { and, eq, inArray } from 'drizzle-orm';
import { db } from '../db';
import { alerts, alertRules, alertTemplates, automationPolicies } from '../db/schema';
import { createAlert, resolveAlert } from './alertService';
import { getEventBus } from './eventBus';

const POLICY_TEMPLATE_NAME = 'Policy Compliance Violation';
const POLICY_RULE_PREFIX = 'Policy Violation Rule';

let subscribed = false;

type PolicyEventPayload = {
  policyId?: string;
  policyName?: string;
  deviceId?: string;
  hostname?: string;
  enforcement?: string;
  remediationRunId?: string | null;
};

function mapSeverityFromEnforcement(enforcement: string | undefined): 'critical' | 'high' | 'medium' | 'low' | 'info' {
  if (enforcement === 'enforce') return 'high';
  if (enforcement === 'warn') return 'medium';
  return 'low';
}

function getPolicyRuleName(policyId: string): string {
  return `${POLICY_RULE_PREFIX}:${policyId}`;
}

async function ensureTemplate(orgId: string): Promise<string> {
  const [existing] = await db
    .select({ id: alertTemplates.id })
    .from(alertTemplates)
    .where(
      and(
        eq(alertTemplates.orgId, orgId),
        eq(alertTemplates.name, POLICY_TEMPLATE_NAME)
      )
    )
    .limit(1);

  if (existing) {
    return existing.id;
  }

  const [created] = await db
    .insert(alertTemplates)
    .values({
      orgId,
      name: POLICY_TEMPLATE_NAME,
      description: 'Auto-generated template for policy compliance violations',
      conditions: { source: 'policy-evaluation' },
      severity: 'medium',
      titleTemplate: 'Policy violation on {{hostname}}',
      messageTemplate: '{{policyName}} reported a compliance violation on {{hostname}}',
      autoResolve: true,
      isBuiltIn: true,
      cooldownMinutes: 30,
    })
    .returning({ id: alertTemplates.id });

  if (!created) {
    throw new Error('Failed to create policy alert template');
  }

  return created.id;
}

async function ensureRule(
  orgId: string,
  policyId: string,
  policyName: string,
  enforcement: string | undefined
): Promise<string> {
  const ruleName = getPolicyRuleName(policyId);

  const [existing] = await db
    .select({ id: alertRules.id })
    .from(alertRules)
    .where(
      and(
        eq(alertRules.orgId, orgId),
        eq(alertRules.name, ruleName)
      )
    )
    .limit(1);

  if (existing) {
    return existing.id;
  }

  const templateId = await ensureTemplate(orgId);

  const [created] = await db
    .insert(alertRules)
    .values({
      orgId,
      templateId,
      name: ruleName,
      targetType: 'org',
      targetId: orgId,
      isActive: true,
      overrideSettings: {
        severity: mapSeverityFromEnforcement(enforcement),
        cooldownMinutes: 30,
        policyId,
        policyName,
        source: 'policy-evaluation',
      },
    })
    .returning({ id: alertRules.id });

  if (!created) {
    throw new Error('Failed to create policy alert rule');
  }

  return created.id;
}

async function resolvePolicyAlertsForDevice(ruleId: string, deviceId: string): Promise<void> {
  const openAlerts = await db
    .select({ id: alerts.id })
    .from(alerts)
    .where(
      and(
        eq(alerts.ruleId, ruleId),
        eq(alerts.deviceId, deviceId),
        inArray(alerts.status, ['active', 'acknowledged', 'suppressed'])
      )
    );

  for (const alert of openAlerts) {
    await resolveAlert(alert.id, 'Auto-resolved: policy returned to compliant state');
  }
}

async function handlePolicyViolation(orgId: string, payload: PolicyEventPayload): Promise<void> {
  if (!payload.policyId || !payload.deviceId) {
    return;
  }

  const policyName = payload.policyName ?? 'Policy';
  const hostname = payload.hostname ?? payload.deviceId;

  const [policy] = await db
    .select({ id: automationPolicies.id })
    .from(automationPolicies)
    .where(
      and(
        eq(automationPolicies.id, payload.policyId),
        eq(automationPolicies.orgId, orgId)
      )
    )
    .limit(1);

  if (!policy) {
    return;
  }

  const ruleId = await ensureRule(orgId, payload.policyId, policyName, payload.enforcement);

  await createAlert({
    ruleId,
    deviceId: payload.deviceId,
    orgId,
    severity: mapSeverityFromEnforcement(payload.enforcement),
    title: `Policy violation: ${policyName} on ${hostname}`,
    message: `${policyName} reported a non-compliant state on ${hostname}.`,
    context: {
      source: 'policy-evaluation',
      policyId: payload.policyId,
      policyName,
      remediationRunId: payload.remediationRunId ?? null,
    },
  });
}

async function handlePolicyCompliant(orgId: string, payload: PolicyEventPayload): Promise<void> {
  if (!payload.policyId || !payload.deviceId) {
    return;
  }

  const [rule] = await db
    .select({ id: alertRules.id })
    .from(alertRules)
    .where(
      and(
        eq(alertRules.orgId, orgId),
        eq(alertRules.name, getPolicyRuleName(payload.policyId))
      )
    )
    .limit(1);

  if (!rule) {
    return;
  }

  await resolvePolicyAlertsForDevice(rule.id, payload.deviceId);
}

export function subscribeToPolicyEvents(): void {
  if (subscribed) {
    return;
  }

  const eventBus = getEventBus();

  eventBus.subscribe('policy.violation', async (event) => {
    try {
      await handlePolicyViolation(event.orgId, (event.payload ?? {}) as PolicyEventPayload);
    } catch (error) {
      console.error('[PolicyAlertBridge] Failed to handle policy violation:', error);
    }
  });

  eventBus.subscribe('policy.compliant', async (event) => {
    try {
      await handlePolicyCompliant(event.orgId, (event.payload ?? {}) as PolicyEventPayload);
    } catch (error) {
      console.error('[PolicyAlertBridge] Failed to handle policy compliant event:', error);
    }
  });

  subscribed = true;
  console.log('[PolicyAlertBridge] Subscribed to policy events');
}

export async function initializePolicyAlertBridge(): Promise<void> {
  subscribeToPolicyEvents();
}
