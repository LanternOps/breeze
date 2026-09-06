import { and, desc, eq, inArray } from 'drizzle-orm';
import * as dbModule from '../db';
import {
  alerts,
  alertRules,
  alertTemplates,
  automationPolicies,
  automationPolicyCompliance,
  organizations,
} from '../db/schema';
import { createAlert, resolveAlert, RESOLVABLE_ALERT_STATUSES } from './alertService';
import type { BreezeEvent } from './eventBus';

const { db } = dbModule;
const runWithSystemDbAccess = async <T>(fn: () => Promise<T>): Promise<T> => {
  const withSystem = dbModule.withSystemDbAccessContext;
  return typeof withSystem === 'function' ? withSystem(fn) : fn();
};

const POLICY_TEMPLATE_NAME = 'Policy Compliance Violation';
const POLICY_RULE_PREFIX = 'Policy Violation Rule';

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
        inArray(alerts.status, [...RESOLVABLE_ALERT_STATUSES])
      )
    );

  for (const alert of openAlerts) {
    await resolveAlert(alert.id, 'Auto-resolved: policy returned to compliant state');
  }
}

// Exported for unit testing (dual-axis partner-wide policy check, #2149) — not
// used outside this module otherwise; handlePolicyViolationEvent wires it to
// the durable subscriber registry.
export async function handlePolicyViolation(orgId: string, payload: PolicyEventPayload): Promise<void> {
  if (!payload.policyId || !payload.deviceId) {
    return;
  }

  const policyName = payload.policyName ?? 'Policy';
  const hostname = payload.hostname ?? payload.deviceId;

  // The event's orgId is the DEVICE's org. The policy is either owned by that
  // org, or partner-wide (org_id NULL, #2129) and owned by that org's partner.
  const [policy] = await db
    .select({ id: automationPolicies.id, orgId: automationPolicies.orgId, partnerId: automationPolicies.partnerId })
    .from(automationPolicies)
    .where(eq(automationPolicies.id, payload.policyId))
    .limit(1);

  if (!policy) {
    return;
  }

  if (policy.orgId !== null) {
    if (policy.orgId !== orgId) {
      // Should never happen — an org-owned policy only evaluates its own
      // org's devices. Leave a trace: silently dropping means an alert that
      // should have fired never does.
      console.warn(
        `[policyAlertBridge] dropping policy.violation for policy ${payload.policyId}: `
        + `policy org ${policy.orgId} does not match event org ${orgId}`
      );
      return;
    }
  } else {
    const [org] = await db
      .select({ partnerId: organizations.partnerId })
      .from(organizations)
      .where(eq(organizations.id, orgId))
      .limit(1);

    if (!org || !policy.partnerId || org.partnerId !== policy.partnerId) {
      // Race (policy deleted / org re-parented mid-evaluation) — log rather
      // than silently swallowing the violation.
      console.warn(
        `[policyAlertBridge] dropping policy.violation for partner-wide policy ${payload.policyId}: `
        + `event org ${orgId} is not under owning partner ${policy.partnerId ?? 'NULL'}`
      );
      return;
    }
  }

  // The event is a wake-up, not the truth: automation_policy_compliance holds
  // the current per-(policy, device) status, upserted BEFORE this event was
  // published (policyEvaluationService.ts). A delayed/retried policy.violation
  // that lands after a newer policy.compliant must not create a stale alert —
  // FIFO can't fix this, since a failed violation delivery can retry after a
  // later compliant.
  const [compliance] = await db
    .select({ status: automationPolicyCompliance.status })
    .from(automationPolicyCompliance)
    .where(and(
      eq(automationPolicyCompliance.policyId, payload.policyId),
      eq(automationPolicyCompliance.deviceId, payload.deviceId),
    ))
    // Duplicate (policy, device) rows are no longer reachable: #4122 deduped
    // the table and added the partial unique index `apc_policy_device_uq`, and
    // the evaluation writes are now ON CONFLICT upserts. The ordering stays as
    // defence-in-depth — it costs nothing on a single row, and it keeps this
    // read deterministic rather than depending on the index for correctness.
    .orderBy(desc(automationPolicyCompliance.updatedAt))
    .limit(1);
  if (compliance && compliance.status !== 'non_compliant') {
    // Stale or reordered violation event: the persisted evaluation state has
    // moved on. The compliant-side handler resolves alerts; creating one here
    // would strand an active alert with no future event to clear it.
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

/**
 * Handle a `policy.violation` event.
 *
 * Registered (with handlePolicyCompliantEvent) under subscriber id
 * `policy-alert-bridge` (services/eventSubscribers.ts). MUST throw on failure
 * — queue-mode dispatch (#4085) retries on a thrown rejection; local
 * delivery's wrapper (eventBus.ts's invokeLocalHandlers) provides the
 * swallow-and-log semantics the old subscriber's try/catch used to provide
 * itself.
 */
export async function handlePolicyViolationEvent(event: BreezeEvent): Promise<void> {
  await runWithSystemDbAccess(async () => {
    await handlePolicyViolation(event.orgId, (event.payload ?? {}) as PolicyEventPayload);
  });
}

/** Handle a `policy.compliant` event. See handlePolicyViolationEvent. */
export async function handlePolicyCompliantEvent(event: BreezeEvent): Promise<void> {
  await runWithSystemDbAccess(async () => {
    await handlePolicyCompliant(event.orgId, (event.payload ?? {}) as PolicyEventPayload);
  });
}
